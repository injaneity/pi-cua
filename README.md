# pi-cua

pi's tui, agent, model, and conversation sessions stay local. each local session has one current execution target: local, linux, or windows. registered agent tools and user `!` commands execute on that target.

## install

```bash
pi install git:github.com/injaneity/pi-cua
```

this package currently targets macos controllers, CUA Fleet pools named `cua-pi-linux` and `cua-pi-windows`, and a Tailscale network with the `tag:cua-sandbox` ACL tag. fleet pool/namespace names are a tenant-wide authorization boundary — if another tenant already owns a default name, pool operations fail with a persistent 403; set `CUA_PI_LINUX_POOL` and `CUA_PI_WINDOWS_POOL` to unclaimed names for your tenant. store the CUA Fleet and Tailscale OAuth credentials in Keychain:

```bash
security add-generic-password -U -s cua-sandbox-fleet-api -a client-id -w "$CUA_CLIENT_ID"
security add-generic-password -U -s cua-sandbox-fleet-api -a client-secret -w "$CUA_CLIENT_SECRET"
security add-generic-password -U -s cua-sandbox-tailscale-oauth -a client-id -w "$TAILSCALE_CLIENT_ID"
security add-generic-password -U -s cua-sandbox-tailscale-oauth -a client-secret -w "$TAILSCALE_CLIENT_SECRET"
```

windows provisioning also requires `~/.ssh/cua_windows_ed25519` and its `.pub` file. the local project must be a git repository with a network `origin`.

## behavior

- `/sandbox` changes the current session's execution target.
- `/new` asks for a target before the new thread starts.
- `/fork` inherits the parent thread's target but prepares a clean workspace from the local repository commit.
- `/tree` changes conversation history but not execution placement.
- `/resume` restores placement from the controller database.
- the footer shows the selected sandbox. no remote tui or conversation session is created.

`cua_sandbox` and `report_papercut` are local control-plane tools. every other registered tool is proxied by name. sandbox activation fails if the remote pi sdk host does not expose a required tool; calls never fall back to local execution.

## execution path

1. the controller reuses a persistent ssh connection and takes a direct health fast path for an already bootstrapped sandbox; it contacts Fleet only for repair or bootstrap;
2. it prepares the session workspace from the local git checkout, or streams the canonical workspace from the previously selected sandbox;
3. the extension starts one non-tty ssh jsonl channel to `cua-tool-host.mjs`;
4. the host loads pi's normal remote tool registry and reports its protocol and tool manifest;
5. calls, updates, results, errors, cancellation, and user shell output use that channel.

switching between sandboxes is transactional: the target workspace is restored through a staging directory before the local target mapping and footer change. failure leaves the previous target active. switching a sandbox workspace back to local is intentionally blocked until a safe local restore transaction exists.

## state

execution placement is controller metadata keyed by local pi session id and session file. it is not part of the conversation tree, so `/tree` and compaction cannot change it.

sandbox workspaces are keyed by session id. a new thread starts from the local repository commit and overlay. forks copy only Pi's local conversation history; they receive a clean checkout of the commit and never copy or share the parent's files or uncommitted overlay.

placement adds a stable operating-system instruction and logical `workspace root` cwd to the model prompt, but no sandbox name, physical path, or conversation entry. forks on the same target OS therefore keep the same prompt prefix for provider cache hits even though they receive different physical workspaces.

tool state belongs to the active remote host. switching targets invalidates target-specific references and background processes.

pi-cua emits `cua:execution-target-changed` with local, connecting, and ready target states. a custom footer can consume this event without coupling its layout to the controller.

## guest boundary

the guest receives the pi sdk version, only the user packages that own routed tools, top-level extension definitions, and the generic tool host. the host activates lifecycle handlers only for extensions that own required tools. it does not receive local model credentials, prompts, conversation sessions, or the sandbox controller.

workspace preparation requires a git repository with a network `origin` and does not support submodules. if the guest cannot authenticate to the origin, the controller sends a clean commit snapshot and creates an isolated baseline without copying git credentials. new threads and existing local threads carry the local overlay, limited to 200 mib; forks intentionally omit it. guests keep a bare repository cache outside all workspaces, so fresh sessions and forks reuse git objects without sharing mutable files. package-manager caches also remain in the guest user profile. sandbox-to-sandbox handoff for the same thread streams the complete workspace, including `.git` and untracked files, over ssh.

## verification

```bash
uvx --quiet ruff format --check backend.py test_backend.py
uvx --quiet ruff check backend.py test_backend.py
python3 -m unittest -q test_backend.py
npm exec --yes --package=prettier -- prettier --check index.ts tool-host.mjs
node --check tool-host.mjs
pi --list-models
```
