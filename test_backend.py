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


class ControllerPrerequisiteTests(unittest.TestCase):
    def test_windows_identity_is_generated_once_with_private_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            identity = Path(directory) / ".ssh" / "cua_windows_ed25519"
            public = identity.with_suffix(".pub")
            with (
                patch.object(backend, "WINDOWS_IDENTITY", identity),
                patch.object(backend, "WINDOWS_PUBLIC_KEY", public),
            ):
                self.assertEqual(backend.ensure_windows_identity(), identity)
                first_public = public.read_bytes()
                self.assertEqual(backend.ensure_windows_identity(), identity)

            self.assertTrue(first_public.startswith(b"ssh-ed25519 "))
            self.assertEqual(identity.stat().st_mode & 0o777, 0o600)
            self.assertEqual(public.stat().st_mode & 0o777, 0o644)

    def test_environment_credentials_do_not_require_keychain(self) -> None:
        with (
            patch.dict("os.environ", {"CUA_CLIENT_ID": "from-env"}),
            patch.object(backend, "keychain") as keychain,
        ):
            self.assertEqual(
                backend.credential(
                    "CUA_CLIENT_ID", "client-id", backend.FLEET_KEYCHAIN_SERVICE
                ),
                "from-env",
            )
        keychain.assert_not_called()


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
            patch.object(backend, "managed_sandboxes", return_value=[]),
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

    async def test_delete_removes_the_last_custom_pool(self) -> None:
        resources = backend.sandbox_resources("linux", 16, 64 * 1024)
        pool = AsyncMock()
        sdk = SimpleNamespace(Sandbox=AsyncMock(), Pool=AsyncMock())
        sdk.Pool.get.return_value = pool
        with (
            patch.dict("sys.modules", {"cua_sandbox": sdk}),
            patch.object(
                backend,
                "managed_sandboxes",
                return_value=[
                    {"name": "linux-1", "os": "linux", "pool": resources.pool}
                ],
            ),
            patch.object(backend, "restore_cua_state"),
            patch.object(backend, "remove_sandbox_record") as remove,
        ):
            result = await backend.delete_one("linux-1")

        self.assertTrue(result["deleted"])
        sdk.Pool.get.assert_awaited_once_with(resources.pool)
        pool.delete.assert_awaited_once()
        remove.assert_called_once_with("linux-1")

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


class ManagedSandboxTests(unittest.TestCase):
    def test_existing_sdk_records_are_adopted_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory) / "sdk"
            state_dir.mkdir()
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
            controller_dir = Path(directory) / "controller"
            with (
                patch.object(backend, "STATE_DIR", state_dir),
                patch.object(backend, "CONTROLLER_DIR", controller_dir),
                patch.object(backend, "CONTROLLER_LOCK", controller_dir / "lock"),
                patch.object(
                    backend, "SANDBOX_RECORD_DIR", controller_dir / "sandboxes"
                ),
            ):
                backend.migrate_sdk_sandbox_records()
                backend.migrate_sdk_sandbox_records()
                self.assertEqual(
                    backend.managed_sandboxes(),
                    [
                        {
                            "name": "linux-1",
                            "os": "linux",
                            "pool": custom_pool,
                            "address": None,
                        }
                    ],
                )
                self.assertTrue((controller_dir / ".sdk-state-migrated").exists())

    def test_completed_migration_does_not_wait_for_the_mutation_lock(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            controller_dir = Path(directory)
            (controller_dir / ".sdk-state-migrated").touch()
            with (
                patch.object(backend, "CONTROLLER_DIR", controller_dir),
                patch.object(
                    backend,
                    "operation_lock",
                    side_effect=AssertionError("migration took the mutation lock"),
                ),
            ):
                backend.migrate_sdk_sandbox_records()

    def test_controller_record_is_the_only_runtime_index(self) -> None:
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
                self.assertEqual(backend.managed_sandboxes(), [controller])

    def test_sdk_connection_state_is_derived_from_controller_record(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_dir = root / "sdk"
            record_dir = root / "controller" / "sandboxes"
            state_dir.mkdir()
            record_dir.mkdir(parents=True)
            (state_dir / "linux-1.json").write_text(
                json.dumps({"runtime_type": "fleet", "pool_name": "stale-pool"})
            )
            (record_dir / "linux-1.json").write_text(
                json.dumps(
                    {
                        "name": "linux-1",
                        "os": "linux",
                        "pool": "cua-pi-linux",
                    }
                )
            )
            with (
                patch.object(backend, "STATE_DIR", state_dir),
                patch.object(backend, "SANDBOX_RECORD_DIR", record_dir),
            ):
                backend.restore_cua_state("linux-1")

            state = json.loads((state_dir / "linux-1.json").read_text())
            self.assertEqual(state["pool_name"], "cua-pi-linux")


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

    def test_bootstrap_digest_ignores_execution_runtimes(self) -> None:
        with (
            patch.object(backend, "pi_version", return_value="1.2.3"),
            patch.object(backend, "bootstrap_template", return_value="bootstrap"),
            patch.object(backend, "remote_pi_files", return_value={"one": b"1"}),
        ):
            first_bootstrap = backend.bootstrap_digest("linux")
            first_config = backend.runtime_digest(backend.guest_runtime_files())
        with (
            patch.object(backend, "pi_version", return_value="1.2.3"),
            patch.object(backend, "bootstrap_template", return_value="bootstrap"),
            patch.object(backend, "remote_pi_files", return_value={"one": b"2"}),
        ):
            self.assertEqual(backend.bootstrap_digest("linux"), first_bootstrap)
            self.assertNotEqual(
                backend.runtime_digest(backend.guest_runtime_files()), first_config
            )

    def test_linux_preflight_combines_health_config_disk_and_repository(self) -> None:
        with patch.object(
            backend,
            "run_guest_ssh",
            return_value=subprocess.CompletedProcess(
                [], 0, "100.64.0.2|1073741824|1|1\n", ""
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
        self.assertIn("runtimes/cccc/complete", command)
        self.assertIn("df -Pk", command)
        self.assertIn("git ls-remote", command)

    def test_remote_config_archive_is_relative_to_an_immutable_runtime(self) -> None:
        with patch.object(
            backend,
            "remote_pi_files",
            return_value={"example.ts": b"export default 1;\n"},
        ):
            files = backend.guest_runtime_files()
            content = backend.guest_runtime_archive(files)

        self.assertRegex(backend.runtime_digest(files), r"^[0-9a-f]{20}$")
        with tarfile.open(fileobj=io.BytesIO(content), mode="r:gz") as archive:
            self.assertEqual(
                archive.extractfile("agent/example.ts").read(),
                b"export default 1;\n",
            )
            self.assertEqual(
                json.loads(archive.extractfile("agent/settings.json").read()),
                {"packages": []},
            )
            self.assertEqual(
                sorted(archive.getnames()),
                [
                    "agent/cua-runtime.json",
                    "agent/example.ts",
                    "agent/settings.json",
                ],
            )

    def test_remote_config_includes_generic_tool_host(self) -> None:
        files = backend.remote_pi_files()
        self.assertIn("cua-tool-host.mjs", files)
        self.assertNotIn("cua-tool-broker.mjs", files)
        self.assertNotIn("cua-tool-relay.mjs", files)
        host = files["cua-tool-host.mjs"]
        self.assertIn(b'request.type === "execute"', host)
        self.assertIn(b"ERR_CUA_MISSING_TOOLS", host)
        self.assertIn(b"await runtime.dispose()", host)
        self.assertNotIn("auth.json", files)
        self.assertNotIn("models.json", files)
        self.assertNotIn("settings.json", files)

    def test_remote_config_copies_only_declared_regular_tool_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            pi_dir = Path(directory) / ".pi" / "agent"
            extensions = pi_dir / "extensions"
            extensions.mkdir(parents=True)
            declared = extensions / "declared.ts"
            undeclared = extensions / "undeclared.ts"
            declared.write_text("declared")
            undeclared.write_text("undeclared")
            with patch.object(backend, "PI_DIR", pi_dir):
                files = backend.remote_pi_files((str(declared),))

        self.assertEqual(files["extensions/declared.ts"], b"declared")
        self.assertNotIn("extensions/undeclared.ts", files)

    def test_remote_config_rejects_symlinked_tool_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            pi_dir = Path(directory) / ".pi" / "agent"
            extensions = pi_dir / "extensions"
            extensions.mkdir(parents=True)
            secret = Path(directory) / "secret"
            secret.write_text("secret")
            linked = extensions / "linked.ts"
            linked.symlink_to(secret)
            with (
                patch.object(backend, "PI_DIR", pi_dir),
                self.assertRaisesRegex(ValueError, "outside"),
            ):
                backend.remote_pi_files((str(linked),))

    def test_windows_runtime_install_publishes_one_generation(self) -> None:
        with (
            patch.object(backend, "copy_guest_file") as copy,
            patch.object(
                backend,
                "run_guest_ssh",
                return_value=subprocess.CompletedProcess([], 0, "", ""),
            ) as run,
        ):
            backend.install_guest_runtime("windows-1", "windows", b"archive", "1" * 20)

        copy.assert_called_once_with(
            "windows-1",
            "windows",
            b"archive",
            r"C:\Windows\Temp\cua-pi-runtime-11111111111111111111.tgz",
        )
        script = run.call_args.args[2]
        self.assertIn(".11111111111111111111-staging", script)
        self.assertIn("tar.exe -xzf", script)
        self.assertIn("pi.cmd' update --extensions --no-approve", script)
        self.assertLess(script.index("update --extensions"), script.index("complete"))
        self.assertLess(script.index("complete"), script.index("Move-Item -Force"))
        self.assertIn("Select-Object -Skip 3", script)
        self.assertEqual(run.call_args.kwargs["timeout"], 600)

    def test_linux_runtime_install_publishes_after_packages(self) -> None:
        with (
            patch.object(backend, "copy_guest_file"),
            patch.object(
                backend,
                "run_guest_ssh",
                return_value=subprocess.CompletedProcess([], 0, "", ""),
            ) as run,
        ):
            backend.install_guest_runtime("linux-1", "linux", b"archive", "2" * 20)

        script = run.call_args.args[2]
        self.assertIn("pi update --extensions --no-approve", script)
        self.assertLess(script.index("update --extensions"), script.index("complete"))
        self.assertIn('mv "$staging" "$runtime"', script)
        self.assertIn("tail -n +4", script)
        self.assertEqual(run.call_args.kwargs["timeout"], 600)

    def test_guest_bundle_contains_only_requested_tool_packages(self) -> None:
        files = backend.guest_runtime_files(("git:github.com/example/tool-package",))
        content = backend.guest_runtime_archive(files)
        with tarfile.open(fileobj=io.BytesIO(content), mode="r:gz") as archive:
            settings = json.loads(archive.extractfile("agent/settings.json").read())
        self.assertEqual(
            settings,
            {"packages": ["git:github.com/example/tool-package"]},
        )

    def test_guest_bundle_digest_includes_tool_packages(self) -> None:
        self.assertNotEqual(
            backend.runtime_digest(backend.guest_runtime_files()),
            backend.runtime_digest(
                backend.guest_runtime_files(("git:github.com/example/tool-package",))
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

    def test_non_git_directory_has_no_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(backend.discover_workspace(Path(directory)))

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

    def test_workspace_merge_preserves_non_conflicting_local_changes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = self.repository(directory)
            path = root / "tracked.txt"
            path.write_text("first\nsecond\nthird\n")
            subprocess.run(["git", "-C", root, "add", "."], check=True)
            subprocess.run(["git", "-C", root, "commit", "-qm", "initial"], check=True)
            _, baseline = backend.workspace_tree(root)

            path.write_text("sandbox\nsecond\nthird\n")
            _, sandbox_tree = backend.workspace_tree(root)
            sandbox_patch = backend.workspace_patch(root, baseline, sandbox_tree)

            path.write_text("first\nsecond\nlocal\n")
            _, local_tree = backend.workspace_tree(root)
            local_patch, merged_tree = backend.merge_workspace_patch(
                root, local_tree, sandbox_patch
            )
            backend.apply_workspace_patch(root, local_patch, merged_tree)

            self.assertEqual(path.read_text(), "sandbox\nsecond\nlocal\n")

    def test_workspace_apply_rejects_a_changed_local_tree(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = self.repository(directory)
            (root / "tracked.txt").write_text("before\n")
            subprocess.run(["git", "-C", root, "add", "."], check=True)
            subprocess.run(["git", "-C", root, "commit", "-qm", "initial"], check=True)
            _, before = backend.workspace_tree(root)
            (root / "tracked.txt").write_text("changed during sync\n")

            with self.assertRaisesRegex(RuntimeError, "changed while"):
                backend.apply_workspace_patch(root, b"", before, before_tree=before)

    def test_workspace_merge_rejects_conflicts_without_changing_local_files(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = self.repository(directory)
            path = root / "tracked.txt"
            path.write_text("original\n")
            subprocess.run(["git", "-C", root, "add", "."], check=True)
            subprocess.run(["git", "-C", root, "commit", "-qm", "initial"], check=True)
            _, baseline = backend.workspace_tree(root)

            path.write_text("sandbox\n")
            _, sandbox_tree = backend.workspace_tree(root)
            sandbox_patch = backend.workspace_patch(root, baseline, sandbox_tree)

            path.write_text("local\n")
            _, local_tree = backend.workspace_tree(root)
            with self.assertRaisesRegex(RuntimeError, "changes conflict"):
                backend.merge_workspace_patch(root, local_tree, sandbox_patch)

            self.assertEqual(path.read_text(), "local\n")

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

    async def test_activate_execution_without_git_uses_thread_directory(self) -> None:
        execution_id = hashlib.sha256(b"session-1").hexdigest()[:16]
        for profile, remote_cwd in (
            ("linux", f"/home/cua/.cua-pi/executions/{execution_id}"),
            ("windows", rf"C:\Users\cua\.cua-pi\executions\{execution_id}"),
        ):
            with self.subTest(profile=profile):
                preflight = backend.GuestRuntimePreflight("100.64.0.2", True)
                with (
                    patch.object(
                        backend,
                        "managed_sandboxes",
                        return_value=[{"name": f"{profile}-1", "os": profile}],
                    ),
                    patch.object(backend, "inspect_workspace", return_value=None),
                    patch.object(
                        backend, "guest_runtime_preflight", return_value=preflight
                    ),
                    patch.object(backend, "guest_preflight") as full_preflight,
                    patch.object(backend, "prepare_workspace") as prepare,
                    patch.object(
                        backend,
                        "run_guest_ssh",
                        return_value=subprocess.CompletedProcess([], 0, "", ""),
                    ) as run,
                ):
                    result = await backend.activate_execution(
                        f"{profile}-1", "/not-a-repository", "session-1"
                    )

                self.assertEqual(result["remote_cwd"], remote_cwd)
                self.assertNotIn("workspace_state", result)
                full_preflight.assert_not_called()
                prepare.assert_not_called()
                self.assertIn(execution_id, run.call_args.args[2])

    async def test_non_git_runtime_install_requires_free_disk(self) -> None:
        preflight = backend.GuestRuntimePreflight("100.64.0.2", False, 1024)
        with (
            patch.object(
                backend,
                "managed_sandboxes",
                return_value=[{"name": "linux-1", "os": "linux"}],
            ),
            patch.object(backend, "inspect_workspace", return_value=None),
            patch.object(backend, "guest_runtime_preflight", return_value=preflight),
            patch.object(backend, "install_guest_runtime") as install,
            self.assertRaisesRegex(RuntimeError, "requires 1 GiB free"),
        ):
            await backend.activate_execution(
                "linux-1", "/not-a-repository", "session-1"
            )

        install.assert_not_called()

    def test_non_git_execution_ids_do_not_share_a_directory(self) -> None:
        with patch.object(
            backend,
            "run_guest_ssh",
            return_value=subprocess.CompletedProcess([], 0, "", ""),
        ):
            first = backend.execution_directory(
                "100.64.0.2", "windows", hashlib.sha256(b"thread-1").hexdigest()[:16]
            )
            second = backend.execution_directory(
                "100.64.0.2", "windows", hashlib.sha256(b"thread-2").hexdigest()[:16]
            )

        self.assertNotEqual(first, second)

    async def test_matching_generation_resume_defers_remote_checks_to_the_host(
        self,
    ) -> None:
        resume = backend.SandboxResumeSource(
            os="linux",
            remoteCwd="/home/cua/workspaces/existing",
        )
        with (
            patch.object(
                backend,
                "managed_sandboxes",
                return_value=[
                    {
                        "name": "linux-1",
                        "os": "linux",
                        "address": "100.64.0.2",
                        "generation": "node-1",
                    }
                ],
            ),
            patch.object(backend, "discover_workspace") as discover,
            patch.object(backend, "guest_runtime_preflight") as preflight,
        ):
            result = await backend.activate_execution(
                "linux-1",
                "/local",
                "session-1",
                resume=resume,
                force_reconcile=False,
                sandbox_generation="node-1",
            )

        self.assertEqual(result["address"], "100.64.0.2")
        self.assertEqual(result["remote_cwd"], resume["remoteCwd"])
        self.assertEqual(result["sandbox_generation"], "node-1")
        self.assertFalse(result["reconciled"])
        discover.assert_not_called()
        preflight.assert_not_called()

    async def test_replacement_generation_bypasses_the_matching_generation_resume(
        self,
    ) -> None:
        resume = backend.SandboxResumeSource(os="linux", remoteCwd="/home/cua")
        preflight = backend.GuestRuntimePreflight("100.64.0.2", True)
        with (
            patch.object(
                backend,
                "managed_sandboxes",
                return_value=[
                    {
                        "name": "linux-1",
                        "os": "linux",
                        "address": "100.64.0.2",
                        "generation": "node-2",
                    }
                ],
            ),
            patch.object(
                backend, "guest_runtime_preflight", return_value=preflight
            ) as check,
            patch.object(
                backend,
                "run_guest_ssh",
                return_value=subprocess.CompletedProcess([], 0, "", ""),
            ),
        ):
            result = await backend.activate_execution(
                "linux-1",
                "/local",
                "session-1",
                resume=resume,
                force_reconcile=False,
                sandbox_generation="node-1",
            )

        self.assertTrue(result["reconciled"])
        self.assertEqual(result["sandbox_generation"], "node-2")
        check.assert_called_once()

    async def test_activate_execution_resumes_without_git_state(self) -> None:
        resume = backend.SandboxResumeSource(
            os="linux",
            remoteCwd="/home/cua",
        )
        preflight = backend.GuestRuntimePreflight("100.64.0.2", True)
        with (
            patch.object(
                backend,
                "managed_sandboxes",
                return_value=[{"name": "linux-1", "os": "linux"}],
            ),
            patch.object(backend, "inspect_workspace") as inspect,
            patch.object(backend, "guest_runtime_preflight", return_value=preflight),
            patch.object(
                backend,
                "run_guest_ssh",
                return_value=subprocess.CompletedProcess([], 0, "", ""),
            ),
        ):
            result = await backend.activate_execution(
                "linux-1", "/local", "session-1", resume=resume
            )

        execution_id = hashlib.sha256(b"session-1").hexdigest()[:16]
        self.assertEqual(
            result["remote_cwd"], f"/home/cua/.cua-pi/executions/{execution_id}"
        )
        inspect.assert_not_called()

    async def test_activate_execution_connects_capture_prepare_and_restore(
        self,
    ) -> None:
        transfer = backend.WorkspaceTransfer(self.state, b"final", "2" * 40)
        preflight = backend.GuestPreflight("100.64.0.2", 2**30, True, True)
        with (
            patch.object(
                backend,
                "managed_sandboxes",
                return_value=[{"name": "linux-1", "os": "linux"}],
            ),
            patch.object(backend, "inspect_workspace", return_value=self.repository),
            patch.object(backend, "capture_sandbox_workspace", return_value=transfer),
            patch.object(backend, "guest_preflight", return_value=preflight),
            patch.object(backend, "install_guest_runtime") as sync_config,
            patch.object(
                backend,
                "prepare_workspace",
                AsyncMock(return_value="/remote/workspace"),
            ) as prepare,
            patch.object(backend, "restore_sandbox_workspace") as restore,
        ):
            result = await backend.activate_execution(
                "linux-1", "/local", "session-1", self.source
            )

        self.assertEqual(result["workspace_state"], self.state)
        self.assertEqual(prepare.await_args.args[2].commit, self.state["commit"])
        self.assertTrue(prepare.await_args.kwargs["repository_available"])
        sync_config.assert_not_called()
        restore.assert_called_once()

    async def test_activate_execution_requests_repair_without_loading_the_sdk(
        self,
    ) -> None:
        transfer = backend.WorkspaceTransfer(self.state, b"final", "2" * 40)
        with (
            patch.object(
                backend,
                "managed_sandboxes",
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
            await backend.activate_execution(
                "linux-1", "/local", "session-1", self.source
            )
        connect.assert_not_called()

    async def test_activate_execution_syncs_one_mismatched_guest_bundle(self) -> None:
        transfer = backend.WorkspaceTransfer(self.state, b"final", "2" * 40)
        preflight = backend.GuestPreflight("100.64.0.2", 2**30, False, True)
        with (
            patch.object(
                backend,
                "managed_sandboxes",
                return_value=[{"name": "linux-1", "os": "linux"}],
            ),
            patch.object(backend, "inspect_workspace", return_value=self.repository),
            patch.object(backend, "capture_sandbox_workspace", return_value=transfer),
            patch.object(backend, "guest_preflight", return_value=preflight),
            patch.object(backend, "guest_runtime_files", return_value={"x": b""}),
            patch.object(backend, "runtime_digest", return_value="c" * 20),
            patch.object(backend, "guest_runtime_archive", return_value=b"bundle"),
            patch.object(backend, "install_guest_runtime") as sync_config,
            patch.object(
                backend,
                "prepare_workspace",
                AsyncMock(return_value="/remote/workspace"),
            ),
            patch.object(backend, "restore_sandbox_workspace"),
        ):
            await backend.activate_execution(
                "linux-1", "/local", "session-1", self.source
            )
        sync_config.assert_called_once_with("100.64.0.2", "linux", b"bundle", "c" * 20)

    async def test_activate_execution_stops_before_mutating_a_low_disk_guest(
        self,
    ) -> None:
        transfer = backend.WorkspaceTransfer(self.state, b"final", "2" * 40)
        preflight = backend.GuestPreflight("100.64.0.2", 512 * 1024**2, True, True)
        with (
            patch.object(
                backend,
                "managed_sandboxes",
                return_value=[{"name": "linux-1", "os": "linux"}],
            ),
            patch.object(backend, "inspect_workspace", return_value=self.repository),
            patch.object(backend, "capture_sandbox_workspace", return_value=transfer),
            patch.object(backend, "guest_preflight", return_value=preflight),
            patch.object(backend, "prepare_workspace") as prepare,
            patch.object(backend, "cleanup_workspace_root") as cleanup,
            self.assertRaisesRegex(RuntimeError, "requires 1 GiB free"),
        ):
            await backend.activate_execution(
                "linux-1", "/local", "session-1", self.source
            )
        prepare.assert_not_called()
        cleanup.assert_not_called()

    async def test_activate_execution_reuses_an_existing_saved_workspace(self) -> None:
        preflight = backend.GuestPreflight("100.64.0.2", 2**30, True, True)
        with (
            patch.object(
                backend,
                "managed_sandboxes",
                return_value=[{"name": "linux-1", "os": "linux"}],
            ),
            patch.object(backend, "inspect_workspace", return_value=self.repository),
            patch.object(backend, "guest_preflight", return_value=preflight),
            patch.object(backend, "sandbox_workspace_exists", return_value=True),
            patch.object(backend, "capture_local_workspace") as capture,
            patch.object(backend, "prepare_workspace") as prepare,
        ):
            result = await backend.activate_execution(
                "linux-1", "/local", "session-1", resume=self.source
            )

        self.assertEqual(result["address"], "100.64.0.2")
        self.assertEqual(result["remote_cwd"], self.source["remoteCwd"])
        self.assertEqual(result["workspace_state"], self.state)
        capture.assert_not_called()
        prepare.assert_not_called()

    async def test_activate_execution_reconstructs_a_missing_saved_workspace(
        self,
    ) -> None:
        transfer = backend.WorkspaceTransfer(self.state, b"final", "2" * 40)
        preflight = backend.GuestPreflight("100.64.0.2", 2**30, True, True)
        with (
            patch.object(
                backend,
                "managed_sandboxes",
                return_value=[{"name": "linux-1", "os": "linux"}],
            ),
            patch.object(backend, "inspect_workspace", return_value=self.repository),
            patch.object(backend, "guest_preflight", return_value=preflight),
            patch.object(backend, "sandbox_workspace_exists", return_value=False),
            patch.object(backend, "capture_local_workspace", return_value=transfer),
            patch.object(
                backend,
                "prepare_workspace",
                AsyncMock(return_value="/remote/workspace"),
            ) as prepare,
            patch.object(backend, "restore_sandbox_workspace"),
        ):
            result = await backend.activate_execution(
                "linux-1", "/local", "session-1", resume=self.source
            )

        self.assertEqual(result["remote_cwd"], "/remote/workspace")
        prepare.assert_awaited_once()

    async def test_activate_execution_removes_an_incomplete_destination(self) -> None:
        transfer = backend.WorkspaceTransfer(self.state, b"final", "2" * 40)
        preflight = backend.GuestPreflight("100.64.0.2", 2**30, True, True)
        with (
            patch.object(
                backend,
                "managed_sandboxes",
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
            await backend.activate_execution(
                "linux-1", "/local", "session-1", self.source
            )

        workspace_id = hashlib.sha256(b"session-1").hexdigest()[:16]
        cleanup.assert_called_once_with(
            "100.64.0.2", "linux", f"/home/cua/workspaces/{workspace_id}"
        )

    async def test_activate_dispatch_does_not_load_fleet_credentials(self) -> None:
        with (
            patch.object(backend, "configure_fleet_auth") as configure,
            patch.object(
                backend,
                "activate_execution",
                AsyncMock(return_value={"remote_cwd": "/workspace"}),
            ) as prepare,
        ):
            result = await backend.dispatch(
                {
                    "action": "activate_execution",
                    "name": "linux-1",
                    "source_cwd": "/local",
                    "execution_id": "session-1",
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
                    [], 0, "healthy|1073741824|1|1\n", ""
                ),
            ) as run,
            patch.object(backend, "windows_broker_ready", return_value=True) as broker,
        ):
            result = backend.guest_preflight(
                "100.64.0.2",
                "windows",
                "https://example.com/repo.git",
                "a" * 40,
                "cccc",
            )
            health = backend.windows_ssh_health_script()

        self.assertEqual(
            result,
            backend.GuestPreflight("100.64.0.2", 1073741824, True, True),
        )
        encoded = run.call_args.args[2].rsplit(" ", 1)[-1]
        script = backend.base64.b64decode(encoded).decode("utf-16le")
        self.assertTrue(script.startswith(health))
        self.assertNotIn("Get-Service sshd", script)
        self.assertNotIn("Get-ScheduledTask", script)
        self.assertNotIn("TcpClient", script)
        self.assertNotIn("tailscale.exe", script)
        broker.assert_called_once_with("100.64.0.2")

    def test_controller_probes_the_broker_forwarding_protocol(self) -> None:
        response = json.dumps({"type": "broker_ready"}) + "\n"
        with patch.object(
            backend.subprocess,
            "run",
            return_value=subprocess.CompletedProcess([], 0, response, ""),
        ) as run:
            self.assertTrue(backend.windows_broker_ready("100.64.0.2"))

        self.assertIn("-W", run.call_args.args[0])
        self.assertIn("127.0.0.1:43121", run.call_args.args[0])
        self.assertEqual(run.call_args.kwargs["input"], '{"type":"health"}\n')

    def test_ensure_health_uses_the_same_broker_contract(self) -> None:
        with patch.object(backend, "bootstrap_digest", return_value="b" * 20):
            command = backend.guest_health_command("windows")
            health = backend.windows_machine_health_script()

        encoded = command.rsplit(" ", 1)[-1]
        script = backend.base64.b64decode(encoded).decode("utf-16le")
        self.assertTrue(script.startswith(health))
        self.assertIn("Get-ScheduledTask -TaskName 'CuaPiDesktopToolBroker'", script)
        self.assertIn("TcpClient]::new('127.0.0.1',43121)", script)
        self.assertIn('{"type":"broker_ready"}', script)
        self.assertIn("tailscale.exe", script)

    def test_runtime_preflight_rejects_an_unavailable_broker(self) -> None:
        with (
            patch.object(
                backend,
                "run_guest_ssh",
                return_value=subprocess.CompletedProcess([], 0, "healthy|1\n", ""),
            ),
            patch.object(backend, "windows_broker_ready", return_value=False),
        ):
            result = backend.guest_runtime_preflight("100.64.0.2", "windows", "c" * 20)

        self.assertIsNone(result)

    def test_bootstrap_disables_the_shutdown_event_tracker(self) -> None:
        script = backend.bootstrap_template("windows")

        self.assertIn("Windows NT\\Reliability", script)
        self.assertIn("-Name ShutdownReasonOn -Value 0", script)

    def test_bootstrap_regenerates_windows_ssh_host_keys(self) -> None:
        script = backend.bootstrap_template("windows")

        self.assertIn("ssh_host_*", script)
        self.assertIn('ssh-keygen.exe" -q -t ed25519', script)
        self.assertIn("'/remove:g', \"*$bootstrapSid\"", script)
        self.assertLess(script.index("ssh-keygen.exe"), script.index("Start-Service"))

    def test_bootstrap_registers_an_interactive_logon_task(self) -> None:
        script = backend.bootstrap_template("windows")

        self.assertIn("New-ScheduledTaskPrincipal", script)
        self.assertIn("-LogonType Interactive", script)
        self.assertIn("cua-tool-broker.mjs", script)
        self.assertIn("New-ScheduledTaskAction -Execute $node", script)
        self.assertNotIn("wscript.exe", script)
        self.assertIn("PermitOpen 127.0.0.1:43121", script)
        self.assertNotIn("$brokerToken", script)
        self.assertNotIn("RandomNumberGenerator", script)
        self.assertIn("Start-ScheduledTask -TaskName CuaPiDesktopToolBroker", script)
        self.assertLess(
            script.index("Stop-ScheduledTask"),
            script.index("Register-ScheduledTask"),
        )
        self.assertIn("did not release 127.0.0.1:43121", script)
        self.assertIn('cua_sandbox with {"action":"ensure"', script)

    def test_bootstrap_owns_only_the_desktop_broker(self) -> None:
        script = backend.bootstrap_template("windows")

        self.assertNotIn("Invoke-Icacls @($cuaHome", script)
        self.assertNotIn("$extensions", script)
        self.assertNotIn("cua-tool-host.mjs", script)
        self.assertIn("Remove-Item -Force -ErrorAction SilentlyContinue", script)
        self.assertIn("cua-tool-relay.mjs", script)
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
            patch.object(backend, "managed_sandboxes", return_value=[]),
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
        self.assertIn("cua-sandbox==0.4.3", command)


if __name__ == "__main__":
    unittest.main()
