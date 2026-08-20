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
from unittest.mock import AsyncMock, Mock, patch

import backend


class SizeSelectionTests(unittest.TestCase):
    def test_default_and_large_sizes_use_distinct_pools(self) -> None:
        default = backend.sandbox_size("linux")
        large = backend.sandbox_size("linux", "large")

        self.assertEqual((default.cpu, default.memory_mb), (8, 16 * 1024))
        self.assertEqual((large.cpu, large.memory_mb), (16, 64 * 1024))
        self.assertNotEqual(default.pool, large.pool)
        self.assertEqual(backend.profile_for_pool(large.pool), "linux")

    def test_unknown_size_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "default, large"):
            backend.sandbox_size("linux", "huge")

    def test_sizes_cannot_share_a_pool(self) -> None:
        default_pool = backend.sandbox_size("linux").pool
        with (
            patch.dict(
                backend.PROFILES["linux"]["sizes"]["large"],
                {"pool": default_pool},
            ),
            self.assertRaisesRegex(ValueError, "requires a distinct pool"),
        ):
            backend.sandbox_size("linux", "large")

    def test_recorded_size_survives_state_file_merge(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            controller_dir = Path(directory)
            state_dir = controller_dir / "sandboxes"
            state_dir.mkdir()
            with (
                patch.object(backend, "CONTROLLER_DIR", controller_dir),
                patch.object(
                    backend, "CONTROLLER_DB", controller_dir / "state.sqlite3"
                ),
                patch.object(backend, "STATE_DIR", state_dir),
                patch.object(backend, "restore_cua_state"),
            ):
                size = backend.sandbox_size("linux", "large")
                backend.record_sandbox("linux-1", "linux", {"pool": size.pool}, size)
                (state_dir / "linux-1.json").write_text(
                    json.dumps(
                        {
                            "runtime_type": "fleet",
                            "pool_name": size.pool,
                            "name": "linux-1",
                        }
                    )
                )
                item = backend.local_states()[0]

        self.assertEqual(item["size"], "large")
        self.assertEqual((item["cpu"], item["memory_mb"]), (16, 64 * 1024))


class SizeCreationTests(unittest.IsolatedAsyncioTestCase):
    async def test_large_resources_reach_the_dedicated_pool(self) -> None:
        pool = Mock()
        pool.apply.return_value = object()
        sdk = SimpleNamespace(
            Image=SimpleNamespace(from_registry=Mock(return_value=object())),
            Pool=pool,
            Sandbox=Mock(),
            WarmPoolAutoscaling=Mock(return_value=object()),
        )
        with (
            patch.dict("sys.modules", {"cua_sandbox": sdk}),
            patch.object(backend, "local_states", return_value=[]),
            patch.object(backend, "local_tailscale_identity", return_value={}),
            patch.object(
                backend,
                "wait_for_step",
                AsyncMock(side_effect=RuntimeError("stop after pool apply")),
            ),
            self.assertRaisesRegex(RuntimeError, "stop after pool apply"),
        ):
            await backend.create_one("linux", "linux-large", "large")

        size = backend.sandbox_size("linux", "large")
        self.assertEqual(pool.apply.call_args.kwargs["name"], size.pool)
        self.assertEqual(pool.apply.call_args.kwargs["cpu"], 16)
        self.assertEqual(pool.apply.call_args.kwargs["memory_mb"], 64 * 1024)


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

    def test_local_state_preserves_controller_tailscale_address(self) -> None:
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
            controller = {
                "name": "linux-1",
                "os": "linux",
                "pool": "cua-pi-linux",
                "address": "100.64.0.2",
            }
            with (
                patch.object(backend, "STATE_DIR", state_dir),
                patch.object(
                    backend, "controller_sandboxes", return_value=[controller]
                ),
            ):
                self.assertEqual(backend.local_states(), [controller])


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


class WorkspaceTests(unittest.TestCase):
    def repository(self, directory: str) -> Path:
        root = Path(directory)
        subprocess.run(["git", "init", "-q", root], check=True)
        for key, value in (
            ("user.email", "test@example.com"),
            ("user.name", "Test"),
        ):
            subprocess.run(["git", "-C", root, "config", key, value], check=True)
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
        return root

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

    def test_bundle_describes_only_the_clean_git_baseline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = self.repository(directory)
            (root / "modified.txt").write_text("original\n")
            (root / "deleted.txt").write_text("delete me\n")
            subprocess.run(["git", "-C", root, "add", "."], check=True)
            subprocess.run(["git", "-C", root, "commit", "-qm", "initial"], check=True)
            (root / "modified.txt").write_text("modified\n")
            (root / "untracked.txt").write_text("untracked\n")
            (root / "deleted.txt").unlink()

            source = backend.inspect_workspace(root)
            self.assertEqual(source.remote_url, "https://example.com/repository.git")
            self.assertEqual(source.relative_cwd, Path("."))

            snapshot = backend.git_snapshot(root, source.commit)
            with tarfile.open(fileobj=io.BytesIO(snapshot), mode="r:gz") as archive:
                modified = archive.extractfile("modified.txt")
                self.assertEqual(modified.read(), b"original\n")
                self.assertNotIn("untracked.txt", archive.getnames())

    def test_workspace_with_content_filter_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = self.repository(directory)
            (root / ".gitattributes").write_text("*.bin filter=lfs\n")
            subprocess.run(["git", "-C", root, "add", ".gitattributes"], check=True)
            subprocess.run(["git", "-C", root, "commit", "-qm", "initial"], check=True)
            (root / "asset.bin").write_bytes(b"content")

            with self.assertRaisesRegex(ValueError, "filter=lfs"):
                backend.inspect_workspace(root)

    def test_workspace_tree_diff_preserves_dirty_baseline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = self.repository(directory)
            (root / "tracked.txt").write_text("committed\n")
            subprocess.run(["git", "-C", root, "add", "."], check=True)
            subprocess.run(["git", "-C", root, "commit", "-qm", "initial"], check=True)

            (root / "tracked.txt").write_text("local baseline\n")
            (root / "untracked.txt").write_text("local untracked\n")
            _, baseline = backend.workspace_tree(root)

            (root / "tracked.txt").write_text("sandbox edit\n")
            (root / "untracked.txt").unlink()
            (root / "created.txt").write_text("sandbox created\n")
            _, final = backend.workspace_tree(root)
            patch_bytes = backend.workspace_patch(root, baseline, final)

            (root / "tracked.txt").write_text("local baseline\n")
            (root / "untracked.txt").write_text("local untracked\n")
            (root / "created.txt").unlink()
            backend.apply_workspace_patch(root, patch_bytes, final)

            self.assertEqual((root / "tracked.txt").read_text(), "sandbox edit\n")
            self.assertFalse((root / "untracked.txt").exists())
            self.assertEqual((root / "created.txt").read_text(), "sandbox created\n")

    def test_empty_remote_patch_still_retains_and_verifies_the_tree(self) -> None:
        tree = "1" * 40
        with (
            patch.object(backend, "copy_guest_file") as copy,
            patch.object(backend, "run_guest_ssh") as run,
            patch.object(
                backend, "remote_workspace_tree", return_value=tree
            ) as snapshot,
        ):
            backend.apply_remote_workspace_patch(
                "100.64.0.2",
                "linux",
                "/workspace",
                b"",
                tree,
                reference="session/workspace",
            )

        copy.assert_not_called()
        run.assert_not_called()
        snapshot.assert_called_once_with(
            "100.64.0.2",
            "linux",
            "/workspace",
            reference="session/workspace",
        )


class WorkspaceOrchestrationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.state = backend.WorkspaceState(
            version=1,
            localRoot="/local",
            commit="a" * 40,
            commitTree="1" * 40,
            baselineTree="2" * 40,
        )
        self.source = backend.SandboxWorkspaceSource(
            address="100.64.0.1",
            os="linux",
            remoteCwd="/source/workspace",
            state=self.state,
        )
        self.repository = backend.WorkspaceRepository(
            Path("/local"), Path("."), "https://example.com/repo.git", "a" * 40
        )
        self.transfer = backend.WorkspaceTransfer(
            self.state, b"baseline", b"current", "3" * 40
        )

    def test_local_capture_builds_one_verified_transfer(self) -> None:
        with (
            patch.object(
                backend,
                "workspace_tree",
                return_value=(Path("/local"), self.state["baselineTree"]),
            ),
            patch.object(backend, "git_output", return_value=self.state["commitTree"]),
            patch.object(
                backend, "workspace_patch", return_value=b"baseline"
            ) as workspace_patch,
        ):
            transfer = backend.capture_local_workspace(self.repository)

        self.assertEqual(transfer.state, self.state)
        self.assertEqual(transfer.baseline_patch, b"baseline")
        self.assertEqual(transfer.current_patch, b"")
        self.assertEqual(transfer.final_tree, self.state["baselineTree"])
        workspace_patch.assert_called_once_with(
            Path("/local"), self.state["commitTree"], self.state["baselineTree"]
        )

    def test_sandbox_capture_builds_baseline_and_current_patches(self) -> None:
        with (
            patch.object(backend, "workspace_location", return_value=("/source", ".")),
            patch.object(backend, "remote_workspace_tree", return_value="3" * 40),
            patch.object(
                backend,
                "remote_workspace_patch",
                side_effect=[b"current", b"baseline"],
            ) as workspace_patch,
        ):
            transfer = backend.capture_sandbox_workspace(self.source)

        self.assertEqual(transfer.baseline_patch, b"baseline")
        self.assertEqual(transfer.current_patch, b"current")
        self.assertEqual(transfer.final_tree, "3" * 40)
        self.assertEqual(workspace_patch.call_count, 2)

    def test_restore_verifies_commit_then_applies_baseline_and_current(self) -> None:
        with (
            patch.object(
                backend,
                "remote_workspace_tree",
                return_value=self.state["commitTree"],
            ),
            patch.object(backend, "apply_remote_workspace_patch") as apply_patch,
        ):
            backend.restore_sandbox_workspace(
                "100.64.0.2", "windows", r"C:\workspace", self.transfer, "session"
            )

        self.assertEqual(
            [call.args[3] for call in apply_patch.call_args_list],
            [b"baseline", b"current"],
        )
        self.assertEqual(
            apply_patch.call_args_list[0].kwargs["reference"], "session/workspace"
        )

    def test_restore_rejects_destination_commit_mismatch(self) -> None:
        with (
            patch.object(backend, "remote_workspace_tree", return_value="9" * 40),
            patch.object(backend, "apply_remote_workspace_patch") as apply_patch,
            self.assertRaisesRegex(RuntimeError, "does not match the Git baseline"),
        ):
            backend.restore_sandbox_workspace(
                "100.64.0.2", "linux", "/workspace", self.transfer, "session"
            )
        apply_patch.assert_not_called()

    async def test_prepare_execution_connects_capture_prepare_and_restore(self) -> None:
        transfer = backend.WorkspaceTransfer(self.state, b"baseline", b"", "2" * 40)
        with (
            patch.object(
                backend,
                "local_states",
                return_value=[{"name": "linux-1", "os": "linux"}],
            ),
            patch.object(backend, "inspect_workspace", return_value=self.repository),
            patch.object(backend, "capture_sandbox_workspace", return_value=transfer),
            patch.object(backend, "healthy_over_ssh", return_value="100.64.0.2"),
            patch.object(backend, "sync_guest_packages"),
            patch.object(
                backend,
                "prepare_workspace",
                AsyncMock(return_value="/remote/workspace"),
            ) as prepare,
            patch.object(backend, "workspace_location", return_value=("/remote", ".")),
            patch.object(backend, "restore_sandbox_workspace") as restore,
        ):
            result = await backend.prepare_execution(
                "linux-1", "/local", "session-1", self.source
            )

        self.assertEqual(result["workspace_state"], self.state)
        self.assertEqual(prepare.await_args.args[2].commit, self.state["commit"])
        restore.assert_called_once()


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
                    "address": "100.64.0.2",
                    "localCwd": "/local",
                    "remoteCwd": "/remote",
                    "workspaceState": {
                        "version": 1,
                        "localRoot": "/local",
                        "commit": "a" * 40,
                        "commitTree": "1" * 40,
                        "baselineTree": "1" * 40,
                    },
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
