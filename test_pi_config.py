import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

import backend
from pi_config import portable_config


class PortableConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self.home = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.agent = self.home / ".pi" / "agent"
        self.agent.mkdir(parents=True)

    def write(self, path: Path, content: str) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        return path

    def test_fff_override_and_portable_settings_are_inherited(self) -> None:
        self.write(self.agent / "pi-fff.json", '{"mode":"override"}')
        self.write(
            self.agent / "settings.json",
            json.dumps(
                {
                    "theme": "dark",
                    "packages": ["controller"],
                    "extensions": ["/local/controller.ts"],
                    "defaultProjectTrust": True,
                    "maxTokens": 100,
                }
            ),
        )
        files, paths, _ = portable_config(self.agent)
        self.assertEqual(json.loads(files["pi-fff.json"]), {"mode": "override"})
        self.assertEqual(
            json.loads(files["settings.json"]),
            {"theme": "dark", "maxTokens": 100, "skills": []},
        )
        self.assertEqual(paths[str(self.agent / "pi-fff.json")], "pi-fff.json")

    def test_credentials_trust_and_model_stores_never_cross(self) -> None:
        for name in ("auth.json", "trust.json", "models.json", "models-store.json"):
            self.write(self.agent / name, "not even valid JSON: PRIVATE")
        self.write(
            self.agent / "custom.json",
            json.dumps(
                {
                    "enabled": True,
                    "api_key": "PRIVATE",
                    "headers": {"Authorization": "PRIVATE", "X-Api-Key": "PRIVATE"},
                    "env": {"CLIENT_SECRET": "PRIVATE"},
                    "database": "/controller/private",
                }
            ),
        )
        files, _, warnings = portable_config(self.agent)
        self.assertNotIn(b"PRIVATE", b"".join(files.values()))
        self.assertNotIn("PRIVATE", "\n".join(warnings))
        self.assertTrue(json.loads(files["custom.json"])["enabled"])
        self.assertNotIn("database", json.loads(files["custom.json"]))
        self.assertTrue(any("absolute path" in item for item in warnings))
        for name in ("auth.json", "trust.json", "models.json", "models-store.json"):
            self.assertNotIn(name, files)

    def test_skills_helpers_and_executable_modes_survive_transfer(self) -> None:
        root = self.agent / "skills" / "demo"
        self.write(root / "SKILL.md", "read scripts/helper.sh")
        helper = self.write(root / "scripts" / "helper.sh", "echo portable\n")
        helper.chmod(0o755)
        self.write(root / ".env", "PRIVATE")
        self.write(root / "node_modules" / "cache", "PRIVATE")
        files, paths, warnings = portable_config(self.agent)
        self.assertEqual(
            files["skills/global/demo/scripts/helper.sh"], b"echo portable\n"
        )
        self.assertEqual(paths[str(self.agent / "skills")], "skills/global")
        self.assertNotIn(b"PRIVATE", b"".join(files.values()))
        self.assertTrue(any(".env" in item for item in warnings))
        with tarfile.open(
            fileobj=io.BytesIO(backend.guest_runtime_archive(files)), mode="r:gz"
        ) as archive:
            self.assertEqual(
                archive.getmember("agent/skills/global/demo/scripts/helper.sh").mode,
                0o755,
            )

    def test_declared_package_skills_are_copied_with_relative_resources(self) -> None:
        root = self.home / "package" / "demo"
        skill = self.write(root / "SKILL.md", "see guide.md")
        self.write(root / "guide.md", "guide")
        files, paths, _ = portable_config(self.agent, (str(skill),))
        self.assertEqual(files[paths[str(root)] + "/guide.md"], b"guide")
        self.assertEqual(
            json.loads(files["settings.json"])["skills"], ["./" + paths[str(root)]]
        )

    def test_only_explicitly_selected_project_configuration_is_inherited(self) -> None:
        project = self.home / "project"
        self.write(
            self.agent / "pi-fff.json", '{"mode":"override","warnHomeDirScan":false}'
        )
        self.write(project / ".pi" / "pi-fff.json", '{"mode":"tools-and-ui"}')
        self.write(
            project / ".agents" / "skills" / "demo" / "SKILL.md", "project skill"
        )
        files, _, _ = portable_config(self.agent)
        self.assertEqual(json.loads(files["pi-fff.json"])["mode"], "override")
        files, _, _ = portable_config(self.agent, project_dir=project)
        self.assertEqual(
            json.loads(files["pi-fff.json"]),
            {"mode": "tools-and-ui", "warnHomeDirScan": False},
        )
        self.assertIn("skills/project-shared/demo/SKILL.md", files)

    def test_declared_symlink_skill_root_is_copied_without_following_other_links(
        self,
    ) -> None:
        root = self.home / "package" / "driver"
        skill = self.write(root / "SKILL.md", "driver")
        self.write(root / "guide.md", "guide")
        alias = self.home / ".agents" / "skills" / "driver"
        alias.parent.mkdir(parents=True)
        alias.symlink_to(root, target_is_directory=True)
        for declared in (skill, alias / "SKILL.md"):
            files, paths, warnings = portable_config(self.agent, (str(declared),))
            self.assertEqual(paths[str(alias)], paths[str(root.resolve())])
            self.assertEqual(files[paths[str(alias)] + "/guide.md"], b"guide")
            self.assertFalse(any(str(alias) in item for item in warnings))

    def test_config_and_skill_changes_invalidate_runtime_but_auth_changes_do_not(
        self,
    ) -> None:
        skill = self.write(self.agent / "skills" / "demo" / "SKILL.md", "one")
        auth = self.write(self.agent / "auth.json", "PRIVATE")

        def digest() -> str:
            return backend.runtime_digest(portable_config(self.agent)[0])

        before = digest()
        auth.write_text("OTHER PRIVATE")
        self.assertEqual(digest(), before)
        skill.write_text("two")
        self.assertNotEqual(digest(), before)
        before = digest()
        self.write(self.agent / "pi-fff.json", '{"mode":"override"}')
        self.assertNotEqual(digest(), before)

    def test_symlinks_do_not_exfiltrate_outside_resources(self) -> None:
        secret = self.write(self.home / "private", "PRIVATE")
        root = self.agent / "skills" / "demo"
        self.write(root / "SKILL.md", "demo")
        (root / "external").symlink_to(secret)
        files, _, warnings = portable_config(self.agent)
        self.assertNotIn(b"PRIVATE", b"".join(files.values()))
        self.assertTrue(any("symlink" in item for item in warnings))

    def test_documentation_themes_and_prompts_have_guest_paths(self) -> None:
        sdk = self.home / "sdk"
        self.write(sdk / "README.md", "docs/extensions.md")
        self.write(sdk / "docs" / "extensions.md", "api")
        self.write(self.agent / "themes" / "custom.json", '{"name":"custom"}')
        self.write(self.agent / "prompts" / "check.md", "check")
        files, paths, _ = portable_config(self.agent, documentation_root=sdk)
        self.assertEqual(files[paths[str(sdk / "docs")] + "/extensions.md"], b"api")
        self.assertIn("themes/custom.json", files)
        self.assertIn("prompts/check.md", files)

    def test_invalid_config_is_an_explicit_failure(self) -> None:
        self.write(self.agent / "pi-fff.json", "not JSON")
        with self.assertRaisesRegex(ValueError, "invalid Pi configuration"):
            portable_config(self.agent)


if __name__ == "__main__":
    unittest.main()
