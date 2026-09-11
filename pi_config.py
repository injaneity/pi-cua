from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

PRIVATE_FILES = {"auth.json", "models.json", "models-store.json", "trust.json"}
PRIVATE_KEYS = re.compile(
    r"^auth$|password|secret|credential|authorization|apikey|privatekey|cookie|token$",
    re.IGNORECASE,
)
CONTROLLER_SETTINGS = {
    "packages",
    "extensions",
    "skills",
    "prompts",
    "themes",
    "defaultProjectTrust",
    "bashCommandPrefix",
    "shellPath",
    "defaultProvider",
    "defaultModel",
    "defaultThinkingLevel",
    "compaction",
    "enabledModels",
}
OMIT = object()


def portable_config(
    pi_dir: Path,
    skill_files: tuple[str, ...] = (),
    documentation_root: Path | None = None,
    project_dir: Path | None = None,
) -> tuple[dict[str, bytes], dict[str, str], list[str]]:
    files: dict[str, bytes] = {}
    paths: dict[str, str] = {}
    warnings: list[str] = []
    total = 0
    executables: list[str] = []

    def add(source: Path, destination: str) -> bool:
        nonlocal total
        if source.is_symlink() or not source.is_file():
            warnings.append(f"not transferred: non-regular file {source}")
            return False
        if source.stat().st_size > 8 * 1024 * 1024:
            warnings.append(f"not transferred: file exceeds 8 MiB: {source}")
            return False
        data = source.read_bytes()
        if re.search(rb"-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----", data):
            warnings.append(f"not transferred: private key material in {source}")
            return False
        total += len(data)
        if total > 64 * 1024 * 1024:
            raise ValueError("portable Pi configuration exceeds 64 MiB")
        if source.suffix == ".json":
            try:
                cleaned = scrub(json.loads(data), str(source))
            except (ValueError, UnicodeError):
                warnings.append(f"not transferred: invalid JSON resource {source}")
                return False
            if cleaned is OMIT:
                return False
            data = json.dumps(cleaned, indent=2).encode() + b"\n"
        files[destination] = data
        if source.stat().st_mode & 0o111:
            executables.append(destination)
        return True

    def scrub(value: object, location: str) -> object:
        if isinstance(value, dict):
            result = {}
            for key, item in value.items():
                if PRIVATE_KEYS.search(re.sub(r"[^a-zA-Z]", "", key)):
                    warnings.append(
                        f"controller-only credential setting: {location}.{key}"
                    )
                    continue
                cleaned = scrub(item, f"{location}.{key}")
                if cleaned is not OMIT:
                    result[key] = cleaned
            return result
        if isinstance(value, list):
            cleaned = [scrub(item, location) for item in value]
            return [item for item in cleaned if item is not OMIT]
        if isinstance(value, str):
            if value.startswith(("/", "~/")) or re.match(r"^[A-Za-z]:[\\/]", value):
                warnings.append(f"controller-only absolute path setting: {location}")
                return OMIT
            if re.search(
                r"-----BEGIN .*PRIVATE KEY-----|\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}|://[^/\s:@]+:[^/\s@]+@|[?&](?:api[_-]?key|token|secret|password)=",
                value,
                re.IGNORECASE,
            ):
                warnings.append(f"controller-only credential value: {location}")
                return OMIT
        return value

    def merge(base: object, update: object) -> object:
        if not isinstance(base, dict) or not isinstance(update, dict):
            return update
        return {
            **base,
            **{key: merge(base.get(key), value) for key, value in update.items()},
        }

    configured_skills: list[str] = []
    settings = {}
    config_roots = [pi_dir, *([project_dir / ".pi"] if project_dir else [])]
    for source in [
        file for root in config_roots for file in sorted(root.glob("*.json"))
    ]:
        if source.name in PRIVATE_FILES or PRIVATE_KEYS.search(source.stem):
            warnings.append(f"controller-only file: {source.name}")
            continue
        if source.is_symlink():
            warnings.append(f"not transferred: symlink {source}")
            continue
        if source.stat().st_size > 1024 * 1024:
            warnings.append(f"not transferred: JSON exceeds 1 MiB: {source.name}")
            continue
        try:
            value = json.loads(source.read_text())
        except (ValueError, UnicodeError) as error:
            raise ValueError(f"invalid Pi configuration: {source}") from error
        if source.name == "settings.json":
            if not isinstance(value, dict):
                raise ValueError("Pi settings.json must contain an object")
            settings = value
            for item in settings.get("skills", []):
                if isinstance(item, str) and not any(
                    character in item for character in "!*?{}"
                ):
                    path = Path(item).expanduser()
                    path = path if path.is_absolute() else source.parent / path
                    if path.exists():
                        configured_skills.append(str(path.absolute()))
                    else:
                        warnings.append(f"configured skill path unavailable: {path}")
            value = {
                key: item
                for key, item in value.items()
                if key not in CONTROLLER_SETTINGS
            }
            for key in sorted(CONTROLLER_SETTINGS & settings.keys()):
                warnings.append(
                    f"controller setting adapted or kept local: settings.json.{key}"
                )
        cleaned = scrub(value, source.name)
        if cleaned is not OMIT:
            cleaned = merge(json.loads(files.get(source.name, b"{}")), cleaned)
            files[source.name] = json.dumps(cleaned, indent=2).encode() + b"\n"
            paths[str(source)] = source.name
            total += len(files[source.name])
            if total > 64 * 1024 * 1024:
                raise ValueError("portable Pi configuration exceeds 64 MiB")

    roots = [
        (pi_dir / "skills", "skills/global"),
        (pi_dir.parent.parent / ".agents" / "skills", "skills/shared"),
    ]
    if project_dir:
        roots.extend(
            [
                (project_dir / ".pi" / "skills", "skills/project"),
                (project_dir / ".agents" / "skills", "skills/project-shared"),
            ]
        )
    for entry in [*skill_files, *configured_skills]:
        source = Path(entry).expanduser()
        if (
            not source.is_absolute()
            or not source.exists()
            or (source.is_symlink() and not source.is_dir())
        ):
            raise ValueError(f"invalid declared skill file: {entry}")
        if source == source.resolve() and any(
            source.is_relative_to(root) for root, _ in roots
        ):
            continue
        alias = source if source.is_dir() else source.parent
        root = alias.resolve()
        destination = next(
            (value for previous, value in roots if root == previous), None
        )
        if destination is None:
            key = hashlib.sha256(str(root).encode()).hexdigest()[:16]
            destination = f"skills/declared-{key}"
            roots.append((root, destination))
        paths[str(alias)] = destination

    skill_roots = []
    extra_roots = [
        (pi_dir / name, name) for name in ("themes", "prompts", "config", "configs")
    ]
    if documentation_root is not None:
        extra_roots.extend(
            (documentation_root / name, f"resources/pi/{name}")
            for name in ("docs", "examples")
        )
        readme = documentation_root / "README.md"
        if readme.is_file() and add(readme, "resources/pi/README.md"):
            paths[str(readme)] = "resources/pi/README.md"
    for root, destination in [*roots, *extra_roots]:
        if not root.exists():
            continue
        if root.is_symlink():
            warnings.append(f"not transferred: symlink skill directory {root}")
            continue
        paths[str(root)] = destination
        if (root, destination) in roots:
            skill_roots.append(f"./{destination}")
        for source in sorted(root.rglob("*")):
            relative = source.relative_to(root)
            if any(
                part in {".git", "node_modules", "__pycache__", ".venv", ".cache"}
                for part in relative.parts
            ):
                continue
            if source.is_symlink():
                declared = next(
                    (
                        value
                        for previous, value in roots
                        if previous == source.resolve()
                    ),
                    None,
                )
                if declared is not None:
                    paths[str(source)] = declared
                elif str(source) not in paths:
                    warnings.append(f"not transferred: symlink {source}")
                continue
            if not source.is_file():
                continue
            if (
                source.name in PRIVATE_FILES
                or source.name.startswith(".env")
                or source.suffix in {".pem", ".key", ".p12", ".pfx"}
            ):
                warnings.append(f"controller-only skill file: {source}")
                continue
            add(source, f"{destination}/{relative.as_posix()}")

    final_settings = json.loads(files.get("settings.json", b"{}"))
    final_settings["skills"] = skill_roots
    files["settings.json"] = json.dumps(final_settings, indent=2).encode() + b"\n"
    files["cua-config-paths.json"] = json.dumps(paths, sort_keys=True).encode() + b"\n"
    files["cua-config-executables.json"] = (
        json.dumps(sorted(executables)).encode() + b"\n"
    )
    return files, paths, warnings
