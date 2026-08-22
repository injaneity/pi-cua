"""Provision CUA claims and stage Pi sessions for the TypeScript extension.

CUA publishes a Python SDK but no TypeScript SDK. This process boundary keeps Fleet
credentials and platform bootstrap logic out of the Pi extension. Every invocation
accepts one JSON argument and writes one JSON result to stdout; diagnostics stay on
stderr. Controller records are canonical; Fleet SDK connection state is materialized
only at its API boundary.
"""

from __future__ import annotations

import asyncio
import base64
import fcntl
import hashlib
import io
import json
import os
import re
import shlex
import signal
import ssl
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
import zipfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, TypedDict, cast
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


def tls_context() -> ssl.SSLContext:
    if os.environ.get("SSL_CERT_FILE"):
        return ssl.create_default_context()
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        fallback = "/etc/ssl/cert.pem"
        return ssl.create_default_context(
            cafile=fallback if os.path.exists(fallback) else None
        )


TLS_CONTEXT = tls_context()

HOME = Path.home()
STATE_DIR = HOME / ".cua" / "sandboxes"
PI_DIR = HOME / ".pi" / "agent"
CONTROLLER_DIR = HOME / ".cua" / "pi-controller"
SANDBOX_RECORD_DIR = CONTROLLER_DIR / "sandboxes"
CONTROLLER_LOCK = CONTROLLER_DIR / "controller.lock"
CURRENT_PHASE = "startup"


class OperationCancelled(RuntimeError):
    pass


class SandboxRepairRequired(RuntimeError):
    pass


def cancel_worker(_signum: int, _frame: Any) -> None:
    raise OperationCancelled("operation cancelled")


CLOUD_ACTIONS = {"create", "ensure", "delete"}
FLEET_KEYCHAIN_SERVICE = "cua-sandbox-fleet-api"
TAILSCALE_KEYCHAIN_SERVICE = "cua-sandbox-tailscale-oauth"
TAILSCALE_TOKEN_URL = "https://api.tailscale.com/api/v2/oauth/token"
TAILSCALE_API_URL = "https://api.tailscale.com/api/v2"
WINDOWS_PUBLIC_KEY = HOME / ".ssh" / "cua_windows_ed25519.pub"
SANDBOX_KNOWN_HOSTS = HOME / ".ssh" / "cua_known_hosts"

PROFILES = {
    "linux": {
        # Fleet pool/namespace names are a tenant-wide authorization boundary:
        # if another tenant already owns the default namespace, every pool
        # operation fails with a persistent 403.
        "pool": os.environ.get("CUA_PI_LINUX_POOL", "cua-pi-linux"),
        "image": "public.ecr.aws/k5j5w0x5/cua-ubuntu-24.04@sha256:eb68411ed8b4d7c39829cdfe854b9d0485b78ee064c3171fd8e3f7450f7ccee7",
        "cpu": 8,
        "memory_mb": 16 * 1024,
    },
    "windows": {
        "pool": os.environ.get("CUA_PI_WINDOWS_POOL", "cua-pi-windows"),
        "image": "public.ecr.aws/k5j5w0x5/cua-windows-2022@sha256:6d341afc26a37c4072d22ba403a89ecdad9a29aebab79570b5a38da6b8e16370",
        "cpu": 10,
        "memory_mb": 20 * 1024,
    },
}


EXTENSION_DIR = Path(__file__).resolve().parent
BOOTSTRAP_FILES = {
    "linux": EXTENSION_DIR / "bootstrap-linux.sh",
    "windows": EXTENSION_DIR / "bootstrap-windows.ps1",
}

NAME_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,31}$")


def error_text(error: BaseException) -> str:
    text = str(error).strip()
    return text if text else repr(error)


def progress(phase: str, message: str, **details: Any) -> None:
    global CURRENT_PHASE
    CURRENT_PHASE = phase
    if os.environ.get("CUA_PROGRESS_JSON") == "1":
        print(
            json.dumps(
                {"progress": True, "phase": phase, "message": message, **details},
                separators=(",", ":"),
            ),
            flush=True,
        )
    print(f"[cua] {phase}: {message}", file=sys.stderr, flush=True)


async def wait_for_step(
    awaitable: Any, phase: str, timeout: float, *, report: bool = True
) -> Any:
    if report:
        progress(phase, "started", timeout_seconds=timeout)
    try:
        result = await asyncio.wait_for(awaitable, timeout=timeout)
    except TimeoutError as error:
        raise RuntimeError(f"{phase} timed out after {timeout:g} seconds") from error
    except Exception as error:
        raise RuntimeError(f"{phase} failed: {error_text(error)}") from error
    if report:
        progress(phase, "completed")
    return result


def keychain(account: str, service: str) -> str:
    proc = subprocess.run(
        [
            "/usr/bin/security",
            "find-generic-password",
            "-w",
            "-s",
            service,
            "-a",
            account,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return proc.stdout.rstrip("\n")


def pi_version() -> str:
    proc = subprocess.run(
        # pi 0.84+ runs a network update check on --version; 10s flakes
        ["pi", "--version"],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )
    version = proc.stdout.strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", version):
        raise RuntimeError(f"unexpected local Pi version: {version!r}")
    return version


def bootstrap_template(profile: str) -> str:
    try:
        return BOOTSTRAP_FILES[profile].read_text()
    except KeyError:
        raise ValueError(f"unsupported bootstrap profile: {profile}") from None


def bootstrap_digest(profile: str) -> str:
    """Hash only inputs that require machine-level guest repair."""
    digest = hashlib.sha256()
    digest.update(profile.encode())
    digest.update(pi_version().encode())
    digest.update(bootstrap_template(profile).encode())
    if profile == "windows":
        digest.update((EXTENSION_DIR / "tool-broker.mjs").read_bytes())
    return digest.hexdigest()[:20]


def guest_config_files(packages: tuple[str, ...] = ()) -> dict[str, bytes]:
    files = remote_pi_files()
    files[".pi/agent/settings.json"] = (
        json.dumps({"packages": list(packages)}, indent=2).encode() + b"\n"
    )
    return files


def config_digest(files: dict[str, bytes]) -> str:
    digest = hashlib.sha256()
    for path, content in sorted(files.items()):
        digest.update(path.encode())
        digest.update(content)
    return digest.hexdigest()[:20]


@contextmanager
def operation_lock(path: Path) -> Iterator[None]:
    """Serialize one class of mutations across Pi processes and parallel tools."""
    CONTROLLER_DIR.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)


@dataclass(frozen=True)
class SandboxResources:
    pool: str
    image: str
    cpu: int
    memory_mb: int


CUSTOM_POOL_PATTERN = re.compile(
    r"^cua-pi-custom-(?P<profile>linux|windows)-[0-9a-f]{16}$"
)
PINNED_IMAGE_PATTERN = re.compile(r"^\S+@sha256:[0-9a-f]{64}$")


def sandbox_resources(
    profile: str,
    cpu: int | None = None,
    memory_mb: int | None = None,
    image: str | None = None,
) -> SandboxResources:
    if profile not in PROFILES:
        raise ValueError("os must be linux or windows")
    if (cpu is None) != (memory_mb is None):
        raise ValueError("cpu and memory_mb must be supplied together")
    spec = PROFILES[profile]
    if cpu is None and memory_mb is None:
        cpu, memory_mb = spec["cpu"], spec["memory_mb"]
    if type(cpu) is not int or cpu <= 0:
        raise ValueError("cpu must be a positive integer")
    if type(memory_mb) is not int or memory_mb <= 0:
        raise ValueError("memory_mb must be a positive integer")
    if image is not None and not isinstance(image, str):
        raise TypeError("image must be a string")
    image_ref = spec["image"] if image is None else image.strip()
    if not PINNED_IMAGE_PATTERN.fullmatch(image_ref):
        raise ValueError("image must be an OCI reference pinned by sha256 digest")
    if (cpu, memory_mb, image_ref) == (
        spec["cpu"],
        spec["memory_mb"],
        spec["image"],
    ):
        return SandboxResources(spec["pool"], image_ref, cpu, memory_mb)
    identity = f"{spec['pool']}\0{profile}\0{cpu}\0{memory_mb}"
    if image_ref != spec["image"]:
        identity += f"\0{image_ref}"
    digest = hashlib.sha256(identity.encode()).hexdigest()[:16]
    return SandboxResources(
        f"cua-pi-custom-{profile}-{digest}", image_ref, cpu, memory_mb
    )


def profile_for_pool(pool: object) -> str | None:
    if not isinstance(pool, str):
        return None
    default = next(
        (profile for profile, spec in PROFILES.items() if spec["pool"] == pool), None
    )
    match = CUSTOM_POOL_PATTERN.fullmatch(pool)
    return default or (match.group("profile") if match else None)


def sandbox_record(name: str) -> dict[str, Any] | None:
    try:
        value = json.loads((SANDBOX_RECORD_DIR / f"{name}.json").read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def write_sandbox_record(record: dict[str, Any]) -> None:
    SANDBOX_RECORD_DIR.mkdir(parents=True, exist_ok=True)
    path = SANDBOX_RECORD_DIR / f"{record['name']}.json"
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    os.replace(temporary, path)


def record_sandbox(name: str, profile: str, reference: dict[str, Any]) -> None:
    pool_name = reference.get("pool")
    if not isinstance(pool_name, str):
        raise TypeError("CUA claim reference has no pool")
    write_sandbox_record(
        {
            **(sandbox_record(name) or {}),
            "name": name,
            "os": profile,
            "pool": pool_name,
            "claim": reference,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }
    )


def record_tailscale_enrollment(
    name: str, tailnet: str, node_id: str, addresses: list[str]
) -> None:
    record = sandbox_record(name)
    if record is None:
        raise RuntimeError(
            f"cannot record Tailscale device for unknown sandbox: {name}"
        )
    write_sandbox_record(
        {
            **record,
            "tailnet": tailnet,
            "deviceId": node_id,
            "addresses": addresses,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }
    )


def remove_sandbox_record(name: str) -> None:
    (SANDBOX_RECORD_DIR / f"{name}.json").unlink(missing_ok=True)


def controller_sandbox_records() -> list[dict[str, Any]]:
    if not SANDBOX_RECORD_DIR.exists():
        return []
    records = [sandbox_record(path.stem) for path in SANDBOX_RECORD_DIR.glob("*.json")]
    return [record for record in records if record is not None]


def pool_reference_count(pool_name: str) -> int:
    return sum(item.get("pool") == pool_name for item in managed_sandboxes())


def controller_sandboxes() -> list[dict[str, Any]]:
    return sorted(
        (
            {
                "name": record["name"],
                "os": record["os"],
                "pool": record["pool"],
                "address": (record.get("addresses") or [None])[0],
            }
            for record in controller_sandbox_records()
            if all(isinstance(record.get(key), str) for key in ("name", "os", "pool"))
        ),
        key=lambda item: item["name"],
    )


def migrate_legacy_sandbox_records() -> None:
    """Import the pre-controller SDK index once, then leave records canonical."""
    marker = CONTROLLER_DIR / ".sdk-state-migrated"
    if marker.exists():
        return
    if STATE_DIR.exists():
        for path in STATE_DIR.glob("*.json"):
            try:
                state = json.loads(path.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            pool = state.get("pool_name")
            profile = profile_for_pool(pool)
            name = state.get("name", path.stem)
            if (
                state.get("runtime_type") == "fleet"
                and profile
                and isinstance(name, str)
                and sandbox_record(name) is None
            ):
                write_sandbox_record(
                    {
                        "name": name,
                        "os": profile,
                        "pool": pool,
                        "claim": {"pool": pool},
                        "updatedAt": datetime.now(timezone.utc).isoformat(),
                    }
                )
    CONTROLLER_DIR.mkdir(parents=True, exist_ok=True)
    marker.touch()


def restore_cua_state(name: str) -> None:
    """Materialize the SDK connection index from the controller record."""
    state_path = STATE_DIR / f"{name}.json"
    record = sandbox_record(name)
    if record is None or not isinstance(record.get("pool"), str):
        return
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    temporary = state_path.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(
            {
                "name": name,
                "runtime_type": "fleet",
                "pool_name": record["pool"],
                "status": "running",
                "created_at": datetime.now(timezone.utc).isoformat(),
            },
            indent=2,
        )
        + "\n"
    )
    os.replace(temporary, state_path)


def cloud_worker_command(request: dict[str, Any]) -> list[str]:
    backend = str(Path(__file__).resolve())
    payload = json.dumps(request)
    return [
        "uv",
        "run",
        "--quiet",
        "--no-project",
        "--python",
        "3.11",
        "--with",
        "cua-sandbox==0.4.2",
        "--extra-index-url",
        "https://wheels.cua.ai/simple",
        "--index-strategy",
        "unsafe-best-match",
        "python",
        backend,
        payload,
    ]


def tailscale_access_token() -> str:
    token_request = Request(
        TAILSCALE_TOKEN_URL,
        data=urlencode(
            {
                "client_id": keychain("client-id", TAILSCALE_KEYCHAIN_SERVICE),
                "client_secret": keychain("client-secret", TAILSCALE_KEYCHAIN_SERVICE),
            }
        ).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urlopen(token_request, timeout=30, context=TLS_CONTEXT) as response:
            token = json.load(response).get("access_token")
    except HTTPError as error:
        raise RuntimeError(
            f"Tailscale OAuth token request failed with HTTP {error.code}: {error.read().decode(errors='replace')}"
        ) from error
    if not isinstance(token, str) or not token:
        raise RuntimeError("Tailscale returned an invalid OAuth access token")
    return token


def tailscale_api(
    method: str, path: str, *, payload: dict[str, Any] | None = None
) -> Any:
    request = Request(
        f"{TAILSCALE_API_URL}{path}",
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={
            "Authorization": f"Bearer {tailscale_access_token()}",
            "Content-Type": "application/json",
        },
        method=method,
    )
    try:
        with urlopen(request, timeout=30, context=TLS_CONTEXT) as response:
            content = response.read()
    except HTTPError as error:
        raise RuntimeError(
            f"Tailscale API {method} {path} failed with HTTP {error.code}: {error.read().decode(errors='replace')}"
        ) from error
    return json.loads(content) if content else None


def local_tailscale_identity() -> str:
    status = local_tailscale_status()
    if status is None:
        raise RuntimeError("local Tailscale status failed")
    tailnet = (status.get("CurrentTailnet") or {}).get("Name")
    online = (status.get("Self") or {}).get("Online") is True
    if status.get("BackendState") != "Running" or not online:
        raise RuntimeError(
            "local Tailscale is not online; connect this Mac before provisioning a sandbox"
        )
    if not isinstance(tailnet, str) or not tailnet:
        raise RuntimeError("local Tailscale status has no current tailnet identity")
    progress("tailscale.preflight", f"controller is online in tailnet {tailnet}")
    return tailnet


def tailscale_auth_key(tailnet: str) -> str:
    """Mint a durable, one-use enrollment key for the controller's exact tailnet."""
    response = tailscale_api(
        "POST",
        f"/tailnet/{quote(tailnet, safe='')}/keys",
        payload={
            "capabilities": {
                "devices": {
                    "create": {
                        "reusable": False,
                        "ephemeral": True,
                        "preauthorized": True,
                        "tags": ["tag:cua-sandbox"],
                    }
                }
            },
            "expirySeconds": 3600,
        },
    )
    auth_key = response.get("key") if isinstance(response, dict) else None
    if not isinstance(auth_key, str) or not auth_key:
        raise RuntimeError("Tailscale returned an invalid auth key")
    return auth_key


def configure_fleet_auth() -> None:
    os.environ.setdefault(
        "CUA_CLIENT_ID", keychain("client-id", FLEET_KEYCHAIN_SERVICE)
    )
    os.environ.setdefault(
        "CUA_CLIENT_SECRET", keychain("client-secret", FLEET_KEYCHAIN_SERVICE)
    )


def managed_sandboxes() -> list[dict[str, Any]]:
    return controller_sandboxes()


async def guest_tailscale_identity(sb: Any, profile: str) -> tuple[str, str, list[str]]:
    command = (
        "tailscale status --json"
        if profile == "linux"
        else "powershell.exe -NoProfile -Command \"& 'C:\\Program Files\\Tailscale\\tailscale.exe' status --json\""
    )
    result = await sb.shell.run(command, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(result.stderr or "guest Tailscale status failed")
    try:
        status = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("guest Tailscale status returned invalid JSON") from error
    tailnet = (status.get("CurrentTailnet") or {}).get("Name")
    hostname = (status.get("Self") or {}).get("HostName")
    tags = (status.get("Self") or {}).get("Tags") or []
    if status.get("BackendState") != "Running":
        raise RuntimeError("guest Tailscale backend is not running")
    if not isinstance(tailnet, str) or not tailnet:
        raise RuntimeError("guest Tailscale status has no tailnet identity")
    if not isinstance(hostname, str) or not hostname:
        raise RuntimeError("guest Tailscale status has no hostname")
    if not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags):
        raise RuntimeError("guest Tailscale status returned invalid tags")
    return tailnet, hostname, tags


def local_tailscale_status(timeout: float = 10) -> dict[str, Any] | None:
    try:
        process = subprocess.run(
            ["tailscale", "status", "--json"],
            check=True,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        status = json.loads(process.stdout)
        return status if isinstance(status, dict) else None
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return None


def local_tailscale_peer(address: str) -> dict[str, Any] | None:
    status = local_tailscale_status()
    if status is None:
        return None
    peers = (status.get("Peer") or {}).values()
    for peer in peers:
        if not isinstance(peer, dict):
            continue
        if (
            address in (peer.get("TailscaleIPs") or [])
            and "tag:cua-sandbox" in (peer.get("Tags") or [])
            and peer.get("Online") is True
        ):
            return peer
    return None


def verify_controller_reachability(address: str) -> None:
    progress("tailscale.controller-reachability", f"pinging {address}")
    try:
        result = subprocess.run(
            [
                "tailscale",
                "ping",
                "--c",
                "1",
                "--timeout",
                "5s",
                "--until-direct=false",
                address,
            ],
            capture_output=True,
            text=True,
            timeout=12,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(
            f"controller Tailscale ping to {address} exceeded 12 seconds; check the local Tailscale client"
        ) from error
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(
            f"controller cannot reach sandbox Tailscale address {address}: {detail or f'exit {result.returncode}'}"
        )
    progress("tailscale.controller-reachability", "sandbox is reachable")


async def verify_tailscale_enrollment(
    sb: Any,
    profile: str,
    name: str,
    address: str,
    expected_tailnet: str,
) -> tuple[str, list[str]]:
    guest_tailnet, guest_hostname, guest_tags = await guest_tailscale_identity(
        sb, profile
    )
    if guest_tailnet != expected_tailnet:
        raise RuntimeError(
            f"guest joined tailnet {guest_tailnet!r}, expected {expected_tailnet!r}"
        )
    if guest_hostname.lower() != name.lower():
        progress(
            "tailscale.hostname",
            f"using {address}; Tailscale registered {guest_hostname!r} instead of {name!r}",
        )
    if "tag:cua-sandbox" not in guest_tags:
        raise RuntimeError("guest is missing required Tailscale tag:cua-sandbox")

    progress("tailscale.peer-discovery", f"waiting for {name} in controller netmap")
    deadline = time.monotonic() + 90
    peer = None
    while time.monotonic() < deadline:
        peer = local_tailscale_peer(address)
        if peer is not None:
            break
        await asyncio.sleep(3)
    if peer is None:
        raise RuntimeError(
            f"controller did not discover {name} at {address} in tailnet {expected_tailnet!r} within 90 seconds"
        )

    verify_controller_reachability(address)
    node_id = peer.get("StableID") or peer.get("ID")
    addresses = peer.get("TailscaleIPs") or []
    if not isinstance(node_id, str) or not node_id:
        raise RuntimeError("controller netmap returned no stable Tailscale node id")
    if not all(isinstance(item, str) for item in addresses):
        raise RuntimeError("controller netmap returned invalid Tailscale addresses")
    progress("tailscale.enrollment", f"verified node {node_id}")
    return node_id, addresses


def pin_verified_ssh_host_key(address: str) -> None:
    """Pin the SSH key after Fleet and the controller netmap verify the guest."""
    try:
        scanned = subprocess.run(
            ["ssh-keyscan", "-T", "5", "-t", "ed25519", address],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError(f"could not scan the SSH host key for {address}") from error
    keys = [
        line
        for line in scanned.stdout.splitlines()
        if line and not line.startswith("#")
    ]
    if scanned.returncode != 0 or not keys:
        detail = scanned.stderr.strip()
        raise RuntimeError(
            f"could not scan the SSH host key for {address}: "
            f"{detail or f'exit {scanned.returncode}'}"
        )

    known = subprocess.run(
        ["ssh-keygen", "-F", address, "-f", str(SANDBOX_KNOWN_HOSTS)],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    scanned_material = {" ".join(line.split()[1:3]) for line in keys}
    known_material = {
        " ".join(line.split()[1:3])
        for line in known.stdout.splitlines()
        if line and not line.startswith("#") and len(line.split()) >= 3
    }
    if scanned_material & known_material:
        return

    SANDBOX_KNOWN_HOSTS.parent.mkdir(parents=True, exist_ok=True)
    SANDBOX_KNOWN_HOSTS.touch(mode=0o600, exist_ok=True)
    removed = subprocess.run(
        ["ssh-keygen", "-R", address, "-f", str(SANDBOX_KNOWN_HOSTS)],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    if removed.returncode != 0:
        raise RuntimeError(
            f"could not replace the verified SSH host key for {address}: "
            f"{removed.stderr.strip() or f'exit {removed.returncode}'}"
        )
    with SANDBOX_KNOWN_HOSTS.open("a") as known_hosts:
        known_hosts.write("\n".join(keys) + "\n")
    SANDBOX_KNOWN_HOSTS.chmod(0o600)
    progress("ssh.host-key", f"pinned verified host key for {address}")


def online_tailscale_hosts() -> set[str]:
    status = local_tailscale_status(timeout=3)
    if status is None:
        return set()
    peers = [status.get("Self") or {}, *(status.get("Peer") or {}).values()]
    online = set()
    for peer in peers:
        if peer.get("Online") is not True:
            continue
        online.add(str(peer.get("HostName", "")).lower())
        online.update(
            str(address).lower() for address in peer.get("TailscaleIPs") or []
        )
    return online


def validate_name(name: str) -> None:
    if not NAME_PATTERN.fullmatch(name):
        raise ValueError(
            "name must start with a letter and contain only lowercase letters, digits, and hyphens"
        )


def next_name(profile: str) -> str:
    used = {item["name"] for item in managed_sandboxes()}
    for number in range(1, 1000):
        candidate = f"{profile}-{number}"
        if candidate not in used:
            return candidate
    raise RuntimeError(f"no free {profile} name")


def remote_pi_files() -> dict[str, bytes]:
    files = {
        f".pi/agent/{remote}": (EXTENSION_DIR / source).read_bytes()
        for remote, source in {
            "cua-tool-host.mjs": "tool-host.mjs",
            "cua-tool-relay.mjs": "tool-relay.mjs",
        }.items()
    }
    extensions = PI_DIR / "extensions"
    if extensions.exists():
        for source in extensions.rglob("*"):
            parts = source.relative_to(PI_DIR).parts
            if (
                not source.is_file()
                or any(
                    "cua-sandbox" in part or "report-papercut" in part for part in parts
                )
                or any(
                    part in {"node_modules", ".git", "__pycache__"} for part in parts
                )
            ):
                continue
            remote = PurePosixPath(*parts).as_posix()
            files[f".pi/agent/{remote}"] = source.read_bytes()
    return files


async def upload_linux_config(sb: Any, tailnet: str) -> None:
    await sb.files.write_text(
        "/tmp/cua-tailscale-auth-key",
        tailscale_auth_key(tailnet),
    )
    result = await sb.shell.run("chmod 600 /tmp/cua-tailscale-auth-key", timeout=30)
    if result.returncode != 0:
        raise RuntimeError(result.stderr or "failed to secure bootstrap credentials")


async def bootstrap_linux(sb: Any, name: str, tailnet: str) -> str:
    progress(f"bootstrap.{name}.upload", "uploading Linux bootstrap inputs")
    await wait_for_step(
        upload_linux_config(sb, tailnet), f"bootstrap.{name}.upload", 180
    )
    script = (
        bootstrap_template("linux")
        .replace("__HOSTNAME__", name)
        .replace("__BOOTSTRAP_VERSION__", bootstrap_digest("linux"))
        .replace("__PI_VERSION__", pi_version())
    )
    # The Fleet exec gateway drops any single shell.run after ~30 seconds, so
    # the long bootstrap must run detached in the guest and be polled with
    # short commands — same contract as run_windows_background_job.
    code, output = await run_linux_background_job(
        sb, script, f"bootstrap.{name}.linux", 1200
    )
    if code != 0:
        raise RuntimeError((output or "linux bootstrap failed").strip())
    lines = output.strip().splitlines()
    address = lines[-1] if lines else await healthy(sb, "linux")
    if not address:
        raise RuntimeError(
            "linux bootstrap exited successfully but post-bootstrap health returned no Tailscale address"
        )
    return address


async def upload_windows_file(sb: Any, remote: str, content: bytes | None) -> None:
    if content is not None:
        await wait_for_step(
            sb.files.write_bytes(remote, content),
            f"upload.windows.{PureWindowsPath(remote).name}",
            120,
        )


async def poll_background_job(
    sb: Any,
    poll_command: str,
    cleanup_command: str,
    phase: str,
    timeout: float,
    platform: str,
) -> tuple[int, str]:
    began = time.monotonic()
    next_heartbeat = began
    try:
        while True:
            elapsed = time.monotonic() - began
            if elapsed >= timeout:
                raise RuntimeError(f"{phase} timed out after {timeout:g} seconds")
            if time.monotonic() >= next_heartbeat:
                progress(
                    phase,
                    "background job is running",
                    elapsed_seconds=round(elapsed),
                )
                next_heartbeat = time.monotonic() + 30
            try:
                result = await wait_for_step(
                    sb.shell.run(poll_command, timeout=20),
                    f"{phase}.poll-request",
                    30,
                    report=False,
                )
            except RuntimeError as error:
                progress(
                    f"{phase}.poll",
                    "guest status poll failed; background job may still be running",
                    failure=error_text(error),
                )
                await asyncio.sleep(5)
                continue
            lines = result.stdout.splitlines()
            if lines and lines[0].startswith("__DONE__"):
                raw_code = lines[0].removeprefix("__DONE__").strip()
                try:
                    code = int(raw_code)
                except ValueError as error:
                    raise RuntimeError(
                        f"invalid {platform} job result: {raw_code!r}"
                    ) from error
                return code, "\n".join(lines[1:]).strip()
            await asyncio.sleep(5)
    finally:
        try:
            await wait_for_step(
                sb.shell.run(cleanup_command, timeout=20),
                f"{phase}.cleanup",
                30,
                report=False,
            )
        except RuntimeError as error:
            progress(f"{phase}.cleanup", "cleanup failed", failure=error_text(error))


async def run_linux_background_job(
    sb: Any, script: str, phase: str, timeout: float
) -> tuple[int, str]:
    script_path = "/tmp/cua-bootstrap.sh"
    log_path = "/tmp/cua-bootstrap.log"
    result_path = "/tmp/cua-bootstrap.result"
    # The guest command server rejects any command that leaves a backgrounded
    # child ("&", nohup, setsid all fail), so the job must detach through the
    # service manager — the schtasks analog used on Windows.
    sudo = 'if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO=sudo; fi; '
    stop = (
        sudo
        + "$SUDO systemctl stop cua-bootstrap.service 2>/dev/null; "
        + "$SUDO systemctl reset-failed cua-bootstrap.service 2>/dev/null; "
    )
    prepare_cleanup = stop + f"$SUDO rm -f {log_path} {result_path}; true"
    final_cleanup = (
        stop
        + f"$SUDO rm -f {script_path} {log_path} {result_path} "
        + "/tmp/cua-tailscale-auth-key; true"
    )
    await wait_for_step(
        sb.shell.run(prepare_cleanup, timeout=20), f"{phase}.prepare", 30
    )
    await wait_for_step(
        sb.files.write_text(script_path, script), f"{phase}.runner-upload", 30
    )
    launch = (
        sudo
        + "$SUDO systemd-run --collect --unit=cua-bootstrap sh -c "
        + f"'bash {script_path} >{log_path} 2>&1; echo $? >{result_path}'"
    )
    started = await wait_for_step(
        sb.shell.run(launch, timeout=20), f"{phase}.launch", 30
    )
    if started.returncode != 0:
        raise RuntimeError(started.stderr or "failed to launch Linux background job")

    poll = (
        f"if [ -f {result_path} ]; then echo __DONE__$(cat {result_path}); "
        f"tail -n 200 {log_path} 2>/dev/null; else echo __RUNNING__; fi"
    )
    return await poll_background_job(sb, poll, final_cleanup, phase, timeout, "Linux")


async def run_windows_background_job(
    sb: Any, script_path: str, phase: str, timeout: float
) -> tuple[int, str]:
    log_path = r"C:\Windows\Temp\cua-bootstrap.log"
    result_path = r"C:\Windows\Temp\cua-bootstrap.result"
    runner_path = r"C:\Windows\Temp\cua-bootstrap-runner.ps1"
    stop = (
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*cua-bootstrap*' -and $_.ProcessId -ne $PID } | "
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; "
        "schtasks.exe /Delete /TN CuaPiBootstrap /F 2>&1 | Out-Null; "
    )

    def cleanup(paths: str) -> str:
        return (
            'powershell.exe -NoProfile -Command "'
            + stop
            + f'Remove-Item -Force -ErrorAction SilentlyContinue {paths}"'
        )

    prepare_cleanup = cleanup(f"'{runner_path}','{log_path}','{result_path}'")
    final_cleanup = cleanup(
        f"'{runner_path}','{script_path}','{log_path}','{result_path}',"
        "'C:\\Windows\\Temp\\cua-pi-agent.zip',"
        "'C:\\Windows\\Temp\\cua-authorized-key.pub',"
        "'C:\\Windows\\Temp\\cua-tailscale-auth-key'"
    )
    await wait_for_step(
        sb.shell.run(prepare_cleanup, timeout=20), f"{phase}.prepare", 30
    )
    runner = (
        "$ErrorActionPreference = 'Stop'\n"
        "$code = 0\n"
        f"try {{ & '{script_path}' *> '{log_path}' }} catch {{ ($_ | Format-List * -Force | Out-String) | Out-File -Append -Encoding utf8 '{log_path}'; $code = 1 }}\n"
        f"Set-Content -Encoding ascii -Path '{result_path}' -Value $code\n"
    )
    await wait_for_step(
        sb.files.write_text(runner_path, runner), f"{phase}.runner-upload", 30
    )
    launch = (
        'cmd.exe /d /c schtasks.exe /Create /TN CuaPiBootstrap /TR "'
        f"powershell.exe -NoProfile -ExecutionPolicy Bypass -File {runner_path}"
        '" /SC ONCE /ST 23:59 /F && schtasks.exe /Run /TN CuaPiBootstrap'
    )
    started = await wait_for_step(
        sb.shell.run(launch, timeout=20), f"{phase}.launch", 30
    )
    if started.returncode != 0:
        raise RuntimeError(started.stderr or "failed to launch Windows background job")

    poll = (
        'powershell.exe -NoProfile -Command "'
        f"if(Test-Path '{result_path}'){{Write-Output ('__DONE__' + (Get-Content -Raw '{result_path}').Trim()); "
        f"if(Test-Path '{log_path}'){{Get-Content -Tail 200 '{log_path}'}}}}else{{Write-Output '__RUNNING__'}}\""
    )
    return await poll_background_job(sb, poll, final_cleanup, phase, timeout, "Windows")


async def bootstrap_windows(sb: Any, name: str, tailnet: str) -> str:
    progress(f"bootstrap.{name}.upload", "building Windows bootstrap inputs")
    if not WINDOWS_PUBLIC_KEY.exists():
        raise RuntimeError(f"missing Windows SSH public key: {WINDOWS_PUBLIC_KEY}")
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, mode="w", compression=zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr(
            ".pi/agent/cua-tool-broker.mjs",
            (EXTENSION_DIR / "tool-broker.mjs").read_bytes(),
        )
    await upload_windows_file(
        sb, r"C:\Windows\Temp\cua-pi-agent.zip", archive.getvalue()
    )
    await upload_windows_file(
        sb, r"C:\Windows\Temp\cua-authorized-key.pub", WINDOWS_PUBLIC_KEY.read_bytes()
    )
    await upload_windows_file(
        sb,
        r"C:\Windows\Temp\cua-tailscale-auth-key",
        tailscale_auth_key(tailnet).encode(),
    )
    script = (
        bootstrap_template("windows")
        .replace("__HOSTNAME__", name)
        .replace("__BOOTSTRAP_VERSION__", bootstrap_digest("windows"))
        .replace("__PI_VERSION__", pi_version())
    )
    await upload_windows_file(
        sb, r"C:\Windows\Temp\cua-bootstrap.ps1", script.encode("utf-8-sig")
    )
    progress(f"bootstrap.{name}.upload", "Windows bootstrap inputs uploaded")
    code, output = await run_windows_background_job(
        sb,
        r"C:\Windows\Temp\cua-bootstrap.ps1",
        f"bootstrap.{name}.windows",
        1800,
    )
    if code != 0:
        raise RuntimeError(output or f"windows bootstrap exited {code}")
    address = await healthy(sb, "windows")
    if not address:
        raise RuntimeError(
            "windows bootstrap completed but post-bootstrap health returned no Tailscale address; "
            f"output_tail={output[-2000:]!r}"
        )
    return address


def guest_health_command(profile: str) -> str:
    expected_digest = bootstrap_digest(profile)
    if profile == "linux":
        return f'test "$(cat /home/cua/.cua-pi/bootstrap-version 2>/dev/null)" = {shlex.quote(expected_digest)} && command -v pi >/dev/null && tailscale ip -4 | head -n 1'
    return (
        "powershell.exe -NoProfile -Command \"if((Get-Content -ErrorAction SilentlyContinue C:\\ProgramData\\cua-pi\\bootstrap-version) -ne '"
        + expected_digest
        + "'){exit 2}; if(-not (Test-Path C:\\ProgramData\\npm\\pi.cmd)){exit 3}; if((Get-Service sshd).Status -ne 'Running'){exit 4}; & 'C:\\Program Files\\Tailscale\\tailscale.exe' ip -4 | Select-Object -First 1\""
    )


async def healthy(sb: Any, profile: str) -> str | None:
    try:
        command = guest_health_command(profile)
        result = await sb.shell.run(command, timeout=30)
    except (RuntimeError, TimeoutError):
        return None
    lines = result.stdout.strip().splitlines() if result.returncode == 0 else []
    return lines[-1] if lines else None


async def connect_sandbox(name: str, attempts: int = 3) -> Any:
    from cua_sandbox import Sandbox

    failures: list[str] = []
    for attempt in range(1, attempts + 1):
        try:
            return await wait_for_step(
                Sandbox._create(
                    name=name,
                    ephemeral=False,
                    request_timeout=1900,
                ),
                f"connect.{name}.attempt-{attempt}",
                60,
            )
        except RuntimeError as error:
            failures.append(error_text(error))
            if attempt == attempts:
                break
            delay = attempt * 5
            progress(
                f"connect.{name}",
                f"retrying after {delay} seconds",
                failure=failures[-1],
            )
            await asyncio.sleep(delay)
    raise RuntimeError(
        f"could not connect to {name} after {attempts} attempts: {'; '.join(failures)}"
    )


async def disconnect_safely(sb: Any) -> None:
    try:
        await sb.disconnect()
    except Exception as error:  # noqa: BLE001 - disconnect cannot invalidate success
        print(f"warning: CUA disconnect failed: {error!r}", file=sys.stderr)


async def complete_tailscale_enrollment(
    sb: Any, profile: str, name: str, address: str, tailnet: str
) -> None:
    node_id, addresses = await verify_tailscale_enrollment(
        sb, profile, name, address, tailnet
    )
    pin_verified_ssh_host_key(address)
    record_tailscale_enrollment(
        name,
        tailnet,
        node_id,
        [address, *(item for item in addresses if item != address)],
    )


async def ensure_one(name: str) -> dict[str, Any]:
    states = {item["name"]: item for item in managed_sandboxes()}
    if name not in states:
        raise ValueError(f"unknown managed sandbox: {name}")
    profile = states[name]["os"]
    tailnet = local_tailscale_identity()

    restore_cua_state(name)
    sb = await connect_sandbox(name)
    try:
        address = await healthy(sb, profile)
        changed = address is None
        if changed:
            address = await (
                bootstrap_linux(sb, name, tailnet)
                if profile == "linux"
                else bootstrap_windows(sb, name, tailnet)
            )
        await complete_tailscale_enrollment(sb, profile, name, address, tailnet)
        return {
            "name": name,
            "os": profile,
            "address": address,
            "changed": changed,
        }
    finally:
        await disconnect_safely(sb)


async def cleanup_failed_create(
    name: str, resources: SandboxResources, pool: Any
) -> None:
    from cua_sandbox import Sandbox

    restore_cua_state(name)
    try:
        await Sandbox.delete(name)
    except LookupError:
        (STATE_DIR / f"{name}.json").unlink(missing_ok=True)
    except Exception as error:  # noqa: BLE001 - preserve the record for explicit cleanup
        progress(
            "claim.cleanup", "failed; sandbox remains managed", error=error_text(error)
        )
        return
    remove_sandbox_record(name)
    if (
        CUSTOM_POOL_PATTERN.fullmatch(resources.pool)
        and pool_reference_count(resources.pool) == 0
    ):
        try:
            await pool.delete()
        except Exception as error:  # noqa: BLE001 - claim cleanup already succeeded
            progress("pool.cleanup", "failed", error=error_text(error))


async def create_one(
    profile: str,
    requested_name: str | None,
    cpu: int | None = None,
    memory_mb: int | None = None,
    image_ref: str | None = None,
) -> dict[str, Any]:
    resources = sandbox_resources(profile, cpu, memory_mb, image_ref)
    name = requested_name or next_name(profile)
    validate_name(name)
    if any(item["name"] == name for item in managed_sandboxes()):
        raise ValueError(f"managed sandbox already exists: {name}")
    tailnet = local_tailscale_identity()

    from cua_sandbox import Image, Pool, Sandbox, WarmPoolAutoscaling

    image = Image.from_registry(resources.image, os_type=profile, kind="vm")
    autoscaling = WarmPoolAutoscaling(
        min_pool_size=0, initial_pool_size=1, max_pool_size=10
    )
    pool = None
    for attempt in range(1, 13):
        phase = f"pool.{resources.pool}.reconcile.attempt-{attempt}"
        try:
            pool = await wait_for_step(
                Pool.apply(
                    image,
                    name=resources.pool,
                    cpu=resources.cpu,
                    memory_mb=resources.memory_mb,
                    services={"server": 8000},
                    autoscaling=autoscaling,
                ),
                phase,
                300,
            )
            break
        except RuntimeError as error:
            detail = error_text(error)
            if "status=403" in detail and "osgymsandboxwarmpools" in detail:
                variable = f"CUA_PI_{profile.upper()}_POOL"
                raise RuntimeError(
                    f"Fleet pool {resources.pool!r} is unavailable to this tenant; "
                    f"set {variable} to an unclaimed base pool name"
                ) from error
            transient = "NamespaceTerminating" in detail
            if not transient or attempt == 12:
                raise
            progress(phase, "Fleet namespace is converging; retrying in 10 seconds")
            await asyncio.sleep(10)
    if pool is None:
        raise RuntimeError(f"pool {resources.pool} reconciliation produced no pool")
    record_sandbox(
        name,
        profile,
        {"name": name, "pool": resources.pool, "status": "provisioning"},
    )
    restore_cua_state(name)
    try:
        sb = await wait_for_step(
            Sandbox.create(pool=pool, name=name, service="server", time_to_start=900),
            f"claim.{name}.wait-service",
            960,
        )
    except Exception:
        await cleanup_failed_create(name, resources, pool)
        raise
    record_sandbox(name, profile, sb.to_dict())
    await disconnect_safely(sb)
    sb = await connect_sandbox(name)
    try:
        address = await (
            bootstrap_linux(sb, name, tailnet)
            if profile == "linux"
            else bootstrap_windows(sb, name, tailnet)
        )
        await complete_tailscale_enrollment(sb, profile, name, address, tailnet)
        return {
            "name": name,
            "os": profile,
            "address": address,
            "changed": True,
        }
    finally:
        await disconnect_safely(sb)


async def delete_one(name: str) -> dict[str, Any]:
    states = {item["name"]: item for item in managed_sandboxes()}
    if name not in states:
        raise ValueError(f"unknown managed sandbox: {name}")
    from cua_sandbox import Sandbox

    # Release by persisted claim reference. Connecting first would make deletion
    # depend on the guest computer service being healthy.
    restore_cua_state(name)
    await Sandbox.delete(name)
    remove_sandbox_record(name)
    return {"name": name, "deleted": True}


@dataclass(frozen=True)
class WorkspaceRepository:
    root: Path
    relative_cwd: Path
    remote_url: str
    commit: str


class WorkspaceState(TypedDict):
    """Immutable trees captured when a thread first enters a sandbox."""

    version: int
    localRoot: str
    commit: str
    commitTree: str
    baselineTree: str


class SandboxWorkspaceSource(TypedDict):
    address: str
    os: str
    remoteCwd: str
    state: WorkspaceState


@dataclass(frozen=True)
class WorkspaceTransfer:
    state: WorkspaceState
    patch: bytes
    final_tree: str


WORKSPACE_OBJECT_FIELDS = ("commit", "commitTree", "baselineTree")


def require_workspace_state(value: object, field: str) -> WorkspaceState:
    if (
        not isinstance(value, dict)
        or value.get("version") != 1
        or not isinstance(value.get("localRoot"), str)
        or any(
            not isinstance(value.get(key), str)
            or not re.fullmatch(r"[0-9a-f]{40,64}", value[key])
            for key in WORKSPACE_OBJECT_FIELDS
        )
    ):
        raise TypeError(f"{field} is invalid")
    return cast(WorkspaceState, value)


def require_sandbox_source(value: object) -> SandboxWorkspaceSource:
    if not isinstance(value, dict):
        raise TypeError("source must be an object")
    address = value.get("address")
    profile = value.get("os")
    remote_cwd = value.get("remoteCwd")
    if (
        not isinstance(address, str)
        or not address
        or profile not in PROFILES
        or not isinstance(remote_cwd, str)
        or not remote_cwd
    ):
        raise TypeError("source has invalid sandbox fields")
    return SandboxWorkspaceSource(
        address=address,
        os=cast(str, profile),
        remoteCwd=remote_cwd,
        state=require_workspace_state(value.get("state"), "source.state"),
    )


def git_output(root: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", "-C", str(root), *args],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return proc.stdout.strip()


def workspace_tree(source: Path) -> tuple[Path, str]:
    root = Path(git_output(source, "rev-parse", "--show-toplevel")).resolve()
    status = subprocess.run(
        [
            "git",
            "-C",
            str(root),
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
        ],
        check=True,
        capture_output=True,
        timeout=300,
    )
    if not status.stdout:
        return root, git_output(root, "rev-parse", "HEAD^{tree}")

    with tempfile.TemporaryDirectory() as directory:
        index = Path(directory) / "index"
        environment = {**os.environ, "GIT_INDEX_FILE": str(index)}
        for arguments in (("read-tree", "HEAD"), ("add", "-A", "--", ".")):
            subprocess.run(
                ["git", "-C", str(root), *arguments],
                check=True,
                capture_output=True,
                env=environment,
                timeout=300,
            )
        tree = subprocess.run(
            ["git", "-C", str(root), "write-tree"],
            check=True,
            capture_output=True,
            text=True,
            env=environment,
            timeout=300,
        ).stdout.strip()
    if not re.fullmatch(r"[0-9a-f]{40,64}", tree):
        raise RuntimeError("Git returned an invalid workspace tree")
    return root, tree


WORKSPACE_FILTER_CHECK = r"""const { spawnSync } = require('node:child_process');
const root = process.argv[1];
const maxBuffer = 256 * 1024 * 1024;
const run = (args, input) => {
  const result = spawnSync('git', ['-C', root, ...args], { input, maxBuffer });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stderr ?? Buffer.from(result.error?.message ?? 'git failed'));
    process.exit(result.status ?? 1);
  }
  return result.stdout;
};
const paths = run(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
const fields = run(
  ['check-attr', '-z', '--stdin', 'filter', 'working-tree-encoding'],
  paths,
).toString('utf8').split('\0');
for (let i = 0; i + 2 < fields.length; i += 3) {
  if (!['', 'unspecified', 'unset'].includes(fields[i + 2])) {
    process.stderr.write(`unsupported Git attribute: ${fields[i + 1]}=${fields[i + 2]} on ${fields[i]}\n`);
    process.exit(42);
  }
}
"""


def reject_remote_workspace_filters(name: str, profile: str, root: str) -> None:
    command = (
        f"node -e {shlex.quote(WORKSPACE_FILTER_CHECK)} {shlex.quote(root)}"
        if profile == "linux"
        else f"& 'C:\\cua\\node\\node.exe' -e {powershell_literal(WORKSPACE_FILTER_CHECK)} {powershell_literal(root)}"
    )
    run_guest_ssh(name, profile, command, timeout=60)


def remote_workspace_tree(
    name: str,
    profile: str,
    root: str,
    *,
    reference: str | None = None,
) -> str:
    reject_remote_workspace_filters(name, profile, root)
    ref = f"refs/cua-pi/sync/{reference}" if reference else None
    if profile == "linux":
        command = f"""set -eu
index=$(mktemp)
rm -f "$index"
trap 'rm -f "$index"' EXIT
export GIT_INDEX_FILE="$index"
git -C {shlex.quote(root)} read-tree HEAD
git -C {shlex.quote(root)} add -A -- .
tree=$(git -C {shlex.quote(root)} write-tree)
"""
        if ref:
            command += (
                f"commit=$(printf '%s\\n' pi-cua-sync | "
                f"git -C {shlex.quote(root)} -c user.name=pi-cua "
                f'-c user.email=pi-cua@localhost commit-tree "$tree")\n'
                f'git -C {shlex.quote(root)} update-ref {shlex.quote(ref)} "$commit"\n'
            )
        command += "printf '%s\\n' \"$tree\"\n"
    else:
        command = f"""$ErrorActionPreference = 'Stop'
$index = Join-Path $env:TEMP ('cua-sync-' + [guid]::NewGuid().ToString('N'))
try {{
  $env:GIT_INDEX_FILE = $index
  git -C {powershell_literal(root)} read-tree HEAD
  if ($LASTEXITCODE -ne 0) {{ throw 'git read-tree failed' }}
  git -C {powershell_literal(root)} add -A -- .
  if ($LASTEXITCODE -ne 0) {{ throw 'git add failed' }}
  $tree = (git -C {powershell_literal(root)} write-tree).Trim()
  if ($LASTEXITCODE -ne 0) {{ throw 'git write-tree failed' }}
"""
        if ref:
            command += f"  $commit = ('pi-cua-sync' | git -C {powershell_literal(root)} -c user.name=pi-cua -c user.email=pi-cua@localhost commit-tree $tree).Trim()\n  git -C {powershell_literal(root)} update-ref {powershell_literal(ref)} $commit\n  if ($LASTEXITCODE -ne 0) {{ throw 'git update-ref failed' }}\n"
        command += "  Write-Output $tree\n} finally { Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue; Remove-Item -Force $index -ErrorAction SilentlyContinue }\n"
    tree = run_guest_ssh(name, profile, command, timeout=600).stdout.splitlines()[-1]
    if not re.fullmatch(r"[0-9a-f]{40,64}", tree):
        raise RuntimeError("guest Git returned an invalid workspace tree")
    return tree


def workspace_patch(root: Path, base_tree: str, final_tree: str) -> bytes:
    if not all(
        re.fullmatch(r"[0-9a-f]{40,64}", tree) for tree in (base_tree, final_tree)
    ):
        raise ValueError("workspace diff requires full Git tree IDs")
    patch = subprocess.run(
        [
            "git",
            "-C",
            str(root),
            "diff",
            "--binary",
            "--full-index",
            base_tree,
            final_tree,
            "--",
        ],
        check=True,
        capture_output=True,
        timeout=600,
    ).stdout
    if len(patch) > 200 * 1024 * 1024:
        raise RuntimeError("workspace diff exceeds the 200 MiB limit")
    return patch


def remote_workspace_patch(
    name: str, profile: str, root: str, base_tree: str, final_tree: str
) -> bytes:
    if not all(
        re.fullmatch(r"[0-9a-f]{40,64}", tree) for tree in (base_tree, final_tree)
    ):
        raise ValueError("workspace diff requires full Git tree IDs")
    command = (
        f"git -C {shlex.quote(root)} diff --binary --full-index {shlex.quote(base_tree)} {shlex.quote(final_tree)} --"
        if profile == "linux"
        else f"git -C {powershell_literal(root)} diff --binary --full-index {base_tree} {final_tree} --"
    )
    result = subprocess.run(
        ["ssh", *ssh_options(profile), f"cua@{name}", command],
        capture_output=True,
        timeout=600,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"remote workspace diff failed with exit {result.returncode}: "
            f"{result.stderr.decode(errors='replace').strip()}"
        )
    if len(result.stdout) > 200 * 1024 * 1024:
        raise RuntimeError("workspace diff exceeds the 200 MiB limit")
    return result.stdout


def apply_workspace_patch(root: Path, patch: bytes, expected_tree: str) -> None:
    command = ["git", "-C", str(root), "apply", "--binary", "--whitespace=nowarn"]
    if patch:
        subprocess.run(command, input=patch, check=True, timeout=300)
    _, actual_tree = workspace_tree(root)
    if actual_tree != expected_tree:
        if patch:
            subprocess.run(
                [*command, "--reverse"], input=patch, check=True, timeout=300
            )
        raise RuntimeError(
            "workspace verification failed after applying sandbox changes"
        )


def apply_remote_workspace_patch(
    name: str,
    profile: str,
    root: str,
    patch: bytes,
    expected_tree: str,
    *,
    reference: str | None = None,
) -> None:
    if patch:
        patch_id = uuid.uuid4().hex
        remote_path = (
            f"/tmp/cua-workspace-{patch_id}.patch"
            if profile == "linux"
            else rf"C:\Windows\Temp\cua-workspace-{patch_id}.patch"
        )
        copy_guest_file(name, profile, patch, remote_path)
        if profile == "linux":
            command = f"""set -eu
trap 'rm -f {shlex.quote(remote_path)}' EXIT
git -C {shlex.quote(root)} apply --binary --whitespace=nowarn {shlex.quote(remote_path)}
"""
        else:
            command = f"""$ErrorActionPreference = 'Stop'
try {{
  git -C {powershell_literal(root)} apply --binary --whitespace=nowarn {powershell_literal(remote_path)}
  if ($LASTEXITCODE -ne 0) {{ throw 'git apply failed' }}
}} finally {{
  Remove-Item -Force -ErrorAction SilentlyContinue {powershell_literal(remote_path)}
}}
"""
        run_guest_ssh(name, profile, command, timeout=600)
    actual_tree = remote_workspace_tree(name, profile, root, reference=reference)
    if actual_tree != expected_tree:
        raise RuntimeError(
            "workspace verification failed after applying sandbox changes"
        )


def reject_workspace_filters(root: Path) -> None:
    result = subprocess.run(
        ["node", "-e", WORKSPACE_FILTER_CHECK, str(root)],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        raise ValueError(result.stderr.strip() or "workspace filter check failed")


def inspect_workspace(source_cwd: Path) -> WorkspaceRepository:
    root_text = git_output(source_cwd, "rev-parse", "--show-toplevel")
    root = Path(root_text).resolve()
    resolved_cwd = source_cwd.resolve()
    if not resolved_cwd.is_relative_to(root):
        raise ValueError("session cwd is outside its Git workspace")
    remote_url = git_output(root, "remote", "get-url", "origin")
    if not remote_url.startswith(("https://", "http://", "ssh://", "git@")):
        raise ValueError("workspace origin must be a network Git URL")
    commit = git_output(root, "rev-parse", "HEAD")
    if not re.fullmatch(r"[0-9a-f]{40,64}", commit):
        raise ValueError("workspace HEAD is not a full Git object ID")
    staged_files = git_output(root, "ls-files", "--stage")
    if any(line.startswith("160000 ") for line in staged_files.splitlines()):
        raise ValueError("workspace transfer does not yet support Git submodules")
    reject_workspace_filters(root)

    return WorkspaceRepository(
        root=root,
        relative_cwd=resolved_cwd.relative_to(root),
        remote_url=remote_url,
        commit=commit,
    )


def powershell_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def ssh_options(profile: str) -> list[str]:
    options = [
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        f"UserKnownHostsFile={SANDBOX_KNOWN_HOSTS}",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ControlMaster=auto",
        "-o",
        "ControlPersist=10m",
        "-o",
        f"ControlPath={HOME / '.ssh' / 'cua-%C'}",
    ]
    if profile == "windows":
        options[:0] = ["-i", str(WINDOWS_PUBLIC_KEY.with_suffix(""))]
    return options


@dataclass(frozen=True)
class GuestPreflight:
    address: str
    free_bytes: int
    config_matches: bool
    repository_available: bool


def guest_preflight(
    name: str,
    profile: str,
    remote_url: str,
    commit: str,
    config_digest: str,
) -> GuestPreflight | None:
    repository_key = hashlib.sha256(remote_url.encode()).hexdigest()[:20]
    if profile == "linux":
        cache = f"/home/cua/.cache/cua-pi/git/{repository_key}.git"
        command = f"""set -u
address=$({guest_health_command(profile)}) || exit 20
free_bytes=$(( $(df -Pk /home/cua | awk 'NR == 2 {{ print $4 }}') * 1024 ))
config=$(cat /home/cua/.cua-pi/config-version 2>/dev/null || true)
if git -C {shlex.quote(cache)} cat-file -e {shlex.quote(commit + "^{commit}")} 2>/dev/null || git ls-remote --exit-code {shlex.quote(remote_url)} HEAD >/dev/null 2>&1; then
  repository=1
else
  repository=0
fi
printf '%s|%s|%s|%s\n' "$address" "$free_bytes" "$config" "$repository"
"""
    else:
        cache = rf"C:\cua\cache\git\{repository_key}.git"
        script = rf"""$expected = {powershell_literal(bootstrap_digest(profile))}
if ((Get-Content -ErrorAction SilentlyContinue C:\ProgramData\cua-pi\bootstrap-version) -ne $expected) {{ exit 20 }}
if (-not (Test-Path C:\ProgramData\npm\pi.cmd)) {{ exit 21 }}
$free = [IO.DriveInfo]::new('C:\').AvailableFreeSpace
$config = Get-Content -ErrorAction SilentlyContinue C:\Users\cua\.cua-pi\config-version
$repository = 0
git -C {powershell_literal(cache)} cat-file -e {powershell_literal(commit + "^{commit}")} 2>$null
if ($LASTEXITCODE -eq 0) {{
  $repository = 1
}} else {{
  git ls-remote --exit-code {powershell_literal(remote_url)} HEAD 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) {{ $repository = 1 }}
}}
Write-Output "healthy|$free|$config|$repository"
"""
        encoded = base64.b64encode(script.encode("utf-16le")).decode()
        command = f"powershell.exe -NoProfile -EncodedCommand {encoded}"
    try:
        result = run_guest_ssh(
            name, profile, command, timeout=60, check=False, report=False
        )
    except (OSError, RuntimeError):
        return None
    if result.returncode != 0:
        return None
    fields = next(
        (
            candidate.split("|")
            for candidate in reversed(result.stdout.strip().splitlines())
            if candidate.count("|") == 3
        ),
        [],
    )
    if len(fields) != 4 or not fields[1].isdigit() or fields[3] not in {"0", "1"}:
        return None
    return GuestPreflight(
        address=name if profile == "windows" else fields[0],
        free_bytes=int(fields[1]),
        config_matches=fields[2] == config_digest,
        repository_available=fields[3] == "1",
    )


def run_guest_ssh(
    name: str,
    profile: str,
    command: str,
    *,
    timeout: int,
    stream_phase: str | None = None,
    check: bool = True,
    report: bool = True,
) -> subprocess.CompletedProcess[str]:
    if report:
        progress(f"ssh.{name}", "running remote command")
    argv = ["ssh", *ssh_options(profile), f"cua@{name}", command]
    if stream_phase is None:
        try:
            result = subprocess.run(
                argv, capture_output=True, text=True, timeout=timeout, check=False
            )
        except subprocess.TimeoutExpired as error:
            raise RuntimeError(
                f"SSH command on {name} timed out after {timeout} seconds"
            ) from error
        if check and result.returncode != 0:
            raise RuntimeError(
                f"SSH command on {name} failed with exit {result.returncode}: "
                f"{(result.stderr or result.stdout).strip()}"
            )
        return result

    # Streamed variant: forward the latest output line (git --progress updates
    # are \r-terminated) so the UI can show it live.
    import select

    process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    assert process.stdout is not None
    output = bytearray()
    pending = b""
    deadline = time.monotonic() + timeout
    last_report = 0.0
    while True:
        if time.monotonic() >= deadline:
            process.kill()
            process.wait()
            raise RuntimeError(
                f"SSH command on {name} timed out after {timeout} seconds"
            )
        ready, _, _ = select.select([process.stdout], [], [], 1.0)
        if ready:
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                break
            output += chunk
            pending += chunk
            parts = re.split(rb"[\r\n]", pending)
            pending = parts.pop()
            lines = [part for part in parts if part.strip()]
            if lines and time.monotonic() - last_report >= 1.0:
                progress(stream_phase, lines[-1].decode(errors="replace").strip()[:200])
                last_report = time.monotonic()
        elif process.poll() is not None:
            output += process.stdout.read()
            break
    returncode = process.wait()
    text_output = output.decode(errors="replace")
    if check and returncode != 0:
        raise RuntimeError(
            f"SSH command on {name} failed with exit {returncode}: "
            f"{text_output.strip()[-2000:]}"
        )
    return subprocess.CompletedProcess(argv, returncode, stdout=text_output, stderr="")


def guest_file_size(name: str, profile: str, remote_path: str) -> int | None:
    """Best-effort size of a remote file over the multiplexed ssh connection."""
    command = (
        f"stat -c %s {shlex.quote(remote_path)} 2>/dev/null || echo 0"
        if profile == "linux"
        else f"(Get-Item -LiteralPath {powershell_literal(remote_path)} -ErrorAction SilentlyContinue).Length"
    )
    try:
        result = run_guest_ssh(
            name,
            profile,
            command,
            timeout=10,
            check=False,
            report=False,
        )
        return int(result.stdout.strip().splitlines()[-1])
    except (OSError, RuntimeError, ValueError, IndexError):
        return None


def copy_guest_file(name: str, profile: str, content: bytes, remote_path: str) -> None:
    total = len(content)
    total_mib = total / 1048576
    show_progress = total >= 1024 * 1024
    size = f"{total_mib:.1f} MiB" if show_progress else f"{total} bytes"
    progress(f"scp.{name}", f"uploading {size} to {remote_path}")
    with tempfile.NamedTemporaryFile() as source:
        source.write(content)
        source.flush()
        target_path = remote_path.replace("\\", "/")
        process = subprocess.Popen(
            [
                "scp",
                *ssh_options(profile),
                source.name,
                f"cua@{name}:{target_path}",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if not show_progress:
            try:
                stdout, stderr = process.communicate(timeout=300)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise RuntimeError(
                    f"SCP upload to {name} timed out after 300 seconds"
                ) from None
        else:
            deadline = time.monotonic() + 300
            while process.poll() is None:
                if time.monotonic() >= deadline:
                    process.kill()
                    process.wait()
                    raise RuntimeError(
                        f"SCP upload to {name} timed out after 300 seconds"
                    )
                time.sleep(2)
                if process.poll() is not None:
                    break
                remote_size = guest_file_size(name, profile, remote_path)
                if remote_size:
                    percent = min(100, remote_size * 100 // total)
                    progress(
                        f"scp.{name}",
                        f"uploading {remote_path}: "
                        f"{remote_size / 1048576:.1f}/{total_mib:.1f} MiB ({percent}%)",
                    )
            stdout, stderr = process.communicate()
    if process.returncode != 0:
        raise RuntimeError(
            f"SCP upload to {name} failed with exit {process.returncode}: "
            f"{(stderr or stdout).strip()}"
        )
    progress(f"scp.{name}", f"uploaded {size} to {remote_path}")


def guest_config_archive(files: dict[str, bytes]) -> bytes:
    manifest = "".join(f"{path}\n" for path in sorted(files))
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for path, content in files.items():
            info = tarfile.TarInfo(path)
            info.size = len(content)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(content))
        content = manifest.encode()
        info = tarfile.TarInfo(".cua-pi/config-files.new")
        info.size = len(content)
        info.mode = 0o600
        archive.addfile(info, io.BytesIO(content))
    return buffer.getvalue()


def sync_guest_config(name: str, profile: str, content: bytes, digest: str) -> None:
    if profile == "linux":
        version_path = "/home/cua/.cua-pi/config-version"
        archive_path = f"/tmp/cua-pi-config-{digest}.tgz"
        copy_guest_file(name, profile, content, archive_path)
        command = f"""set -eu
mkdir -p /home/cua/.cua-pi
if [ -f /home/cua/.cua-pi/config-files ]; then
  while IFS= read -r path; do
    case "$path" in .pi/agent/*) rm -f -- "/home/cua/$path" ;; esac
  done < /home/cua/.cua-pi/config-files
fi
tar -xzf {shlex.quote(archive_path)} -C /home/cua
mv /home/cua/.cua-pi/config-files.new /home/cua/.cua-pi/config-files
printf '%s\n' {shlex.quote(digest)} > {shlex.quote(version_path)}
rm -f {shlex.quote(archive_path)}
"""
    else:
        version_path = r"C:\Users\cua\.cua-pi\config-version"
        archive_path = rf"C:\Windows\Temp\cua-pi-config-{digest}.tgz"
        copy_guest_file(name, profile, content, archive_path)
        command = rf"""$ErrorActionPreference = 'Stop'
$cuaHome = 'C:\Users\cua'
$state = Join-Path $cuaHome '.cua-pi'
$manifest = Join-Path $state 'config-files'
New-Item -ItemType Directory -Force -Path $state | Out-Null
if (Test-Path $manifest) {{
  Get-Content $manifest | ForEach-Object {{
    if ($_.StartsWith('.pi/agent/') -and $_ -ne '.pi/agent/cua-tool-broker.mjs') {{
      Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $cuaHome ($_.Replace('/', '\\')))
    }}
  }}
}}
tar.exe -xzf {powershell_literal(archive_path)} -C $cuaHome
Move-Item -Force (Join-Path $state 'config-files.new') $manifest
Set-Content -NoNewline -Path {powershell_literal(version_path)} -Value {powershell_literal(digest)}
Remove-Item -Force {powershell_literal(archive_path)}
"""
    run_guest_ssh(name, profile, command, timeout=120)


def git_snapshot(root: Path, commit: str) -> bytes:
    return subprocess.run(
        ["git", "-C", str(root), "archive", "--format=tar.gz", commit],
        check=True,
        capture_output=True,
        timeout=300,
    ).stdout


async def prepare_workspace(
    name: str,
    profile: str,
    source: WorkspaceRepository,
    workspace_id: str,
    *,
    repository_available: bool,
) -> str:
    progress(f"workspace.{name}.baseline", f"preparing {source.root}")
    repository_key = hashlib.sha256(source.remote_url.encode()).hexdigest()[:20]
    if profile == "linux":
        workspace_root = f"/home/cua/workspaces/{workspace_id}"
        repository_cache = f"/home/cua/.cache/cua-pi/git/{repository_key}.git"
        snapshot_path = f"/tmp/cua-snapshot-{workspace_id}.tgz"
        if not repository_available:
            progress(
                f"workspace.{name}.snapshot",
                "origin is unavailable; sending a local commit snapshot",
            )
            copy_guest_file(
                name, profile, git_snapshot(source.root, source.commit), snapshot_path
            )
        remote_setup = f"""if [ ! -d {shlex.quote(repository_cache)} ]; then
  git clone --mirror --progress {shlex.quote(source.remote_url)} {shlex.quote(repository_cache)}
elif ! git -C {shlex.quote(repository_cache)} cat-file -e {shlex.quote(source.commit + "^{commit}")} 2>/dev/null; then
  git -C {shlex.quote(repository_cache)} fetch --progress origin {shlex.quote(source.commit)}
fi
if [ ! -d {shlex.quote(workspace_root)}/.git ]; then
  git clone --shared --no-checkout {shlex.quote(repository_cache)} {shlex.quote(workspace_root)}
  git -C {shlex.quote(workspace_root)} remote set-url origin {shlex.quote(source.remote_url)}
fi
if ! git -C {shlex.quote(workspace_root)} cat-file -e {shlex.quote(source.commit + "^{commit}")} 2>/dev/null; then
  git -C {shlex.quote(workspace_root)} fetch --depth=1 --progress origin {shlex.quote(source.commit)}
fi
git -C {shlex.quote(workspace_root)} checkout --detach --force {shlex.quote(source.commit)}
git -C {shlex.quote(workspace_root)} clean -ffd"""
        snapshot_setup = f"""mkdir -p {shlex.quote(workspace_root)}
if [ -d {shlex.quote(workspace_root)}/.git ]; then
  git -C {shlex.quote(workspace_root)} rm -rf --ignore-unmatch -- .
  git -C {shlex.quote(workspace_root)} clean -ffd
else
  git -C {shlex.quote(workspace_root)} init -q
  git -C {shlex.quote(workspace_root)} config user.name pi-cua
  git -C {shlex.quote(workspace_root)} config user.email pi-cua@localhost
fi
tar -xzf {shlex.quote(snapshot_path)} -C {shlex.quote(workspace_root)}
git -C {shlex.quote(workspace_root)} add -A
git -C {shlex.quote(workspace_root)} -c commit.gpgsign=false commit --allow-empty -qm 'pi-cua workspace baseline'
if git -C {shlex.quote(workspace_root)} remote get-url origin >/dev/null 2>&1; then
  git -C {shlex.quote(workspace_root)} remote set-url origin {shlex.quote(source.remote_url)}
else
  git -C {shlex.quote(workspace_root)} remote add origin {shlex.quote(source.remote_url)}
fi
rm -f {shlex.quote(snapshot_path)}"""
        command = f"""set -eu
mkdir -p /home/cua/workspaces /home/cua/.cache/cua-pi/git
{remote_setup if repository_available else snapshot_setup}
"""
        run_guest_ssh(
            name,
            profile,
            command,
            timeout=1200,
            stream_phase=f"workspace.{name}.sync",
        )
        return str(
            PurePosixPath(workspace_root)
            / PurePosixPath(source.relative_cwd.as_posix())
        )

    workspace_root = rf"C:\cua\workspaces\{workspace_id}"
    repository_cache = rf"C:\cua\cache\git\{repository_key}.git"
    snapshot_path = rf"C:\Windows\Temp\cua-snapshot-{workspace_id}.tgz"
    if not repository_available:
        progress(
            f"workspace.{name}.snapshot",
            "origin is unavailable; sending a local commit snapshot",
        )
        copy_guest_file(
            name, profile, git_snapshot(source.root, source.commit), snapshot_path
        )
    remote_setup = f"""if (-not (Test-Path $cache)) {{ git clone --quiet --mirror {powershell_literal(source.remote_url)} $cache }} elseif (-not (Test-GitCommit $cache '{source.commit}')) {{ git -C $cache fetch --quiet origin {source.commit} }}
if (-not (Test-Path "$root\\.git")) {{ git clone --quiet --shared --no-checkout $cache $root; git -C $root remote set-url origin {powershell_literal(source.remote_url)} }}
if (-not (Test-GitCommit $root '{source.commit}')) {{ git -C $root fetch --quiet --depth=1 origin {source.commit} }}
git -C $root checkout --quiet --detach --force {source.commit}
git -C $root clean -ffd"""
    snapshot_setup = f"""New-Item -ItemType Directory -Force -Path $root | Out-Null
if (Test-Path "$root\\.git") {{
  git -C $root rm -rf --ignore-unmatch -- .
  git -C $root clean -ffd
}} else {{
  git -C $root init -q
  git -C $root config user.name pi-cua
  git -C $root config user.email pi-cua@localhost
}}
tar.exe -xzf {powershell_literal(snapshot_path)} -C $root
git -C $root add -A
git -C $root -c commit.gpgsign=false commit --allow-empty -qm 'pi-cua workspace baseline'
git -C $root remote get-url origin 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {{ git -C $root remote set-url origin {powershell_literal(source.remote_url)} }} else {{ git -C $root remote add origin {powershell_literal(source.remote_url)} }}
Remove-Item -Force {powershell_literal(snapshot_path)}"""
    script = f"""$ErrorActionPreference = 'Stop'
function Test-GitCommit([string]$Repository, [string]$Commit) {{
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {{
    git -C $Repository cat-file -e "${{Commit}}^{{commit}}" 2>$null
    return $LASTEXITCODE -eq 0
  }} finally {{
    $ErrorActionPreference = $previousErrorActionPreference
  }}
}}
$root = {powershell_literal(workspace_root)}
$cache = {powershell_literal(repository_cache)}
New-Item -ItemType Directory -Force -Path 'C:\\cua\\workspaces','C:\\cua\\cache\\git' | Out-Null
{remote_setup if repository_available else snapshot_setup}
"""
    encoded_script = base64.b64encode(script.encode("utf-16le")).decode()
    run_guest_ssh(
        name,
        profile,
        f"powershell.exe -NoProfile -EncodedCommand {encoded_script}",
        timeout=1800,
        stream_phase=f"workspace.{name}.sync",
    )
    relative_windows = PureWindowsPath(*source.relative_cwd.parts)
    return str(PureWindowsPath(workspace_root) / relative_windows)


def sandbox_workspace_exists(name: str, profile: str, cwd: str) -> bool:
    if profile == "linux":
        match = re.match(r"^(/home/cua/workspaces/[0-9a-f]{16})(?:/|$)", cwd)
        command = f"test -d {shlex.quote(match.group(1) if match else '')}/.git"
    else:
        match = re.match(
            r"^(C:\\cua\\workspaces\\[0-9a-f]{16})(?:\\|$)", cwd, re.IGNORECASE
        )
        root = match.group(1) if match else ""
        command = (
            'powershell.exe -NoProfile -Command "if(Test-Path '
            + powershell_literal(root + r"\.git")
            + '){exit 0}else{exit 1}"'
        )
    if match is None:
        raise ValueError("saved sandbox workspace path is invalid")
    result = run_guest_ssh(name, profile, command, timeout=30, check=False)
    if result.returncode not in {0, 1}:
        raise RuntimeError(
            result.stderr or f"workspace probe exited {result.returncode}"
        )
    return result.returncode == 0


def workspace_location(name: str, profile: str, cwd: str) -> tuple[str, str]:
    if profile == "linux":
        command = f"""set -eu
root=$(git -C {shlex.quote(cwd)} rev-parse --show-toplevel)
case "$root" in /home/cua/workspaces/*) ;; *) exit 1;; esac
printf '%s\\n' "$root"
realpath --relative-to="$root" {shlex.quote(cwd)}
"""
    else:
        command = rf"""$cwd = [IO.Path]::GetFullPath({powershell_literal(cwd)}).TrimEnd('\')
$root = [IO.Path]::GetFullPath((git -C $cwd rev-parse --show-toplevel).Trim()).TrimEnd('\')
$prefix = [IO.Path]::GetFullPath('C:\cua\workspaces').TrimEnd('\') + '\'
if (-not $root.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {{ exit 1 }}
Write-Output $root
if ($cwd.Equals($root, [StringComparison]::OrdinalIgnoreCase)) {{ Write-Output '.' }} else {{ Write-Output $cwd.Substring($root.Length + 1) }}
"""
    lines = run_guest_ssh(name, profile, command, timeout=60).stdout.splitlines()
    if len(lines) < 2:
        raise RuntimeError(f"could not locate workspace on {name}")
    return lines[-2], lines[-1]


def cleanup_workspace_root(name: str, profile: str, root: str) -> None:
    if profile == "linux":
        if not re.fullmatch(r"/home/cua/workspaces/[0-9a-f]{16}", root):
            raise RuntimeError("refusing to remove an invalid Linux workspace path")
        command = f"rm -rf -- {shlex.quote(root)}"
    else:
        if not re.fullmatch(r"C:\\cua\\workspaces\\[0-9a-f]{16}", root, re.IGNORECASE):
            raise RuntimeError("refusing to remove an invalid Windows workspace path")
        command = f"Remove-Item -Recurse -Force -ErrorAction SilentlyContinue {powershell_literal(root)}"
    run_guest_ssh(name, profile, command, timeout=600)


def cleanup_sandbox_workspace(source: SandboxWorkspaceSource) -> dict[str, Any]:
    root, _ = workspace_location(source["address"], source["os"], source["remoteCwd"])
    cleanup_workspace_root(source["address"], source["os"], root)
    return {"removed": True}


def capture_local_workspace(repository: WorkspaceRepository) -> WorkspaceTransfer:
    local_root, baseline_tree = workspace_tree(repository.root)
    commit_tree = git_output(local_root, "rev-parse", "HEAD^{tree}")
    state = WorkspaceState(
        version=1,
        localRoot=str(local_root),
        commit=repository.commit,
        commitTree=commit_tree,
        baselineTree=baseline_tree,
    )
    return WorkspaceTransfer(
        state=state,
        patch=workspace_patch(local_root, commit_tree, baseline_tree),
        final_tree=baseline_tree,
    )


def parse_numstat(output: str) -> tuple[int, int]:
    additions = 0
    deletions = 0
    for line in output.splitlines():
        fields = line.split("\t", 2)
        if len(fields) < 2:
            continue
        if fields[0].isdigit():
            additions += int(fields[0])
        if fields[1].isdigit():
            deletions += int(fields[1])
    return additions, deletions


def remote_workspace_numstat(
    name: str,
    profile: str,
    root: str,
    before_tree: str,
    after_tree: str,
) -> tuple[int, int]:
    if profile == "linux":
        command = (
            f"git -C {shlex.quote(root)} diff --numstat {before_tree} {after_tree} --"
        )
    else:
        command = (
            f"git -C {powershell_literal(root)} diff --numstat "
            f"{before_tree} {after_tree} --"
        )
    result = run_guest_ssh(name, profile, command, timeout=60, report=False)
    return parse_numstat(result.stdout)


def workspace_diff_status(
    source: SandboxWorkspaceSource, local_cwd: str
) -> dict[str, Any]:
    state = source["state"]
    local_root = Path(state["localRoot"]).resolve()
    requested_root = Path(
        git_output(Path(local_cwd), "rev-parse", "--show-toplevel")
    ).resolve()
    if requested_root != local_root:
        raise RuntimeError("local workspace path changed since sandbox activation")

    _, local_tree = workspace_tree(local_root)
    source_root, _ = workspace_location(
        source["address"], source["os"], source["remoteCwd"]
    )
    final_tree = remote_workspace_tree(source["address"], source["os"], source_root)
    additions, deletions = remote_workspace_numstat(
        source["address"],
        source["os"],
        source_root,
        state["commitTree"],
        final_tree,
    )
    return {
        "additions": additions,
        "deletions": deletions,
        "pending_sync": final_tree != state["baselineTree"],
        "sync_safe": local_tree == state["baselineTree"],
    }


def capture_sandbox_patch(
    source: SandboxWorkspaceSource, base_tree: str
) -> tuple[bytes, str]:
    source_root, _ = workspace_location(
        source["address"], source["os"], source["remoteCwd"]
    )
    final_tree = remote_workspace_tree(source["address"], source["os"], source_root)
    patch = remote_workspace_patch(
        source["address"], source["os"], source_root, base_tree, final_tree
    )
    return patch, final_tree


def capture_sandbox_workspace(source: SandboxWorkspaceSource) -> WorkspaceTransfer:
    patch, final_tree = capture_sandbox_patch(source, source["state"]["commitTree"])
    return WorkspaceTransfer(state=source["state"], patch=patch, final_tree=final_tree)


def restore_sandbox_workspace(
    name: str,
    profile: str,
    root: str,
    transfer: WorkspaceTransfer,
    reference: str,
) -> None:
    if transfer.patch:
        progress("workspace.destination.apply", "applying workspace changes")
        apply_remote_workspace_patch(
            name,
            profile,
            root,
            transfer.patch,
            transfer.final_tree,
            reference=f"{reference}/workspace",
        )
    elif transfer.final_tree != transfer.state["commitTree"]:
        raise RuntimeError("empty workspace patch does not match the Git baseline")


def sync_workspace_to_local(
    source: SandboxWorkspaceSource, local_cwd: str
) -> dict[str, Any]:
    workspace_state = source["state"]
    local_root = Path(workspace_state["localRoot"]).resolve()
    requested_root = Path(
        git_output(Path(local_cwd), "rev-parse", "--show-toplevel")
    ).resolve()
    if requested_root != local_root:
        raise RuntimeError("local workspace path changed since sandbox activation")

    progress("workspace.local.verify", "checking the local workspace baseline")
    _, local_tree = workspace_tree(local_root)
    if local_tree != workspace_state["baselineTree"]:
        raise RuntimeError(
            "local workspace changed while the sandbox was active; restore it to the departure state before syncing"
        )

    progress("workspace.local.diff", "capturing sandbox changes")
    current_patch, final_tree = capture_sandbox_patch(
        source, workspace_state["baselineTree"]
    )
    progress(
        "workspace.local.apply",
        f"applying {len(current_patch) / 1048576:.1f} MiB of sandbox changes",
    )
    try:
        apply_workspace_patch(local_root, current_patch, final_tree)
    except subprocess.CalledProcessError as error:
        raise RuntimeError(
            "sandbox changes do not apply cleanly to the local workspace"
        ) from error
    return {"local_cwd": local_cwd, "changed": bool(current_patch)}


async def prepare_execution(
    name: str,
    source_cwd: str,
    workspace_key: str,
    source: SandboxWorkspaceSource | None = None,
    resume: SandboxWorkspaceSource | None = None,
    tool_packages: tuple[str, ...] = (),
) -> dict[str, Any]:
    states = {item["name"]: item for item in managed_sandboxes()}
    if name not in states:
        raise ValueError(f"unknown managed sandbox: {name}")
    profile = states[name]["os"]
    if source and resume:
        raise ValueError("prepare_execution cannot transfer and resume simultaneously")
    if resume and resume["os"] != profile:
        raise ValueError("saved sandbox profile does not match its controller record")
    repository = inspect_workspace(Path(source_cwd).expanduser().resolve())
    config_files = guest_config_files(tool_packages)
    guest_digest = config_digest(config_files)
    candidate = states[name].get("address") or name
    progress("sandbox.preflight", "checking health, configuration, disk, and cache")
    preflight = guest_preflight(
        candidate,
        profile,
        repository.remote_url,
        repository.commit,
        guest_digest,
    )
    if preflight is None:
        raise SandboxRepairRequired(f"sandbox repair required: {name}")

    address = preflight.address
    if preflight.free_bytes < 1024**3:
        raise RuntimeError(
            "workspace setup requires 1 GiB free; "
            f"only {preflight.free_bytes // 1048576} MiB is available"
        )
    if not preflight.config_matches:
        sync_guest_config(
            address,
            profile,
            guest_config_archive(config_files),
            guest_digest,
        )
    if resume and sandbox_workspace_exists(address, profile, resume["remoteCwd"]):
        return {
            "name": name,
            "os": profile,
            "address": address,
            "remote_cwd": resume["remoteCwd"],
            "workspace_state": resume["state"],
        }

    transfer = (
        capture_sandbox_workspace(source)
        if source
        else capture_local_workspace(repository)
    )
    if source:
        repository = WorkspaceRepository(
            root=repository.root,
            relative_cwd=repository.relative_cwd,
            remote_url=repository.remote_url,
            commit=transfer.state["commit"],
        )
    workspace_digest = hashlib.sha256(workspace_key.encode()).hexdigest()
    reference = workspace_digest[:32]
    workspace_id = workspace_digest[:16]
    workspace_root = (
        f"/home/cua/workspaces/{workspace_id}"
        if profile == "linux"
        else rf"C:\cua\workspaces\{workspace_id}"
    )
    try:
        remote_cwd = await prepare_workspace(
            address,
            profile,
            repository,
            workspace_id,
            repository_available=preflight.repository_available,
        )
        progress("workspace.baseline", "reconstructing the destination workspace")
        restore_sandbox_workspace(address, profile, workspace_root, transfer, reference)
    except BaseException:
        try:
            progress("workspace.destination.cleanup", "removing incomplete workspace")
            cleanup_workspace_root(address, profile, workspace_root)
        except Exception as cleanup_error:  # noqa: BLE001 - preserve the setup failure
            progress(
                "workspace.destination.cleanup",
                f"cleanup failed: {error_text(cleanup_error)}",
            )
        raise
    return {
        "name": name,
        "os": profile,
        "address": address,
        "remote_cwd": remote_cwd,
        "workspace_state": transfer.state,
    }


async def dispatch(request: dict[str, Any]) -> dict[str, Any]:
    action = request.get("action")
    if action == "list":
        online = online_tailscale_hosts()
        items = [
            {
                **item,
                "online": item["name"].lower() in online
                or str(item.get("address") or "").lower() in online,
            }
            for item in managed_sandboxes()
        ]
        return {"sandboxes": items}
    if action == "cleanup_workspace":
        return cleanup_sandbox_workspace(require_sandbox_source(request.get("source")))
    if action in {"sync_workspace_to_local", "workspace_diff_status"}:
        local_cwd = request.get("local_cwd")
        if not isinstance(local_cwd, str) or not local_cwd:
            raise TypeError(f"{action} requires local_cwd")
        source = require_sandbox_source(request.get("source"))
        if action == "workspace_diff_status":
            return workspace_diff_status(source, local_cwd)
        return sync_workspace_to_local(source, local_cwd)
    if action in CLOUD_ACTIONS:
        configure_fleet_auth()
    if action == "create":
        return await create_one(
            str(request.get("os") or ""),
            request.get("name"),
            request.get("cpu"),
            request.get("memory_mb"),
            request.get("image"),
        )
    if action == "ensure":
        return await ensure_one(str(request.get("name") or ""))
    if action == "delete":
        return await delete_one(str(request.get("name") or ""))
    if action == "prepare_execution":
        workspace_key = request.get("workspace_id")
        if not isinstance(workspace_key, str) or not workspace_key:
            raise ValueError("prepare_execution requires workspace_id")
        source_value = request.get("source")
        source = (
            require_sandbox_source(source_value) if source_value is not None else None
        )
        tool_packages = request.get("tool_packages", [])
        if not isinstance(tool_packages, list) or any(
            not isinstance(package, str)
            or not package.startswith(("git:", "npm:", "https://", "http://", "ssh://"))
            or "pi-cua" in package.lower()
            for package in tool_packages
        ):
            raise TypeError("tool_packages contains an unsupported package source")
        resume_value = request.get("resume")
        resume = (
            require_sandbox_source(resume_value) if resume_value is not None else None
        )
        return await prepare_execution(
            str(request.get("name") or ""),
            str(request.get("source_cwd") or ""),
            workspace_key,
            source,
            resume,
            tuple(dict.fromkeys(tool_packages)),
        )
    raise ValueError(
        "action must be list, create, ensure, delete, prepare_execution, sync_workspace_to_local, cleanup_workspace, or workspace_diff_status"
    )


def main() -> None:
    try:
        if len(sys.argv) != 2:
            raise ValueError("expected one JSON request argument")
        request = json.loads(sys.argv[1])
        if not isinstance(request, dict):
            raise TypeError("request must be a JSON object")
        action = str(request.get("action") or "")
        migrate_legacy_sandbox_records()
        if action in CLOUD_ACTIONS and os.environ.get("CUA_CLOUD_WORKER") != "1":
            environment = {**os.environ, "CUA_CLOUD_WORKER": "1"}
            os.execvpe("uv", cloud_worker_command(request), environment)

        signal.signal(signal.SIGTERM, cancel_worker)
        quiet_request = action in {"list", "workspace_diff_status"}
        if not quiet_request:
            progress("request", "accepted", action=action, name=request.get("name"))
        if action in {
            "create",
            "ensure",
            "delete",
            "prepare_execution",
            "sync_workspace_to_local",
            "cleanup_workspace",
        }:
            progress("lock", "waiting for controller mutation lock")
            with operation_lock(CONTROLLER_LOCK):
                progress("lock", "acquired controller mutation lock")
                result = asyncio.run(dispatch(request))
        else:
            result = asyncio.run(dispatch(request))
        if not quiet_request:
            progress("complete", "operation succeeded")
        print(json.dumps({"ok": True, **result}, separators=(",", ":")))
    except Exception as error:  # noqa: BLE001 - process boundary returns all failures as JSON
        cancelled = isinstance(error, OperationCancelled)
        progress(
            CURRENT_PHASE,
            "operation cancelled" if cancelled else "operation failed",
            error=error_text(error),
        )
        print(
            json.dumps(
                {
                    "ok": False,
                    "phase": CURRENT_PHASE,
                    "error_type": type(error).__name__,
                    "error": error_text(error),
                },
                separators=(",", ":"),
            )
        )
        raise SystemExit(1)


if __name__ == "__main__":
    main()
