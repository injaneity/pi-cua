from __future__ import annotations

import asyncio
import io
import json
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import backend


class LocalStateTests(unittest.TestCase):
    def test_only_managed_fleet_claims_are_listed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            (state_dir / "linux-1.json").write_text(
                json.dumps(
                    {
                        "name": "linux-1",
                        "runtime_type": "fleet",
                        "pool_name": "cua-pi-linux",
                    }
                )
            )
            (state_dir / "unrelated.json").write_text(
                json.dumps(
                    {
                        "name": "unrelated",
                        "runtime_type": "fleet",
                        "pool_name": "another-pool",
                    }
                )
            )

            controller_dir = state_dir / "controller"
            with (
                patch.object(backend, "STATE_DIR", state_dir),
                patch.object(backend, "CONTROLLER_DIR", controller_dir),
                patch.object(
                    backend, "CONTROLLER_DB", controller_dir / "state.sqlite3"
                ),
            ):
                self.assertEqual(
                    backend.local_states(),
                    [
                        {
                            "name": "linux-1",
                            "os": "linux",
                            "pool": "cua-pi-linux",
                        }
                    ],
                )


class TailscaleTests(unittest.TestCase):
    def test_enrollment_key_is_one_use_and_scoped_to_exact_tailnet(self) -> None:
        with patch.object(
            backend, "tailscale_api", return_value={"key": "tskey-auth-test"}
        ) as request:
            key = backend.tailscale_auth_key("user@example.com")

        self.assertEqual(key, "tskey-auth-test")
        _, path = request.call_args.args
        create = request.call_args.kwargs["payload"]["capabilities"]["devices"][
            "create"
        ]
        self.assertEqual(path, "/tailnet/user%40example.com/keys")
        self.assertTrue(create["ephemeral"])
        self.assertFalse(create["reusable"])
        self.assertEqual(create["tags"], ["tag:cua-sandbox"])

    def test_reachability_accepts_a_derp_route(self) -> None:
        process = subprocess.CompletedProcess(
            ["tailscale"], 0, stdout="pong via DERP(sea)\n", stderr=""
        )
        with patch.object(backend.subprocess, "run", return_value=process) as run:
            backend.verify_controller_reachability("100.64.0.1")

        self.assertIn("--until-direct=false", run.call_args.args[0])

    def test_offline_controller_fails_before_provisioning(self) -> None:
        status = {
            "BackendState": "Running",
            "CurrentTailnet": {"Name": "user@example.com"},
            "Self": {"Online": False},
        }
        process = subprocess.CompletedProcess(
            ["tailscale"], 0, stdout=json.dumps(status), stderr=""
        )
        with (
            patch.object(backend.subprocess, "run", return_value=process),
            self.assertRaisesRegex(RuntimeError, "local Tailscale is not online"),
        ):
            backend.local_tailscale_identity()


class WorkspaceBundleTests(unittest.TestCase):
    def test_remote_config_includes_generic_tool_host(self) -> None:
        files = backend.remote_pi_files()
        self.assertIn(".pi/agent/cua-tool-host.mjs", files)
        self.assertIn(
            b'request.type === "execute"', files[".pi/agent/cua-tool-host.mjs"]
        )
        self.assertNotIn(".pi/agent/auth.json", files)
        self.assertNotIn(".pi/agent/models.json", files)
        self.assertNotIn(".pi/agent/settings.json", files)

    def test_guest_settings_contain_only_requested_tool_packages(self) -> None:
        with patch.object(backend, "copy_guest_file") as copy:
            backend.sync_guest_packages(
                "linux-1",
                "linux",
                ("git:github.com/example/tool-package",),
            )
        content = copy.call_args.args[2]
        self.assertEqual(
            json.loads(content),
            {"packages": ["git:github.com/example/tool-package"]},
        )

    def test_bundle_reproduces_modified_untracked_and_deleted_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", root], check=True)
            subprocess.run(
                ["git", "-C", root, "config", "user.email", "test@example.com"],
                check=True,
            )
            subprocess.run(
                ["git", "-C", root, "config", "user.name", "Test"], check=True
            )
            subprocess.run(
                [
                    "git",
                    "-C",
                    root,
                    "remote",
                    "add",
                    "origin",
                    "https://example.com/repository.git",
                ],
                check=True,
            )
            (root / "modified.txt").write_text("original\n")
            (root / "deleted.txt").write_text("delete me\n")
            subprocess.run(["git", "-C", root, "add", "."], check=True)
            subprocess.run(["git", "-C", root, "commit", "-qm", "initial"], check=True)
            (root / "modified.txt").write_text("modified\n")
            (root / "untracked.txt").write_text("untracked\n")
            (root / "deleted.txt").unlink()

            bundle = backend.build_workspace_bundle(root)
            with tarfile.open(
                fileobj=io.BytesIO(bundle.archive), mode="r:gz"
            ) as archive:
                modified = archive.extractfile("modified.txt")
                untracked = archive.extractfile("untracked.txt")
                self.assertEqual(modified.read(), b"modified\n")
                self.assertEqual(untracked.read(), b"untracked\n")

            self.assertEqual(bundle.deleted_paths, ("deleted.txt",))
            self.assertEqual(bundle.remote_url, "https://example.com/repository.git")

            clean = backend.build_workspace_bundle(root, include_overlay=False)
            with tarfile.open(
                fileobj=io.BytesIO(clean.archive), mode="r:gz"
            ) as archive:
                self.assertEqual(archive.getnames(), [])
            self.assertEqual(clean.deleted_paths, ())

            snapshot = backend.git_snapshot(root, bundle.commit)
            with tarfile.open(fileobj=io.BytesIO(snapshot), mode="r:gz") as archive:
                modified = archive.extractfile("modified.txt")
                self.assertEqual(modified.read(), b"original\n")
                self.assertNotIn("untracked.txt", archive.getnames())


class BackgroundJobTests(unittest.IsolatedAsyncioTestCase):
    async def test_poll_returns_result_and_always_cleans_up(self) -> None:
        shell = SimpleNamespace()
        shell.run = AsyncMock(
            side_effect=[
                SimpleNamespace(returncode=0, stdout="__DONE__0\nfinished\n"),
                SimpleNamespace(returncode=0, stdout=""),
            ]
        )
        code, output = await backend.poll_background_job(
            SimpleNamespace(shell=shell),
            "poll",
            "cleanup",
            "bootstrap.linux",
            10,
            "Linux",
        )
        self.assertEqual((code, output), (0, "finished"))
        self.assertEqual(shell.run.await_args_list[-1].args[0], "cleanup")

    async def test_poll_timeout_still_cleans_up(self) -> None:
        shell = SimpleNamespace()
        shell.run = AsyncMock(return_value=SimpleNamespace(returncode=0, stdout=""))
        with self.assertRaisesRegex(RuntimeError, "timed out"):
            await backend.poll_background_job(
                SimpleNamespace(shell=shell),
                "poll",
                "cleanup",
                "bootstrap.linux",
                0,
                "Linux",
            )
        self.assertEqual(shell.run.await_args_list[-1].args[0], "cleanup")


class VisibleOperationTests(unittest.IsolatedAsyncioTestCase):
    async def test_create_stops_before_cua_when_controller_tailscale_is_offline(
        self,
    ) -> None:
        with (
            patch.object(backend, "local_states", return_value=[]),
            patch.object(backend, "next_name", return_value="linux-1"),
            patch.object(
                backend,
                "local_tailscale_identity",
                side_effect=RuntimeError("local Tailscale is not online"),
            ),
            self.assertRaisesRegex(RuntimeError, "local Tailscale is not online"),
        ):
            await backend.create_one("linux", None)

    async def test_timeout_names_the_phase_and_writes_progress(self) -> None:
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(backend, "OPERATION_DIR", Path(directory)),
            patch.object(backend, "CURRENT_OPERATION_ID", "operation-1"),
        ):
            with self.assertRaisesRegex(
                RuntimeError, "connect.test timed out after 0.001 seconds"
            ):
                await backend.wait_for_step(asyncio.sleep(0.05), "connect.test", 0.001)
            events = [
                json.loads(line)
                for line in (Path(directory) / "operation-1.jsonl")
                .read_text()
                .splitlines()
            ]

        self.assertEqual(events[-1]["phase"], "connect.test")
        self.assertEqual(events[-1]["message"], "started")


class ControllerStateTests(unittest.TestCase):
    def test_execution_target_is_session_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            controller_dir = Path(directory)
            session_file = Path(directory) / "session.jsonl"
            with (
                patch.object(backend, "CONTROLLER_DIR", controller_dir),
                patch.object(
                    backend, "CONTROLLER_DB", controller_dir / "state.sqlite3"
                ),
            ):
                target = {
                    "kind": "sandbox",
                    "name": "linux-1",
                    "os": "linux",
                    "localCwd": "/local",
                    "remoteCwd": "/remote",
                }
                backend.set_execution_target("session-1", str(session_file), target)
                by_id = backend.get_execution_target(session_id="session-1")
                by_file = backend.get_execution_target(session_file=str(session_file))

            self.assertEqual(by_id["target"], target)
            self.assertEqual(by_file["target"], target)

    def test_long_operation_submission_returns_without_running_inline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            controller_dir = Path(directory)
            with (
                patch.object(backend, "CONTROLLER_DIR", controller_dir),
                patch.object(
                    backend, "CONTROLLER_DB", controller_dir / "state.sqlite3"
                ),
                patch.object(backend, "OPERATION_DIR", controller_dir / "operations"),
                patch.object(
                    backend.subprocess,
                    "Popen",
                    return_value=SimpleNamespace(pid=12345),
                ) as popen,
                patch.object(backend.os, "kill"),
            ):
                status = backend.submit_operation(
                    {"action": "ensure", "name": "linux-1"}, "operation-1"
                )
                backend.finish_operation(
                    "operation-1", "succeeded", result={"name": "linux-1"}
                )
                completed = backend.operation_status("operation-1")

            self.assertEqual(status["state"], "queued")
            self.assertEqual(status["worker_pid"], 12345)
            self.assertEqual(completed["state"], "succeeded")
            self.assertEqual(completed["result"], {"name": "linux-1"})
            popen.assert_called_once()


if __name__ == "__main__":
    unittest.main()
