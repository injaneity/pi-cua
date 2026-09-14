import json
import shlex
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

import backend

profile = sys.argv[1]
name = {"linux": "linux-1", "macos": "mac-studio", "windows": "windows-1"}[profile]
box = next(item for item in backend.managed_sandboxes() if item["name"] == name)
identity = uuid.uuid4().hex[:16]
remote = (
    rf"C:\Users\cua\workspace-test-{identity}"
    if profile == "windows"
    else f"{backend.guest_home(profile)}/workspaces/{identity}"
)
setup = """const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');const root=process.argv[1];fs.mkdirSync(root);const git=(...args)=>cp.execFileSync('git',['-C',root,...args]);git('init','-q');git('config','user.name','pi-cua-test');git('config','user.email','test@example.invalid');fs.writeFileSync(path.join(root,'.gitignore'),'shared/\\n');git('add','.');git('-c','commit.gpgsign=false','commit','-qm','baseline');"""


def node(code: str) -> str:
    if profile == "windows":
        return (
            "& 'C:\\cua\\node\\node.exe' -e "
            + backend.powershell_literal(code)
            + " "
            + backend.powershell_literal(remote)
        )
    executable = "/usr/local/bin/node" if profile == "macos" else "node"
    return executable + " -e " + shlex.quote(code) + " " + shlex.quote(remote)


with (
    tempfile.TemporaryDirectory(prefix="cua-object-smoke-") as directory,
    backend.ssh_session(),
):
    root = Path(directory)

    def git(*args: str) -> None:
        subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)

    git("init", "-q")
    git("config", "user.name", "pi-cua-test")
    git("config", "user.email", "test@example.invalid")
    (root / ".gitignore").write_text("shared/\n")
    git("add", ".")
    git("-c", "commit.gpgsign=false", "commit", "-qm", "baseline")
    repository = backend.WorkspaceRepository(
        root, Path("."), "fixture", backend.git_output(root, "rev-parse", "HEAD")
    )
    baseline = backend.workspace_tree(root)[1]
    (root / "shared").mkdir()
    executable = root / "shared" / "journal.test.cjs"
    executable.write_text("fixture\n")
    executable.chmod(0o755)
    git("add", "-f", str(executable))
    (root / "binary.bin").write_bytes(bytes([0, 255, 13, 10, 128]))
    final = backend.workspace_tree(root)[1]
    state = backend.WorkspaceState(
        version=1,
        localRoot=str(root),
        commit=repository.commit,
        commitTree=baseline,
        baselineTree=baseline,
    )
    backend.run_guest_ssh(
        box["address"], profile, node(setup), timeout=60, report=False
    )
    try:
        timings = {}
        backend.transfer_workspace_objects(
            box["address"],
            profile,
            remote,
            repository,
            backend.WorkspaceTransfer(state, b"", final),
            None,
            identity * 2,
            timings,
            exclude=baseline,
        )
        assert backend.remote_workspace_tree(box["address"], profile, remote) == final
        captured = backend.capture_sandbox_workspace(
            backend.SandboxWorkspaceSource(
                address=box["address"], os=profile, remoteCwd=remote, state=state
            ),
            include_patch=False,
            exclude=baseline,
        )
        assert captured.final_tree == final
        assert captured.baseline_in_source
        print(
            json.dumps({"os": profile, "verified_tree": final, "timings": timings}),
            flush=True,
        )
    finally:
        backend.run_guest_ssh(
            box["address"],
            profile,
            node("require('node:fs').rmSync(process.argv[1],{recursive:true});"),
            timeout=30,
            report=False,
        )
