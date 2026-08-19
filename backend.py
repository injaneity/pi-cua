"""Provision CUA claims and stage Pi sessions for the TypeScript extension.

CUA publishes a Python SDK but no TypeScript SDK. This process boundary keeps Fleet
credentials and platform bootstrap logic out of the Pi extension. Every invocation
accepts one JSON argument and writes one JSON result to stdout; diagnostics stay on
stderr. Named claims remain indexed by cua-sandbox in ``~/.cua/sandboxes``.
"""

from __future__ import annotations

import asyncio
import fcntl
import hashlib
import importlib.util
import io
import json
import os
import re
import shlex
import signal
import sqlite3
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
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

# uv-managed CPython ships without default CA verify paths, so stdlib
# urlopen to api.tailscale.com fails CERTIFICATE_VERIFY_FAILED unless a
# bundle is named explicitly.
if "SSL_CERT_FILE" not in os.environ:
    try:
        import certifi

        os.environ["SSL_CERT_FILE"] = certifi.where()
    except ImportError:
        if os.path.exists("/etc/ssl/cert.pem"):
            os.environ["SSL_CERT_FILE"] = "/etc/ssl/cert.pem"

HOME = Path.home()
STATE_DIR = HOME / ".cua" / "sandboxes"
PI_DIR = HOME / ".pi" / "agent"
CONTROLLER_DIR = HOME / ".cua" / "pi-controller"
CONTROLLER_DB = CONTROLLER_DIR / "state.sqlite3"
CONTROLLER_LOCK = CONTROLLER_DIR / "operations.lock"
OPERATION_DIR = CONTROLLER_DIR / "operations"
CURRENT_OPERATION_ID: str | None = None
CURRENT_PHASE = "startup"
LONG_ACTIONS = {
    "create",
    "ensure",
    "delete",
    "prepare_execution",
}
FLEET_KEYCHAIN_SERVICE = "cua-sandbox-fleet-api"
TAILSCALE_KEYCHAIN_SERVICE = "cua-sandbox-tailscale-oauth"
TAILSCALE_TOKEN_URL = "https://api.tailscale.com/api/v2/oauth/token"
TAILSCALE_API_URL = "https://api.tailscale.com/api/v2"
WINDOWS_PUBLIC_KEY = HOME / ".ssh" / "cua_windows_ed25519.pub"

PROFILES = {
    "linux": {
        # Fleet pool/namespace names are a tenant-wide authorization boundary:
        # if another tenant already owns the default namespace, every pool
        # operation fails with a persistent 403. CUA_PI_LINUX_POOL /
        # CUA_PI_WINDOWS_POOL let each tenant pick unclaimed names.
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


def prune_operation_logs(keep: int = 100) -> None:
    if not OPERATION_DIR.exists():
        return
    logs = sorted(
        OPERATION_DIR.glob("*.jsonl"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for path in logs[keep:]:
        path.unlink(missing_ok=True)
        path.with_name(f"{path.stem}.console.log").unlink(missing_ok=True)


def error_text(error: BaseException) -> str:
    text = str(error).strip()
    return text if text else repr(error)


def update_operation_progress(phase: str, message: str) -> None:
    if not CURRENT_OPERATION_ID or not CONTROLLER_DB.exists():
        return
    try:
        with database() as connection:
            connection.execute(
                """
                UPDATE operations
                SET phase = ?, message = ?, updated_at = ?
                WHERE id = ? AND state IN ('queued', 'running', 'cancel_requested')
                """,
                (
                    phase,
                    message,
                    datetime.now(timezone.utc).isoformat(),
                    CURRENT_OPERATION_ID,
                ),
            )
    except sqlite3.Error as error:
        print(
            f"warning: failed to update operation state: {error_text(error)}",
            file=sys.stderr,
            flush=True,
        )


def progress(phase: str, message: str, **details: Any) -> None:
    global CURRENT_PHASE
    CURRENT_PHASE = phase
    event = {
        "at": datetime.now(timezone.utc).isoformat(),
        "operation_id": CURRENT_OPERATION_ID,
        "phase": phase,
        "message": message,
        **details,
    }
    if CURRENT_OPERATION_ID:
        OPERATION_DIR.mkdir(parents=True, exist_ok=True)
        path = OPERATION_DIR / f"{CURRENT_OPERATION_ID}.jsonl"
        with path.open("a") as stream:
            stream.write(json.dumps(event, separators=(",", ":")) + "\n")
    update_operation_progress(phase, message)
    print(
        f"[cua {CURRENT_OPERATION_ID or '-'}] {phase}: {message}",
        file=sys.stderr,
        flush=True,
    )


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
    """Hash every input that ensure must reproduce inside a guest."""
    digest = hashlib.sha256()
    digest.update(profile.encode())
    digest.update(pi_version().encode())
    digest.update(bootstrap_template(profile).encode())
    for path, content in sorted(remote_pi_files().items()):
        digest.update(path.encode())
        digest.update(content)
    return digest.hexdigest()[:20]


@contextmanager
def operation_lock() -> Iterator[None]:
    """Serialize mutating operations across Pi processes and parallel tools."""
    CONTROLLER_DIR.mkdir(parents=True, exist_ok=True)
    with CONTROLLER_LOCK.open("a+") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)


@contextmanager
def database() -> Iterator[sqlite3.Connection]:
    CONTROLLER_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(CONTROLLER_DB)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS operations (
            id TEXT PRIMARY KEY,
            action TEXT NOT NULL,
            request_json TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancel_requested', 'cancelled')),
            phase TEXT NOT NULL,
            message TEXT NOT NULL,
            worker_pid INTEGER,
            result_json TEXT,
            error_type TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sandboxes (
            name TEXT PRIMARY KEY,
            os TEXT NOT NULL CHECK (os IN ('linux', 'windows')),
            pool_name TEXT NOT NULL,
            claim_reference TEXT NOT NULL,
            tailscale_tailnet TEXT,
            tailscale_device_id TEXT,
            tailscale_addresses TEXT,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS execution_targets (
            session_id TEXT PRIMARY KEY,
            session_file TEXT,
            target_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS execution_targets_session_file
            ON execution_targets(session_file) WHERE session_file IS NOT NULL;
        """
    )
    sandbox_columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(sandboxes)")
    }
    for column in ("tailscale_tailnet", "tailscale_device_id", "tailscale_addresses"):
        if column not in sandbox_columns:
            connection.execute(f"ALTER TABLE sandboxes ADD COLUMN {column} TEXT")
    try:
        yield connection
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()


def get_execution_target(
    session_id: str = "", session_file: str = ""
) -> dict[str, Any]:
    with database() as connection:
        row = None
        if session_id:
            row = connection.execute(
                "SELECT target_json FROM execution_targets WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        if row is None and session_file:
            row = connection.execute(
                "SELECT target_json FROM execution_targets WHERE session_file = ?",
                (str(Path(session_file).expanduser().resolve()),),
            ).fetchone()
    return {"target": json.loads(row["target_json"]) if row else None}


def set_execution_target(
    session_id: str, session_file: str, target: object
) -> dict[str, Any]:
    if not session_id:
        raise ValueError("set_execution_target requires session_id")
    if not isinstance(target, dict) or target.get("kind") not in {"local", "sandbox"}:
        raise ValueError("set_execution_target requires a valid target")
    resolved_file = (
        str(Path(session_file).expanduser().resolve()) if session_file else None
    )
    with database() as connection:
        connection.execute(
            """
            INSERT INTO execution_targets (session_id, session_file, target_json, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                session_file = excluded.session_file,
                target_json = excluded.target_json,
                updated_at = excluded.updated_at
            """,
            (
                session_id,
                resolved_file,
                json.dumps(target, separators=(",", ":")),
                datetime.now(timezone.utc).isoformat(),
            ),
        )
    return {"target": target}


def record_sandbox(name: str, profile: str, reference: dict[str, Any]) -> None:
    pool_name = reference.get("pool")
    if not isinstance(pool_name, str):
        raise TypeError("CUA claim reference has no pool")
    now = datetime.now(timezone.utc).isoformat()
    with database() as connection:
        connection.execute(
            """
            INSERT INTO sandboxes (name, os, pool_name, claim_reference, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
                os = excluded.os,
                pool_name = excluded.pool_name,
                claim_reference = excluded.claim_reference,
                updated_at = excluded.updated_at
            """,
            (name, profile, pool_name, json.dumps(reference), now),
        )


def record_tailscale_enrollment(
    name: str, tailnet: str, node_id: str, addresses: list[str]
) -> None:
    with database() as connection:
        cursor = connection.execute(
            """
            UPDATE sandboxes
            SET tailscale_tailnet = ?, tailscale_device_id = ?,
                tailscale_addresses = ?, updated_at = ?
            WHERE name = ?
            """,
            (
                tailnet,
                node_id,
                json.dumps(addresses),
                datetime.now(timezone.utc).isoformat(),
                name,
            ),
        )
        if cursor.rowcount != 1:
            raise RuntimeError(
                f"cannot record Tailscale device for unknown sandbox: {name}"
            )


def remove_sandbox_record(name: str) -> None:
    with database() as connection:
        connection.execute("DELETE FROM sandboxes WHERE name = ?", (name,))


def controller_sandboxes() -> list[dict[str, Any]]:
    with database() as connection:
        rows = connection.execute(
            "SELECT name, os, pool_name FROM sandboxes ORDER BY name"
        ).fetchall()
    return [
        {"name": row["name"], "os": row["os"], "pool": row["pool_name"]} for row in rows
    ]


def restore_cua_state(name: str) -> None:
    state_path = STATE_DIR / f"{name}.json"
    if state_path.exists():
        return
    with database() as connection:
        row = connection.execute(
            "SELECT pool_name FROM sandboxes WHERE name = ?", (name,)
        ).fetchone()
    if row is None:
        return
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    temporary = state_path.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(
            {
                "name": name,
                "runtime_type": "fleet",
                "pool_name": row["pool_name"],
                "status": "running",
                "created_at": datetime.now(timezone.utc).isoformat(),
            },
            indent=2,
        )
        + "\n"
    )
    os.replace(temporary, state_path)


def submit_operation(request: dict[str, Any], operation_id: str) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    action = str(request.get("action") or "")
    with database() as connection:
        connection.execute(
            """
            INSERT INTO operations (
                id, action, request_json, state, phase, message, created_at, updated_at
            ) VALUES (?, ?, ?, 'queued', 'queue', 'waiting for worker', ?, ?)
            """,
            (operation_id, action, json.dumps(request), now, now),
        )

    OPERATION_DIR.mkdir(parents=True, exist_ok=True)
    console_path = OPERATION_DIR / f"{operation_id}.console.log"
    environment = {
        **os.environ,
        "CUA_DETACHED_WORKER": "1",
        "CUA_OPERATION_ID": operation_id,
        "PYTHONUNBUFFERED": "1",
    }
    try:
        with console_path.open("ab", buffering=0) as console:
            process = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), json.dumps(request)],
                stdin=subprocess.DEVNULL,
                stdout=console,
                stderr=console,
                env=environment,
                start_new_session=True,
                close_fds=True,
            )
    except OSError as error:
        finish_operation(
            operation_id,
            "failed",
            error_type=type(error).__name__,
            error=error_text(error),
        )
        raise

    with database() as connection:
        connection.execute(
            """
            UPDATE operations
            SET worker_pid = ?, message = 'worker started', updated_at = ?
            WHERE id = ?
            """,
            (process.pid, datetime.now(timezone.utc).isoformat(), operation_id),
        )
    return operation_status(operation_id)


def finish_operation(
    operation_id: str,
    state: str,
    *,
    result: dict[str, Any] | None = None,
    error_type: str | None = None,
    error: str | None = None,
) -> None:
    now = datetime.now(timezone.utc).isoformat()
    with database() as connection:
        connection.execute(
            """
            UPDATE operations
            SET state = ?, result_json = ?, error_type = ?, error = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                state,
                json.dumps(result) if result is not None else None,
                error_type,
                error,
                now,
                operation_id,
            ),
        )


def operation_status(operation_id: str) -> dict[str, Any]:
    with database() as connection:
        row = connection.execute(
            "SELECT * FROM operations WHERE id = ?", (operation_id,)
        ).fetchone()
    if row is None:
        raise ValueError(f"unknown operation: {operation_id}")
    item = dict(row)
    if item["state"] in {"queued", "running", "cancel_requested"} and isinstance(
        item.get("worker_pid"), int
    ):
        try:
            os.kill(item["worker_pid"], 0)
        except ProcessLookupError:
            finish_operation(
                operation_id,
                "failed",
                error_type="WorkerExited",
                error="detached worker exited without recording a terminal result",
            )
            return operation_status(operation_id)
        except PermissionError:
            pass
    raw_result = item.pop("result_json", None)
    result = json.loads(raw_result) if raw_result else None
    item.pop("request_json", None)
    item["operation_id"] = item.pop("id")
    item["operation_log"] = str(OPERATION_DIR / f"{operation_id}.jsonl")
    item["console_log"] = str(OPERATION_DIR / f"{operation_id}.console.log")
    if result is not None:
        item["result"] = result
    return item


def cancel_operation(operation_id: str) -> dict[str, Any]:
    status = operation_status(operation_id)
    if status["state"] in {"succeeded", "failed", "cancelled"}:
        return status
    pid = status.get("worker_pid")
    with database() as connection:
        connection.execute(
            """
            UPDATE operations
            SET state = 'cancel_requested', phase = 'cancel',
                message = 'termination requested', updated_at = ?
            WHERE id = ?
            """,
            (datetime.now(timezone.utc).isoformat(), operation_id),
        )
    if isinstance(pid, int):
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    finish_operation(operation_id, "cancelled")
    return operation_status(operation_id)


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
        with urlopen(token_request, timeout=30) as response:
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
        with urlopen(request, timeout=30) as response:
            content = response.read()
    except HTTPError as error:
        raise RuntimeError(
            f"Tailscale API {method} {path} failed with HTTP {error.code}: {error.read().decode(errors='replace')}"
        ) from error
    return json.loads(content) if content else None


def local_tailscale_identity() -> str:
    try:
        process = subprocess.run(
            ["tailscale", "status", "--json"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        status = json.loads(process.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        raise RuntimeError(
            f"local Tailscale status failed: {error_text(error)}"
        ) from error
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


def local_states() -> list[dict[str, Any]]:
    controller_items = controller_sandboxes()
    for item in controller_items:
        restore_cua_state(item["name"])
    by_name = {item["name"]: item for item in controller_items}
    if not STATE_DIR.exists():
        return sorted(by_name.values(), key=lambda item: item["name"])
    for path in STATE_DIR.glob("*.json"):
        try:
            state = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        pool = state.get("pool_name")
        profile = next(
            (name for name, item in PROFILES.items() if item["pool"] == pool), None
        )
        if state.get("runtime_type") == "fleet" and profile:
            item = {"name": state.get("name", path.stem), "os": profile, "pool": pool}
            if isinstance(item["name"], str):
                by_name[item["name"]] = item
    return sorted(by_name.values(), key=lambda item: item["name"])


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


def local_tailscale_peer(name: str, address: str) -> dict[str, Any] | None:
    try:
        process = subprocess.run(
            ["tailscale", "status", "--json"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        status = json.loads(process.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return None
    peers = (status.get("Peer") or {}).values()
    for peer in peers:
        if not isinstance(peer, dict):
            continue
        if (
            peer.get("HostName", "").lower() == name.lower()
            and address in (peer.get("TailscaleIPs") or [])
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
        raise RuntimeError(
            f"guest registered hostname {guest_hostname!r}, expected {name!r}"
        )
    if "tag:cua-sandbox" not in guest_tags:
        raise RuntimeError("guest is missing required Tailscale tag:cua-sandbox")

    progress("tailscale.peer-discovery", f"waiting for {name} in controller netmap")
    deadline = time.monotonic() + 90
    peer = None
    while time.monotonic() < deadline:
        peer = local_tailscale_peer(name, address)
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


def online_tailscale_hosts() -> set[str]:
    try:
        proc = subprocess.run(
            ["tailscale", "status", "--json"],
            check=True,
            capture_output=True,
            text=True,
            timeout=3,
        )
        status = json.loads(proc.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return set()
    peers = [status.get("Self") or {}, *(status.get("Peer") or {}).values()]
    return {
        str(peer.get("HostName", "")).lower()
        for peer in peers
        if peer.get("Online") is True
    }


def validate_name(name: str) -> None:
    if not NAME_PATTERN.fullmatch(name):
        raise ValueError(
            "name must start with a letter and contain only lowercase letters, digits, and hyphens"
        )


def next_name(profile: str) -> str:
    used = {item["name"] for item in local_states()}
    for number in range(1, 1000):
        candidate = f"{profile}-{number}"
        if candidate not in used:
            return candidate
    raise RuntimeError(f"no free {profile} name")


def remote_pi_files() -> dict[str, bytes]:
    files = {
        ".pi/agent/cua-tool-host.mjs": (
            Path(__file__).parent / "tool-host.mjs"
        ).read_bytes()
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
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for remote, content in remote_pi_files().items():
            info = tarfile.TarInfo(remote)
            info.size = len(content)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(content))
    await sb.files.write_bytes("/tmp/cua-pi-agent.tgz", buffer.getvalue())
    await sb.files.write_text(
        "/tmp/cua-tailscale-auth-key",
        tailscale_auth_key(tailnet),
    )
    result = await sb.shell.run(
        "chmod 600 /tmp/cua-pi-agent.tgz /tmp/cua-tailscale-auth-key", timeout=30
    )
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
    cleanup = (
        sudo
        + "$SUDO systemctl stop cua-bootstrap.service 2>/dev/null; "
        + "$SUDO systemctl reset-failed cua-bootstrap.service 2>/dev/null; "
        + f"$SUDO rm -f {log_path} {result_path}; true"
    )
    await wait_for_step(sb.shell.run(cleanup, timeout=20), f"{phase}.prepare", 30)
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

    began = time.monotonic()
    next_heartbeat = began
    poll = (
        f"if [ -f {result_path} ]; then echo __DONE__$(cat {result_path}); "
        f"tail -n 200 {log_path} 2>/dev/null; else echo __RUNNING__; fi"
    )
    while True:
        elapsed = time.monotonic() - began
        if elapsed >= timeout:
            raise RuntimeError(f"{phase} timed out after {timeout:g} seconds")
        if time.monotonic() >= next_heartbeat:
            progress(phase, "background job is running", elapsed_seconds=round(elapsed))
            next_heartbeat = time.monotonic() + 30
        try:
            result = await wait_for_step(
                sb.shell.run(poll, timeout=20),
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
                raise RuntimeError(f"invalid Linux job result: {raw_code!r}") from error
            return code, "\n".join(lines[1:]).strip()
        await asyncio.sleep(5)


async def run_windows_background_job(
    sb: Any, script_path: str, phase: str, timeout: float
) -> tuple[int, str]:
    log_path = r"C:\Windows\Temp\cua-bootstrap.log"
    result_path = r"C:\Windows\Temp\cua-bootstrap.result"
    cleanup = (
        'powershell.exe -NoProfile -Command "'
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*cua-bootstrap*' -and $_.ProcessId -ne $PID } | "
        f"ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}; Remove-Item -Force -ErrorAction SilentlyContinue '{log_path}','{result_path}'\""
    )
    await wait_for_step(sb.shell.run(cleanup, timeout=20), f"{phase}.prepare", 30)
    runner_path = r"C:\Windows\Temp\cua-bootstrap-runner.ps1"
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

    began = time.monotonic()
    next_heartbeat = began
    poll = (
        'powershell.exe -NoProfile -Command "'
        f"if(Test-Path '{result_path}'){{Write-Output ('__DONE__' + (Get-Content -Raw '{result_path}').Trim()); "
        f"if(Test-Path '{log_path}'){{Get-Content -Tail 200 '{log_path}'}}}}else{{Write-Output '__RUNNING__'}}\""
    )
    while True:
        elapsed = time.monotonic() - began
        if elapsed >= timeout:
            raise RuntimeError(f"{phase} timed out after {timeout:g} seconds")
        if time.monotonic() >= next_heartbeat:
            progress(phase, "background job is running", elapsed_seconds=round(elapsed))
            next_heartbeat = time.monotonic() + 30
        try:
            result = await wait_for_step(
                sb.shell.run(poll, timeout=20),
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
                    f"invalid Windows job result: {raw_code!r}"
                ) from error
            return code, "\n".join(lines[1:]).strip()
        await asyncio.sleep(5)


async def bootstrap_windows(sb: Any, name: str, tailnet: str) -> str:
    progress(f"bootstrap.{name}.upload", "building Windows bootstrap inputs")
    if not WINDOWS_PUBLIC_KEY.exists():
        raise RuntimeError(f"missing Windows SSH public key: {WINDOWS_PUBLIC_KEY}")
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, mode="w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for remote, content in remote_pi_files().items():
            bundle.writestr(remote, content)
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
    record_tailscale_enrollment(name, tailnet, node_id, addresses)


async def ensure_one(name: str) -> dict[str, Any]:
    states = {item["name"]: item for item in local_states()}
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
        return {"name": name, "os": profile, "address": address, "changed": changed}
    finally:
        await disconnect_safely(sb)


async def create_one(profile: str, requested_name: str | None) -> dict[str, Any]:
    if profile not in PROFILES:
        raise ValueError("os must be linux or windows")
    name = requested_name or next_name(profile)
    validate_name(name)
    if any(item["name"] == name for item in local_states()):
        raise ValueError(f"managed sandbox already exists: {name}")
    tailnet = local_tailscale_identity()

    from cua_sandbox import Image, Pool, Sandbox, WarmPoolAutoscaling

    spec = PROFILES[profile]
    image = Image.from_registry(spec["image"], os_type=profile, kind="vm")
    autoscaling = WarmPoolAutoscaling(
        min_pool_size=0, initial_pool_size=1, max_pool_size=10
    )
    pool = None
    for attempt in range(1, 13):
        phase = f"pool.{spec['pool']}.reconcile.attempt-{attempt}"
        try:
            pool = await wait_for_step(
                Pool.apply(
                    image,
                    name=spec["pool"],
                    cpu=spec["cpu"],
                    memory_mb=spec["memory_mb"],
                    services={"server": 8000},
                    autoscaling=autoscaling,
                ),
                phase,
                300,
            )
            break
        except RuntimeError as error:
            detail = error_text(error)
            transient = "NamespaceTerminating" in detail or (
                "status=403" in detail
                and (
                    "k8s request is not allowed" in detail
                    or (
                        "cannot create resource" in detail
                        and "osgymsandboxwarmpools" in detail
                    )
                )
            )
            if not transient or attempt == 12:
                raise
            progress(phase, "Fleet namespace is converging; retrying in 10 seconds")
            await asyncio.sleep(10)
    if pool is None:
        raise RuntimeError(f"pool {spec['pool']} reconciliation produced no pool")
    sb = await wait_for_step(
        Sandbox.create(pool=pool, name=name, service="server", time_to_start=900),
        f"claim.{name}.wait-service",
        960,
    )
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
        return {"name": name, "os": profile, "address": address, "changed": True}
    finally:
        await disconnect_safely(sb)


async def delete_one(name: str) -> dict[str, Any]:
    states = {item["name"]: item for item in local_states()}
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
class WorkspaceBundle:
    root: Path
    relative_cwd: Path
    remote_url: str
    commit: str
    archive: bytes
    deleted_paths: tuple[str, ...]


def git_output(root: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", "-C", str(root), *args],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return proc.stdout.strip()


def build_workspace_bundle(
    source_cwd: Path, *, include_overlay: bool = True
) -> WorkspaceBundle:
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

    changed = subprocess.run(
        ["git", "-C", str(root), "diff", "--name-only", "-z", "HEAD"],
        check=True,
        capture_output=True,
        timeout=60,
    ).stdout.split(b"\0")
    untracked = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z", "--others", "--exclude-standard"],
        check=True,
        capture_output=True,
        timeout=60,
    ).stdout.split(b"\0")
    tracked = list(dict.fromkeys([*changed, *untracked])) if include_overlay else []
    buffer = io.BytesIO()
    source_bytes = 0
    with tarfile.open(fileobj=buffer, mode="w:gz", dereference=False) as archive:
        for raw_path in tracked:
            if not raw_path:
                continue
            relative_path = raw_path.decode("utf-8", "surrogateescape")
            source = root / relative_path
            if source.exists() or source.is_symlink():
                source_bytes += source.lstat().st_size
                if source_bytes > 200 * 1024 * 1024:
                    raise ValueError("workspace transfer exceeds the 200 MiB limit")
                archive.add(source, arcname=relative_path, recursive=False)
    deleted = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z", "--deleted"],
        check=True,
        capture_output=True,
        timeout=60,
    ).stdout.split(b"\0")
    deleted_paths = (
        tuple(path.decode("utf-8", "surrogateescape") for path in deleted if path)
        if include_overlay
        else ()
    )
    return WorkspaceBundle(
        root=root,
        relative_cwd=resolved_cwd.relative_to(root),
        remote_url=remote_url,
        commit=commit,
        archive=buffer.getvalue(),
        deleted_paths=deleted_paths,
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
        f"UserKnownHostsFile={HOME / '.ssh' / 'cua_known_hosts'}",
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


def healthy_over_ssh(name: str, profile: str) -> str | None:
    try:
        command = guest_health_command(profile)
        result = subprocess.run(
            ["ssh", *ssh_options(profile), f"cua@{name}", command],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return None
    lines = result.stdout.strip().splitlines() if result.returncode == 0 else []
    return lines[-1] if lines else None


def run_guest_ssh(
    name: str,
    profile: str,
    command: str,
    *,
    timeout: int,
    stream_phase: str | None = None,
) -> subprocess.CompletedProcess[str]:
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
        if result.returncode != 0:
            raise RuntimeError(
                f"SSH command on {name} failed with exit {result.returncode}: "
                f"{(result.stderr or result.stdout).strip()}"
            )
        return result

    # Streamed variant: forward the latest output line (git --progress updates
    # are \r-terminated) into the operation record so the UI can show it live.
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
            break
    returncode = process.wait()
    text_output = output.decode(errors="replace")
    if returncode != 0:
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
        else f"(Get-Item -LiteralPath '{remote_path}' -ErrorAction SilentlyContinue).Length"
    )
    try:
        result = subprocess.run(
            ["ssh", *ssh_options(profile), f"cua@{name}", command],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        return int(result.stdout.strip().splitlines()[-1])
    except (subprocess.SubprocessError, OSError, ValueError, IndexError):
        return None


def copy_guest_file(name: str, profile: str, content: bytes, remote_path: str) -> None:
    total = len(content)
    total_mib = total / 1048576
    progress(f"scp.{name}", f"uploading {total_mib:.1f} MiB to {remote_path}")
    with tempfile.NamedTemporaryFile() as source:
        source.write(content)
        source.flush()
        target_path = remote_path.replace("\\", "/")
        process = subprocess.Popen(
            [
                "scp",
                "-q",
                *ssh_options(profile),
                source.name,
                f"cua@{name}:{target_path}",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        deadline = time.monotonic() + 300
        # Poll the growing remote file so the operation reports a live percent
        # instead of one silent blocking transfer.
        while process.poll() is None:
            if time.monotonic() >= deadline:
                process.kill()
                process.wait()
                raise RuntimeError(f"SCP upload to {name} timed out after 300 seconds")
            time.sleep(2)
            if process.poll() is not None:
                break
            size = guest_file_size(name, profile, remote_path)
            if size and total:
                percent = min(100, size * 100 // total)
                progress(
                    f"scp.{name}",
                    f"uploading {remote_path}: "
                    f"{size / 1048576:.1f}/{total_mib:.1f} MiB ({percent}%)",
                )
        stdout, stderr = process.communicate()
    if process.returncode != 0:
        raise RuntimeError(
            f"SCP upload to {name} failed with exit {process.returncode}: "
            f"{(stderr or stdout).strip()}"
        )
    progress(f"scp.{name}", f"uploaded {total_mib:.1f} MiB to {remote_path}")


def sync_guest_packages(name: str, profile: str, packages: tuple[str, ...]) -> None:
    settings = json.dumps({"packages": list(packages)}, indent=2).encode() + b"\n"
    remote_path = (
        "/home/cua/.pi/agent/settings.json"
        if profile == "linux"
        else r"C:\Users\cua\.pi\agent\settings.json"
    )
    copy_guest_file(name, profile, settings, remote_path)


async def prepare_workspace(
    name: str,
    profile: str,
    source_cwd: Path,
    workspace_id: str,
    *,
    include_overlay: bool = True,
) -> str:
    progress(f"workspace.{name}.bundle", f"capturing {source_cwd}")
    bundle = build_workspace_bundle(source_cwd, include_overlay=include_overlay)
    repository_key = hashlib.sha256(bundle.remote_url.encode()).hexdigest()[:20]
    if profile == "linux":
        workspace_root = f"/home/cua/workspaces/{workspace_id}"
        archive_path = f"/tmp/cua-workspace-{workspace_id}.tgz"
        repository_cache = f"/home/cua/.cache/cua-pi/git/{repository_key}.git"
        copy_guest_file(name, profile, bundle.archive, archive_path)
        deleted = " ".join(
            shlex.quote(str(PurePosixPath(workspace_root) / path))
            for path in bundle.deleted_paths
        )
        command = f"""set -eu
mkdir -p /home/cua/workspaces /home/cua/.cache/cua-pi/git
if [ ! -d {shlex.quote(repository_cache)} ]; then
  git clone --mirror --progress {shlex.quote(bundle.remote_url)} {shlex.quote(repository_cache)}
elif ! git -C {shlex.quote(repository_cache)} cat-file -e {shlex.quote(bundle.commit + "^{commit}")} 2>/dev/null; then
  git -C {shlex.quote(repository_cache)} fetch --progress origin {shlex.quote(bundle.commit)}
fi
if [ ! -d {shlex.quote(workspace_root)}/.git ]; then
  git clone --reference-if-able {shlex.quote(repository_cache)} --dissociate --no-checkout --progress {shlex.quote(bundle.remote_url)} {shlex.quote(workspace_root)}
fi
if ! git -C {shlex.quote(workspace_root)} cat-file -e {shlex.quote(bundle.commit + "^{commit}")} 2>/dev/null; then
  git -C {shlex.quote(workspace_root)} fetch --depth=1 --progress origin {shlex.quote(bundle.commit)}
fi
git -C {shlex.quote(workspace_root)} checkout --detach --force {shlex.quote(bundle.commit)}
tar -xzf {shlex.quote(archive_path)} -C {shlex.quote(workspace_root)}
rm -f {deleted}
rm -f {shlex.quote(archive_path)}
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
            / PurePosixPath(bundle.relative_cwd.as_posix())
        )

    workspace_root = rf"C:\cua\workspaces\{workspace_id}"
    archive_path = rf"C:\Windows\Temp\cua-workspace-{workspace_id}.tgz"
    repository_cache = rf"C:\cua\cache\git\{repository_key}.git"
    copy_guest_file(name, profile, bundle.archive, archive_path)
    deleted_commands = "; ".join(
        f"Remove-Item -Force -Recurse -ErrorAction SilentlyContinue {powershell_literal(str(PureWindowsPath(workspace_root) / PureWindowsPath(path)))}"
        for path in bundle.deleted_paths
    )
    script = f"""$ErrorActionPreference = 'Stop'
$root = {powershell_literal(workspace_root)}
$cache = {powershell_literal(repository_cache)}
New-Item -ItemType Directory -Force -Path 'C:\\cua\\workspaces','C:\\cua\\cache\\git' | Out-Null
if (-not (Test-Path $cache)) {{ git clone --mirror {powershell_literal(bundle.remote_url)} $cache }} else {{ git -C $cache cat-file -e '{bundle.commit}^{{commit}}' 2>$null; if ($LASTEXITCODE -ne 0) {{ git -C $cache fetch origin {bundle.commit} }} }}
if (-not (Test-Path "$root\\.git")) {{ git clone --reference-if-able $cache --dissociate --no-checkout {powershell_literal(bundle.remote_url)} $root }}
git -C $root cat-file -e '{bundle.commit}^{{commit}}' 2>$null
if ($LASTEXITCODE -ne 0) {{ git -C $root fetch --depth=1 origin {bundle.commit} }}
git -C $root checkout --detach --force {bundle.commit}
tar.exe -xzf {powershell_literal(archive_path)} -C $root
{deleted_commands}
Remove-Item -Force {powershell_literal(archive_path)}
"""
    script_path = rf"C:\Windows\Temp\cua-workspace-{workspace_id}.ps1"
    copy_guest_file(name, profile, script.encode("utf-8-sig"), script_path)
    run_guest_ssh(
        name,
        profile,
        rf"powershell.exe -NoProfile -ExecutionPolicy Bypass -File {script_path}",
        timeout=1800,
        stream_phase=f"workspace.{name}.sync",
    )
    relative_windows = PureWindowsPath(*bundle.relative_cwd.parts)
    return str(PureWindowsPath(workspace_root) / relative_windows)


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


def transfer_workspace(
    source_name: str,
    source_profile: str,
    source_cwd: str,
    target_name: str,
    target_profile: str,
    workspace_id: str,
) -> str:
    source_root, relative = workspace_location(source_name, source_profile, source_cwd)
    source_command = (
        f"tar -czf - -C {shlex.quote(source_root)} ."
        if source_profile == "linux"
        else f"tar.exe -czf - -C {powershell_literal(source_root)} ."
    )
    if target_profile == "linux":
        destination = f"/home/cua/workspaces/{workspace_id}"
        staging = f"{destination}.staging"
        backup = f"{destination}.backup"
        target_command = f"""set -eu
rm -rf {shlex.quote(staging)} {shlex.quote(backup)}
mkdir -p {shlex.quote(staging)}
tar -xzf - -C {shlex.quote(staging)}
if [ -e {shlex.quote(destination)} ]; then mv {shlex.quote(destination)} {shlex.quote(backup)}; fi
if mv {shlex.quote(staging)} {shlex.quote(destination)}; then
  rm -rf {shlex.quote(backup)}
else
  if [ -e {shlex.quote(backup)} ]; then mv {shlex.quote(backup)} {shlex.quote(destination)}; fi
  exit 1
fi
"""
        remote_cwd = str(PurePosixPath(destination) / PurePosixPath(relative))
    else:
        destination = rf"C:\cua\workspaces\{workspace_id}"
        staging = f"{destination}.staging"
        backup = f"{destination}.backup"
        target_command = rf"""$ErrorActionPreference = 'Stop'
$stage = {powershell_literal(staging)}
$destination = {powershell_literal(destination)}
$backup = {powershell_literal(backup)}
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $stage,$backup
New-Item -ItemType Directory -Force -Path $stage | Out-Null
tar.exe -xzf - -C $stage
if (Test-Path $destination) {{ Move-Item $destination $backup }}
try {{ Move-Item $stage $destination; Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $backup }}
catch {{ if (Test-Path $backup) {{ Move-Item $backup $destination }}; throw }}
"""
        remote_cwd = str(PureWindowsPath(destination) / PureWindowsPath(relative))

    progress(f"workspace.{target_name}.transfer", f"copying from {source_name}")
    with (
        tempfile.TemporaryFile() as source_error,
        tempfile.TemporaryFile() as target_error,
    ):
        source = subprocess.Popen(
            [
                "ssh",
                *ssh_options(source_profile),
                f"cua@{source_name}",
                source_command,
            ],
            stdout=subprocess.PIPE,
            stderr=source_error,
        )
        assert source.stdout is not None
        target = subprocess.Popen(
            [
                "ssh",
                *ssh_options(target_profile),
                f"cua@{target_name}",
                target_command,
            ],
            stdin=source.stdout,
            stdout=target_error,
            stderr=target_error,
        )
        source.stdout.close()
        try:
            target_code = target.wait(timeout=1800)
            source_code = source.wait(timeout=30)
        except subprocess.TimeoutExpired:
            source.kill()
            target.kill()
            raise RuntimeError("workspace transfer timed out") from None
        if source_code != 0 or target_code != 0:
            source_error.seek(0)
            target_error.seek(0)
            detail = (source_error.read() + target_error.read()).decode(
                errors="replace"
            )
            raise RuntimeError(
                f"workspace transfer failed (source={source_code}, target={target_code}): {detail.strip()}"
            )
    return remote_cwd


async def prepare_execution(
    name: str,
    source_cwd: str,
    workspace_key: str,
    source_sandbox: str | None = None,
    source_profile: str | None = None,
    source_remote_cwd: str | None = None,
    include_local_overlay: bool = True,
    tool_packages: tuple[str, ...] = (),
) -> dict[str, Any]:
    states = {item["name"]: item for item in local_states()}
    if name not in states:
        raise ValueError(f"unknown managed sandbox: {name}")
    profile = states[name]["os"]
    if source_sandbox:
        if source_sandbox not in states:
            raise ValueError(f"unknown source sandbox: {source_sandbox}")
        if source_profile != states[source_sandbox]["os"]:
            raise ValueError("source sandbox operating system mismatch")
    address = healthy_over_ssh(name, profile)
    if address is None:
        tailnet = local_tailscale_identity()
        restore_cua_state(name)
        sb = await connect_sandbox(name)
        try:
            address = await healthy(sb, profile)
            if address is None:
                address = await (
                    bootstrap_linux(sb, name, tailnet)
                    if profile == "linux"
                    else bootstrap_windows(sb, name, tailnet)
                )
            await complete_tailscale_enrollment(sb, profile, name, address, tailnet)
        finally:
            await disconnect_safely(sb)

    sync_guest_packages(name, profile, tool_packages)
    workspace_id = hashlib.sha256(workspace_key.encode()).hexdigest()[:16]
    remote_cwd = (
        transfer_workspace(
            source_sandbox,
            source_profile,
            source_remote_cwd,
            name,
            profile,
            workspace_id,
        )
        if source_sandbox and source_profile and source_remote_cwd
        else await prepare_workspace(
            name,
            profile,
            Path(source_cwd).expanduser().resolve(),
            workspace_id,
            include_overlay=include_local_overlay,
        )
    )
    return {
        "name": name,
        "os": profile,
        "address": address,
        "remote_cwd": remote_cwd,
    }


async def dispatch(request: dict[str, Any]) -> dict[str, Any]:
    action = request.get("action")
    if action == "list":
        online = online_tailscale_hosts()
        items = [
            {**item, "online": item["name"].lower() in online}
            for item in local_states()
        ]
        return {"sandboxes": items}
    if action == "get_execution_target":
        return get_execution_target(
            str(request.get("session_id") or ""),
            str(request.get("session_file") or ""),
        )
    if action == "set_execution_target":
        return set_execution_target(
            str(request.get("session_id") or ""),
            str(request.get("session_file") or ""),
            request.get("target"),
        )
    if action == "operation_status":
        return operation_status(str(request.get("operation_id") or ""))
    if action == "operation_cancel":
        return cancel_operation(str(request.get("operation_id") or ""))
    configure_fleet_auth()
    if action == "create":
        return await create_one(str(request.get("os") or ""), request.get("name"))
    if action == "ensure":
        return await ensure_one(str(request.get("name") or ""))
    if action == "delete":
        return await delete_one(str(request.get("name") or ""))
    if action == "prepare_execution":
        workspace_key = request.get("workspace_id")
        if not isinstance(workspace_key, str) or not workspace_key:
            raise ValueError("prepare_execution requires workspace_id")
        source_sandbox = request.get("source_sandbox")
        source_os = request.get("source_os")
        source_remote_cwd = request.get("source_remote_cwd")
        include_local_overlay = request.get("include_local_overlay", True)
        tool_packages = request.get("tool_packages", [])
        if not isinstance(tool_packages, list) or any(
            not isinstance(package, str)
            or not package.startswith(("git:", "npm:", "https://", "http://", "ssh://"))
            or "pi-cua" in package.lower()
            for package in tool_packages
        ):
            raise TypeError("tool_packages contains an unsupported package source")
        if not isinstance(include_local_overlay, bool):
            raise TypeError("include_local_overlay must be a boolean")
        if source_sandbox is not None and not isinstance(source_sandbox, str):
            raise TypeError("source_sandbox must be a string")
        if source_os is not None and source_os not in {"linux", "windows"}:
            raise TypeError("source_os must be linux or windows")
        if source_remote_cwd is not None and not isinstance(source_remote_cwd, str):
            raise TypeError("source_remote_cwd must be a string")
        return await prepare_execution(
            str(request.get("name") or ""),
            str(request.get("source_cwd") or ""),
            workspace_key,
            source_sandbox,
            source_os,
            source_remote_cwd,
            include_local_overlay,
            tuple(dict.fromkeys(tool_packages)),
        )
    raise ValueError(
        "action must be list, create, ensure, delete, prepare_execution, get_execution_target, or set_execution_target"
    )


def ensure_cloud_runtime(action: object, request: dict[str, Any]) -> None:
    cloud_actions = LONG_ACTIONS
    if (
        action not in cloud_actions
        or importlib.util.find_spec("cua_sandbox") is not None
    ):
        return
    if action == "prepare_execution":
        name = request.get("name")
        state = next((item for item in local_states() if item["name"] == name), None)
        if state and healthy_over_ssh(state["name"], state["os"]):
            return
    command = [
        "uv",
        "run",
        "--quiet",
        "--python",
        "3.11",
        "--with",
        "cua-sandbox==0.3.4",
        "--extra-index-url",
        "https://wheels.cua.ai/simple",
        "--index-strategy",
        "unsafe-best-match",
        "python",
        str(Path(__file__).resolve()),
        sys.argv[1],
    ]
    os.execvp(command[0], command)


def main() -> None:
    global CURRENT_OPERATION_ID
    try:
        if len(sys.argv) != 2:
            raise ValueError("expected one JSON request argument")
        request = json.loads(sys.argv[1])
        if not isinstance(request, dict):
            raise TypeError("request must be a JSON object")
        action = request.get("action")
        worker = os.environ.get("CUA_DETACHED_WORKER") == "1"
        CURRENT_OPERATION_ID = os.environ.setdefault(
            "CUA_OPERATION_ID", uuid.uuid4().hex[:12]
        )
        prune_operation_logs()

        if action in LONG_ACTIONS and not worker:
            result = submit_operation(request, CURRENT_OPERATION_ID)
            print(json.dumps({"ok": True, **result}, separators=(",", ":")))
            return

        ensure_cloud_runtime(action, request)
        if worker:
            with database() as connection:
                connection.execute(
                    """
                    UPDATE operations
                    SET state = 'running', worker_pid = ?, phase = 'worker',
                        message = 'worker running', updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        os.getpgrp(),
                        datetime.now(timezone.utc).isoformat(),
                        CURRENT_OPERATION_ID,
                    ),
                )
        quiet_request = action in {
            "list",
            "get_execution_target",
            "set_execution_target",
            "operation_status",
        }
        if not quiet_request:
            progress("request", "accepted", action=action, name=request.get("name"))
        local_read = action in {
            "list",
            "get_execution_target",
            "set_execution_target",
            "operation_status",
            "operation_cancel",
        }
        if local_read:
            result = asyncio.run(dispatch(request))
        else:
            progress("lock", "waiting for controller mutation lock")
            with operation_lock():
                progress("lock", "acquired controller mutation lock")
                result = asyncio.run(dispatch(request))
        if not quiet_request:
            progress("complete", "operation succeeded")
        if worker:
            finish_operation(CURRENT_OPERATION_ID, "succeeded", result=result)
        print(
            json.dumps(
                {
                    "ok": True,
                    "operation_id": CURRENT_OPERATION_ID,
                    "operation_log": str(
                        OPERATION_DIR / f"{CURRENT_OPERATION_ID}.jsonl"
                    ),
                    **result,
                },
                separators=(",", ":"),
            )
        )
    except Exception as error:  # noqa: BLE001 - process boundary returns all failures as JSON
        try:
            progress(CURRENT_PHASE, "operation failed", error=error_text(error))
            if os.environ.get("CUA_DETACHED_WORKER") == "1" and CURRENT_OPERATION_ID:
                finish_operation(
                    CURRENT_OPERATION_ID,
                    "failed",
                    error_type=type(error).__name__,
                    error=error_text(error),
                )
        except OSError as log_error:
            print(
                f"warning: failed to write operation log: {error_text(log_error)}",
                file=sys.stderr,
                flush=True,
            )
        print(
            json.dumps(
                {
                    "ok": False,
                    "operation_id": CURRENT_OPERATION_ID,
                    "phase": CURRENT_PHASE,
                    "error_type": type(error).__name__,
                    "error": error_text(error),
                    "operation_log": (
                        str(OPERATION_DIR / f"{CURRENT_OPERATION_ID}.jsonl")
                        if CURRENT_OPERATION_ID
                        else None
                    ),
                },
                separators=(",", ":"),
            )
        )
        raise SystemExit(1)


if __name__ == "__main__":
    main()
