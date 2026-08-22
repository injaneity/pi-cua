from __future__ import annotations

import asyncio
import hashlib
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

PINNED_IMAGE = "ghcr.io/acme/cua-linux@sha256:" + "a" * 64


class ResourceSelectionTests(unittest.TestCase):
    def test_resources_have_a_deterministic_pool(self) -> None:
        default = backend.sandbox_resources("linux")
        custom = backend.sandbox_resources("linux", 16, 64 * 1024)

        self.assertEqual((default.cpu, default.memory_mb), (8, 16 * 1024))
        self.assertEqual(custom, backend.sandbox_resources("linux", 16, 64 * 1024))
        self.assertRegex(custom.pool, r"^cua-pi-custom-linux-[0-9a-f]{16}$")
        self.assertEqual(backend.profile_for_pool(custom.pool), "linux")

    def test_custom_resources_require_two_positive_integers(self) -> None:
        for cpu, memory_mb in ((1, None), (None, 1), (0, 1), (1, -1)):
            with (
                self.subTest(cpu=cpu, memory_mb=memory_mb),
                self.assertRaisesRegex(ValueError, "supplied together|positive"),
            ):
                backend.sandbox_resources("linux", cpu, memory_mb)

    def test_custom_image_requires_a_digest_and_changes_the_pool(self) -> None:
        default = backend.sandbox_resources("linux")
        custom = backend.sandbox_resources("linux", image=PINNED_IMAGE)

        self.assertEqual(custom.image, PINNED_IMAGE)
        self.assertNotEqual(custom.pool, default.pool)
        with self.assertRaisesRegex(ValueError, "pinned by sha256"):
            backend.sandbox_resources("linux", image="ghcr.io/acme/cua-linux:latest")


class OperationLockTests(unittest.TestCase):
    def test_fleet_creation_does_not_take_the_workspace_lock(self) -> None:
        self.assertEqual(backend.operation_locks("create"), (backend.CONTROLLER_LOCK,))
        self.assertEqual(
            backend.operation_locks("prepare_execution"), (backend.WORKSPACE_LOCK,)
        )
        self.assertEqual(
            backend.operation_locks("delete"),
            (backend.CONTROLLER_LOCK, backend.WORKSPACE_LOCK),
        )


class ResourceCreationTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_create_releases_claim_record_and_custom_pool(self) -> None:
        sandbox = SimpleNamespace(delete=AsyncMock(side_effect=LookupError("gone")))
        pool = SimpleNamespace(delete=AsyncMock())
        resources = backend.sandbox_resources("linux", 8, 32 * 1024, PINNED_IMAGE)
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(
                "sys.modules", {"cua_sandbox": SimpleNamespace(Sandbox=sandbox)}
            ),
            patch.object(backend, "STATE_DIR", Path(directory)),
            patch.object(backend, "restore_cua_state"),
            patch.object(backend, "remove_sandbox_record") as remove,
            patch.object(backend, "pool_reference_count", return_value=0),
        ):
            await backend.cleanup_failed_create("linux-test", resources, pool)

        sandbox.delete.assert_awaited_once_with("linux-test")
        remove.assert_called_once_with("linux-test")
        pool.delete.assert_awaited_once_with()

    async def test_failed_cleanup_keeps_the_managed_record(self) -> None:
        sandbox = SimpleNamespace(delete=AsyncMock(side_effect=RuntimeError("busy")))
        pool = SimpleNamespace(delete=AsyncMock())
        resources = backend.sandbox_resources("linux", 8, 32 * 1024, PINNED_IMAGE)
        with (
            patch.dict(
                "sys.modules", {"cua_sandbox": SimpleNamespace(Sandbox=sandbox)}
            ),
            patch.object(backend, "restore_cua_state"),
            patch.object(backend, "remove_sandbox_record") as remove,
        ):
            await backend.cleanup_failed_create("linux-test", resources, pool)

        remove.assert_not_called()
        pool.delete.assert_not_awaited()

    async def test_resources_and_image_reach_the_dedicated_pool(self) -> None:
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
            await backend.create_one(
                "linux", "linux-custom", 16, 64 * 1024, PINNED_IMAGE
            )

        resources = backend.sandbox_resources("linux", 16, 64 * 1024, PINNED_IMAGE)
        self.assertEqual(pool.apply.call_args.kwargs["name"], resources.pool)
        self.assertEqual(pool.apply.call_args.kwargs["cpu"], 16)
        self.assertEqual(pool.apply.call_args.kwargs["memory_mb"], 64 * 1024)
        sdk.Image.from_registry.assert_called_once_with(
            PINNED_IMAGE, os_type="linux", kind="vm"
        )

    async def test_dispatch_passes_resources_to_create(self) -> None:
        create = AsyncMock(return_value={"name": "linux-1"})
        with (
            patch.object(backend, "configure_fleet_auth"),
            patch.object(backend, "create_one", create),
        ):
            await backend.dispatch(
                {
                    "action": "create",
                    "os": "linux",
                    "cpu": 16,
                    "memory_mb": 65536,
                    "image": PINNED_IMAGE,
                }
            )

        create.assert_awaited_once_with("linux", None, 16, 65536, PINNED_IMAGE)


class LocalStateTests(unittest.TestCase):
    def test_only_managed_fleet_claims_are_listed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            custom_pool = backend.sandbox_resources("linux", 16, 65536).pool
            (state_dir / "linux-1.json").write_text(
                json.dumps(
                    {
                        "name": "linux-1",
                        "runtime_type": "fleet",
                        "pool_name": custom_pool,
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
                    backend, "SANDBOX_RECORD_DIR", controller_dir / "sandboxes"
                ),
            ):
                self.assertEqual(
                    backend.local_states(),
                    [
                        {
                            "name": "linux-1",
                            "os": "linux",
                            "pool": custom_pool,
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

    def test_verified_host_key_is_left_unchanged_when_it_matches(self) -> None:
        key = "ssh-ed25519 AAAA-current"
        scan = subprocess.CompletedProcess(
            ["ssh-keyscan"], 0, stdout=f"100.64.0.2 {key}\n", stderr=""
        )
        found = subprocess.CompletedProcess(
            ["ssh-keygen"], 0, stdout=f"100.64.0.2 {key}\n", stderr=""
        )
        with patch.object(backend.subprocess, "run", side_effect=[scan, found]) as run:
            backend.pin_verified_ssh_host_key("100.64.0.2")

        self.assertEqual(run.call_count, 2)

    def test_verified_host_key_replaces_a_stale_entry(self) -> None:
        scan = subprocess.CompletedProcess(
            ["ssh-keyscan"],
            0,
            stdout="100.64.0.2 ssh-ed25519 AAAA-current\n",
            stderr="",
        )
        found = subprocess.CompletedProcess(
            ["ssh-keygen"],
            0,
            stdout="100.64.0.2 ssh-ed25519 AAAA-stale\n",
            stderr="",
        )
        removed = subprocess.CompletedProcess(["ssh-keygen"], 0, stdout="", stderr="")
        with tempfile.TemporaryDirectory() as directory:
            known_hosts = Path(directory) / "known_hosts"
            known_hosts.write_text("100.64.0.2 ssh-ed25519 AAAA-stale\n")
            with (
                patch.object(backend, "SANDBOX_KNOWN_HOSTS", known_hosts),
                patch.object(
                    backend.subprocess, "run", side_effect=[scan, found, removed]
                ) as run,
            ):
                backend.pin_verified_ssh_host_key("100.64.0.2")

            self.assertIn(
                "100.64.0.2 ssh-ed25519 AAAA-current", known_hosts.read_text()
            )
            self.assertEqual(run.call_args_list[2].args[0][1:3], ["-R", "100.64.0.2"])

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

    def test_bootstrap_digest_ignores_mutable_guest_config(self) -> None:
        with (
            patch.object(backend, "pi_version", return_value="1.2.3"),
            patch.object(backend, "bootstrap_template", return_value="bootstrap"),
            patch.object(backend, "remote_pi_files", return_value={"one": b"1"}),
        ):
            first_bootstrap = backend.bootstrap_digest("linux")
            first_config = backend.config_digest(backend.guest_config_files())
        with (
            patch.object(backend, "pi_version", return_value="1.2.3"),
            patch.object(backend, "bootstrap_template", return_value="bootstrap"),
            patch.object(backend, "remote_pi_files", return_value={"one": b"2"}),
        ):
            self.assertEqual(backend.bootstrap_digest("linux"), first_bootstrap)
            self.assertNotEqual(
                backend.config_digest(backend.guest_config_files()), first_config
            )

    def test_linux_preflight_combines_health_config_disk_and_repository(self) -> None:
        with patch.object(
            backend,
            "run_guest_ssh",
            return_value=subprocess.CompletedProcess(
                [], 0, "100.64.0.2|1073741824|cccc|1\n", ""
            ),
        ) as run:
            result = backend.guest_preflight(
                "linux-1",
                "linux",
                "https://example.com/repo.git",
                "a" * 40,
                "cccc",
            )

        self.assertEqual(
            result,
            backend.GuestPreflight("100.64.0.2", 1073741824, True, True),
        )
        command = run.call_args.args[2]
        self.assertIn("bootstrap-version", command)
        self.assertIn("config-version", command)
        self.assertIn("df -Pk", command)
        self.assertIn("git ls-remote", command)

    def test_remote_config_archive_has_a_managed_file_manifest(self) -> None:
        with patch.object(
            backend,
            "remote_pi_files",
            return_value={".pi/agent/example.ts": b"export default 1;\n"},
        ):
            files = backend.guest_config_files()
            content = backend.guest_config_archive(files)

        self.assertRegex(backend.config_digest(files), r"^[0-9a-f]{20}$")
        with tarfile.open(fileobj=io.BytesIO(content), mode="r:gz") as archive:
            self.assertEqual(
                archive.extractfile(".pi/agent/example.ts").read(),
                b"export default 1;\n",
            )
            self.assertEqual(
                archive.extractfile(".cua-pi/config-files.new").read(),
                b".pi/agent/example.ts\n.pi/agent/settings.json\n",
            )
            self.assertEqual(
                json.loads(archive.extractfile(".pi/agent/settings.json").read()),
                {"packages": []},
            )

    def test_remote_config_includes_generic_tool_host(self) -> None:
        files = backend.remote_pi_files()
        self.assertIn(".pi/agent/cua-tool-host.mjs", files)
        self.assertNotIn(".pi/agent/cua-tool-broker.mjs", files)
        self.assertIn(".pi/agent/cua-tool-relay.mjs", files)
        self.assertIn(
            b'request.type === "execute"', files[".pi/agent/cua-tool-host.mjs"]
        )
        self.assertNotIn(".pi/agent/auth.json", files)
        self.assertNotIn(".pi/agent/models.json", files)
        self.assertNotIn(".pi/agent/settings.json", files)

    def test_windows_guest_config_sync_replaces_only_managed_files(self) -> None:
        with (
            patch.object(backend, "copy_guest_file") as copy,
            patch.object(
                backend,
                "run_guest_ssh",
                return_value=subprocess.CompletedProcess([], 0, "", ""),
            ) as run,
        ):
            backend.sync_guest_config("windows-1", "windows", b"archive", "1" * 20)

        copy.assert_called_once_with(
            "windows-1",
            "windows",
            b"archive",
            r"C:\Windows\Temp\cua-pi-config-11111111111111111111.tgz",
        )
        script = run.call_args.args[2]
        self.assertIn("StartsWith('.pi/agent/')", script)
        self.assertIn("tar.exe -xzf", script)
        self.assertIn("config-version", script)

    def test_guest_bundle_contains_only_requested_tool_packages(self) -> None:
        files = backend.guest_config_files(("git:github.com/example/tool-package",))
        content = backend.guest_config_archive(files)
        with tarfile.open(fileobj=io.BytesIO(content), mode="r:gz") as archive:
            settings = json.loads(archive.extractfile(".pi/agent/settings.json").read())
        self.assertEqual(
            settings,
            {"packages": ["git:github.com/example/tool-package"]},
        )

    def test_guest_bundle_digest_includes_tool_packages(self) -> None:
        self.assertNotEqual(
            backend.config_digest(backend.guest_config_files()),
            backend.config_digest(
                backend.guest_config_files(("git:github.com/example/tool-package",))
            ),
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

    def test_clean_workspace_tree_reuses_the_head_tree(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = self.repository(directory)
            (root / "tracked.txt").write_text("committed\n")
            subprocess.run(["git", "-C", root, "add", "."], check=True)
            subprocess.run(["git", "-C", root, "commit", "-qm", "initial"], check=True)

            _, tree = backend.workspace_tree(root)

            self.assertEqual(tree, backend.git_output(root, "rev-parse", "HEAD^{tree}"))

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

    def test_parse_numstat_ignores_binary_files(self) -> None:
        self.assertEqual(
            backend.parse_numstat(
                "12\t3\ttracked.txt\n-\t-\tbinary.bin\n4\t0\tnew.txt\n"
            ),
            (16, 3),
        )

    def test_workspace_diff_status_compares_remote_and_local_trees(self) -> None:
        state = backend.WorkspaceState(
            version=1,
            localRoot="/local",
            commit="a" * 40,
            commitTree="1" * 40,
            baselineTree="2" * 40,
        )
        source = backend.SandboxWorkspaceSource(
            address="100.64.0.2",
            os="linux",
            remoteCwd="/workspace/subdir",
            state=state,
        )
        with (
            patch.object(backend, "git_output", return_value="/local"),
            patch.object(
                backend, "workspace_tree", return_value=(Path("/local"), "3" * 40)
            ),
            patch.object(
                backend,
                "workspace_location",
                return_value=("/workspace", "subdir"),
            ),
            patch.object(backend, "remote_workspace_tree", return_value="4" * 40),
            patch.object(
                backend, "remote_workspace_numstat", return_value=(17, 5)
            ) as stats,
        ):
            result = backend.workspace_diff_status(source, "/local")

        self.assertEqual(
            result,
            {
                "additions": 17,
                "deletions": 5,
                "pending_sync": True,
                "sync_safe": False,
            },
        )
        stats.assert_called_once_with(
            "100.64.0.2",
            "linux",
            "/workspace",
            "1" * 40,
            "4" * 40,
        )

    def test_workspace_cleanup_rejects_paths_outside_the_managed_root(self) -> None:
        with (
            patch.object(backend, "run_guest_ssh") as run,
            self.assertRaisesRegex(RuntimeError, "invalid Linux workspace path"),
        ):
            backend.cleanup_workspace_root("linux-1", "linux", "/home/cua")
        run.assert_not_called()

    def test_workspace_cleanup_removes_one_exact_managed_root(self) -> None:
        with patch.object(backend, "run_guest_ssh") as run:
            backend.cleanup_workspace_root(
                "linux-1", "linux", "/home/cua/workspaces/0123456789abcdef"
            )
        self.assertIn(
            "rm -rf -- /home/cua/workspaces/0123456789abcdef",
            run.call_args.args[2],
        )

    def test_windows_workspace_cleanup_accepts_one_exact_managed_root(self) -> None:
        with patch.object(backend, "run_guest_ssh") as run:
            backend.cleanup_workspace_root(
                "windows-1", "windows", r"C:\cua\workspaces\0123456789abcdef"
            )
        self.assertIn("Remove-Item -Recurse -Force", run.call_args.args[2])

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
        self.transfer = backend.WorkspaceTransfer(self.state, b"final", "3" * 40)

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
        self.assertEqual(transfer.patch, b"baseline")
        self.assertEqual(transfer.final_tree, self.state["baselineTree"])
        workspace_patch.assert_called_once_with(
            Path("/local"), self.state["commitTree"], self.state["baselineTree"]
        )

    def test_sandbox_capture_builds_one_final_tree_patch(self) -> None:
        with (
            patch.object(backend, "workspace_location", return_value=("/source", ".")),
            patch.object(backend, "remote_workspace_tree", return_value="3" * 40),
            patch.object(
                backend, "remote_workspace_patch", return_value=b"final"
            ) as workspace_patch,
        ):
            transfer = backend.capture_sandbox_workspace(self.source)

        self.assertEqual(transfer.patch, b"final")
        self.assertEqual(transfer.final_tree, "3" * 40)
        workspace_patch.assert_called_once_with(
            "100.64.0.1", "linux", "/source", "1" * 40, "3" * 40
        )

    def test_restore_applies_one_final_tree_patch(self) -> None:
        with patch.object(backend, "apply_remote_workspace_patch") as apply_patch:
            backend.restore_sandbox_workspace(
                "100.64.0.2", "windows", r"C:\workspace", self.transfer, "session"
            )

        apply_patch.assert_called_once_with(
            "100.64.0.2",
            "windows",
            r"C:\workspace",
            b"final",
            "3" * 40,
            reference="session/workspace",
        )

    def test_restore_clean_workspace_requires_no_remote_snapshot_or_patch(self) -> None:
        state = backend.WorkspaceState(
            version=1,
            localRoot="/local",
            commit="a" * 40,
            commitTree="1" * 40,
            baselineTree="1" * 40,
        )
        transfer = backend.WorkspaceTransfer(state, b"", "1" * 40)
        with patch.object(backend, "apply_remote_workspace_patch") as apply_patch:
            backend.restore_sandbox_workspace(
                "100.64.0.2", "linux", "/workspace", transfer, "session"
            )
        apply_patch.assert_not_called()

    def test_restore_rejects_an_empty_inconsistent_workspace_patch(self) -> None:
        transfer = backend.WorkspaceTransfer(self.state, b"", "2" * 40)
        with (
            patch.object(backend, "apply_remote_workspace_patch") as apply_patch,
            self.assertRaisesRegex(RuntimeError, "empty workspace patch"),
        ):
            backend.restore_sandbox_workspace(
                "100.64.0.2", "linux", "/workspace", transfer, "session"
            )
        apply_patch.assert_not_called()

    async def test_linux_workspace_borrows_from_the_shared_object_cache(self) -> None:
        with patch.object(backend, "run_guest_ssh") as run:
            await backend.prepare_workspace(
                "100.64.0.2",
                "linux",
                self.repository,
                "session",
                repository_available=True,
            )

        command = run.call_args.args[2]
        self.assertIn("git clone --shared --no-checkout", command)
        self.assertIn("remote set-url origin", command)
        self.assertNotIn("--dissociate", command)

    async def test_windows_workspace_fetches_a_missing_cached_commit(self) -> None:
        with patch.object(backend, "run_guest_ssh") as run:
            await backend.prepare_workspace(
                "100.64.0.2",
                "windows",
                self.repository,
                "session",
                repository_available=True,
            )

        encoded = run.call_args.args[2].rsplit(" ", 1)[-1]
        script = backend.base64.b64decode(encoded).decode("utf-16le")
        self.assertIn("function Test-GitCommit", script)
        self.assertIn(
            "elseif (-not (Test-GitCommit $cache 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'))",
            script,
        )
        self.assertIn("git -C $cache fetch --quiet origin", script)
        self.assertIn("--shared --no-checkout $cache $root", script)
        self.assertNotIn("--dissociate", script)
        self.assertNotIn("git -C $cache cat-file -e", script.split("$root =", 1)[1])

    async def test_prepare_execution_connects_capture_prepare_and_restore(self) -> None:
        transfer = backend.WorkspaceTransfer(self.state, b"final", "2" * 40)
        preflight = backend.GuestPreflight("100.64.0.2", 2**30, True, True)
        with (
            patch.object(
                backend,
                "local_states",
                return_value=[{"name": "linux-1", "os": "linux"}],
            ),
            patch.object(backend, "inspect_workspace", return_value=self.repository),
            patch.object(backend, "capture_sandbox_workspace", return_value=transfer),
            patch.object(backend, "guest_preflight", return_value=preflight),
            patch.object(backend, "sync_guest_config") as sync_config,
            patch.object(
                backend,
                "prepare_workspace",
                AsyncMock(return_value="/remote/workspace"),
            ) as prepare,
            patch.object(backend, "restore_sandbox_workspace") as restore,
        ):
            result = await backend.prepare_execution(
                "linux-1", "/local", "session-1", self.source
            )

        self.assertEqual(result["workspace_state"], self.state)
        self.assertEqual(prepare.await_args.args[2].commit, self.state["commit"])
        self.assertTrue(prepare.await_args.kwargs["repository_available"])
        sync_config.assert_not_called()
        restore.assert_called_once()

    async def test_prepare_execution_requests_repair_without_loading_the_sdk(
        self,
    ) -> None:
        transfer = backend.WorkspaceTransfer(self.state, b"final", "2" * 40)
        with (
            patch.object(
                backend,
                "local_states",
                return_value=[{"name": "linux-1", "os": "linux"}],
            ),
            patch.object(backend, "inspect_workspace", return_value=self.repository),
            patch.object(backend, "capture_sandbox_workspace", return_value=transfer),
            patch.object(backend, "guest_preflight", return_value=None),
            patch.object(backend, "connect_sandbox") as connect,
            self.assertRaisesRegex(
                backend.SandboxRepairRequired, "sandbox repair required"
            ),
        ):
            await backend.prepare_execution(
                "linux-1", "/local", "session-1", self.source
            )
        connect.assert_not_called()

    async def test_prepare_execution_syncs_one_mismatched_guest_bundle(self) -> None:
        transfer = backend.WorkspaceTransfer(self.state, b"final", "2" * 40)
        preflight = backend.GuestPreflight("100.64.0.2", 2**30, False, True)
        with (
            patch.object(
                backend,
                "local_states",
                return_value=[{"name": "linux-1", "os": "linux"}],
            ),
            patch.object(backend, "inspect_workspace", return_value=self.repository),
            patch.object(backend, "capture_sandbox_workspace", return_value=transfer),
            patch.object(backend, "guest_preflight", return_value=preflight),
            patch.object(backend, "guest_config_files", return_value={"x": b""}),
            patch.object(backend, "config_digest", return_value="c" * 20),
            patch.object(backend, "guest_config_archive", return_value=b"bundle"),
            patch.object(backend, "sync_guest_config") as sync_config,
            patch.object(
                backend,
                "prepare_workspace",
                AsyncMock(return_value="/remote/workspace"),
            ),
            patch.object(backend, "restore_sandbox_workspace"),
        ):
            await backend.prepare_execution(
                "linux-1", "/local", "session-1", self.source
            )
        sync_config.assert_called_once_with("100.64.0.2", "linux", b"bundle", "c" * 20)

    async def test_prepare_execution_cleans_up_after_low_disk_preflight(self) -> None:
        transfer = backend.WorkspaceTransfer(self.state, b"final", "2" * 40)
        preflight = backend.GuestPreflight("100.64.0.2", 512 * 1024**2, True, True)
        with (
            patch.object(
                backend,
                "local_states",
                return_value=[{"name": "linux-1", "os": "linux"}],
            ),
            patch.object(backend, "inspect_workspace", return_value=self.repository),
            patch.object(backend, "capture_sandbox_workspace", return_value=transfer),
            patch.object(backend, "guest_preflight", return_value=preflight),
            patch.object(backend, "prepare_workspace") as prepare,
            patch.object(backend, "cleanup_workspace_root") as cleanup,
            self.assertRaisesRegex(RuntimeError, "requires 1 GiB free"),
        ):
            await backend.prepare_execution(
                "linux-1", "/local", "session-1", self.source
            )
        prepare.assert_not_called()
        workspace_id = hashlib.sha256(b"session-1").hexdigest()[:16]
        cleanup.assert_called_once_with(
            "100.64.0.2", "linux", f"/home/cua/workspaces/{workspace_id}"
        )

    async def test_prepare_execution_removes_an_incomplete_destination(self) -> None:
        transfer = backend.WorkspaceTransfer(self.state, b"final", "2" * 40)
        preflight = backend.GuestPreflight("100.64.0.2", 2**30, True, True)
        with (
            patch.object(
                backend,
                "local_states",
                return_value=[{"name": "linux-1", "os": "linux"}],
            ),
            patch.object(backend, "inspect_workspace", return_value=self.repository),
            patch.object(backend, "capture_sandbox_workspace", return_value=transfer),
            patch.object(backend, "guest_preflight", return_value=preflight),
            patch.object(
                backend,
                "prepare_workspace",
                AsyncMock(side_effect=RuntimeError("clone failed")),
            ),
            patch.object(backend, "cleanup_workspace_root") as cleanup,
            self.assertRaisesRegex(RuntimeError, "clone failed"),
        ):
            await backend.prepare_execution(
                "linux-1", "/local", "session-1", self.source
            )

        workspace_id = hashlib.sha256(b"session-1").hexdigest()[:16]
        cleanup.assert_called_once_with(
            "100.64.0.2", "linux", f"/home/cua/workspaces/{workspace_id}"
        )

    async def test_prepare_dispatch_does_not_load_fleet_credentials(self) -> None:
        with (
            patch.object(backend, "configure_fleet_auth") as configure,
            patch.object(
                backend,
                "prepare_execution",
                AsyncMock(return_value={"remote_cwd": "/workspace"}),
            ) as prepare,
        ):
            result = await backend.dispatch(
                {
                    "action": "prepare_execution",
                    "name": "linux-1",
                    "source_cwd": "/local",
                    "workspace_id": "session-1",
                    "tool_packages": [],
                }
            )

        configure.assert_not_called()
        prepare.assert_awaited_once()
        self.assertEqual(result, {"remote_cwd": "/workspace"})


class WindowsDesktopBrokerTests(unittest.TestCase):
    def test_preflight_uses_ssh_as_the_windows_transport_probe(self) -> None:
        with (
            patch.object(backend, "bootstrap_digest", return_value="b" * 20),
            patch.object(
                backend,
                "run_guest_ssh",
                return_value=subprocess.CompletedProcess(
                    [], 0, "healthy|1073741824|cccc|1\n", ""
                ),
            ) as run,
        ):
            result = backend.guest_preflight(
                "100.64.0.2",
                "windows",
                "https://example.com/repo.git",
                "a" * 40,
                "cccc",
            )

        self.assertEqual(
            result,
            backend.GuestPreflight("100.64.0.2", 1073741824, True, True),
        )
        encoded = run.call_args.args[2].rsplit(" ", 1)[-1]
        script = backend.base64.b64decode(encoded).decode("utf-16le")
        self.assertNotIn("Get-Service", script)
        self.assertNotIn("tailscale.exe", script)

    def test_bootstrap_registers_an_interactive_logon_task(self) -> None:
        script = backend.bootstrap_template("windows")

        self.assertIn("New-ScheduledTaskPrincipal", script)
        self.assertIn("-LogonType Interactive", script)
        self.assertIn("cua-tool-broker.mjs", script)
        self.assertIn("cua-tool-broker.token", script)

    def test_bootstrap_owns_only_the_desktop_broker(self) -> None:
        script = backend.bootstrap_template("windows")

        self.assertNotIn("Invoke-Icacls @($cuaHome", script)
        self.assertNotIn("$extensions", script)
        self.assertNotIn("cua-tool-host.mjs", script)
        self.assertNotIn("cua-tool-relay.mjs", script)
        self.assertIn(
            "Invoke-Icacls @(\"$agent\\cua-tool-broker.mjs\", '/grant:r', 'cua:F')",
            script,
        )
        self.assertIn(
            "Invoke-Icacls @($projects, '/grant:r', 'cua:(OI)(CI)F')",
            script,
        )
        self.assertIn(
            "Invoke-Icacls @($authorizedKeys, '/inheritance:r'",
            script,
        )


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

    async def test_timeout_names_the_phase_and_streams_progress(self) -> None:
        output = io.StringIO()
        with (
            patch.dict(backend.os.environ, {"CUA_PROGRESS_JSON": "1"}),
            patch("sys.stdout", output),
            self.assertRaisesRegex(
                RuntimeError, "connect.test timed out after 0.001 seconds"
            ),
        ):
            await backend.wait_for_step(asyncio.sleep(0.05), "connect.test", 0.001)

        event = json.loads(output.getvalue())
        self.assertEqual(event["phase"], "connect.test")
        self.assertEqual(event["message"], "started")


class ControllerStateTests(unittest.TestCase):
    def test_cloud_worker_uses_the_isolated_sdk_runtime(self) -> None:
        command = backend.cloud_worker_command({"action": "ensure", "name": "linux-1"})
        self.assertEqual(command[:4], ["uv", "run", "--quiet", "--no-project"])
        self.assertIn("cua-sandbox==0.4.2", command)


if __name__ == "__main__":
    unittest.main()
