# pi-cua

pi's tui, agent, model, and conversation sessions stay local. each local session has one current execution target: local, linux, or windows. registered agent tools and user `!` commands execute on that target.

## install

```bash
pi install git:github.com/injaneity/pi-cua
```

this package currently targets macos controllers with `uv` and the Tailscale CLI installed. the controller must be online in a Tailscale network with the `tag:cua-sandbox` ACL tag. its OAuth client must be allowed to create auth keys for that tag, and the tailnet ACL must allow the controller to reach tagged guests, including Tailscale SSH for linux. CUA Fleet pools default to `cua-pi-linux` and `cua-pi-windows`; fleet pool/namespace names are a tenant-wide authorization boundary — if another tenant already owns a default name, pool operations fail with a persistent 403. set `CUA_PI_LINUX_POOL` or `CUA_PI_WINDOWS_POOL` to an unclaimed base name for your tenant. custom-resource pools use deterministic names derived from that base. store the CUA Fleet and Tailscale OAuth credentials in Keychain:

```bash
security add-generic-password -U -s cua-sandbox-fleet-api -a client-id -w "$CUA_CLIENT_ID"
security add-generic-password -U -s cua-sandbox-fleet-api -a client-secret -w "$CUA_CLIENT_SECRET"
security add-generic-password -U -s cua-sandbox-tailscale-oauth -a client-id -w "$TAILSCALE_CLIENT_ID"
security add-generic-password -U -s cua-sandbox-tailscale-oauth -a client-secret -w "$TAILSCALE_CLIENT_SECRET"
```

windows provisioning also requires `~/.ssh/cua_windows_ed25519` and its `.pub` file. the local project must be a git repository with a network `origin`.

## behavior

- `/sandbox` opens a compact action search. `stay on <current target>` appears first in neutral bold and gains the selection accent only when highlighted; a sandbox session can sync back to local, connect to another online sandbox, or create a sandbox. connect and create open focused nested searches where Escape returns to the action search, and create entries use the prompt-template heading accent when selected. `/sandbox linux 16 65536` creates a sandbox with 16 CPUs and 65536 MiB of memory; omitting both values uses the existing OS defaults.
- `/new` and `/fork` start local; use `/sandbox` to opt into sandbox execution for the new thread.
- `/tree` changes conversation history but never changes execution placement.
- `/resume` restores placement from durable session metadata, with the controller database as a compatibility fallback for older sessions.
- the footer shows the selected sandbox. no remote tui or conversation session is created.

custom images are available through the structured `cua_sandbox` create action's `image` field. they must be Fleet-compatible CUA containerDisks and pinned by `sha256` digest; mutable tags are rejected.

`cua_sandbox` and `report_papercut` are local control-plane tools. every other registered tool is proxied by name, except that `read` handles Pi's controller-local `pi-clipboard-*` image paths locally so pasted screenshots remain visible. ordinary file reads stay remote. sandbox activation fails if the remote pi sdk host does not expose a required tool; calls never fall back to local execution.

## execution path

1. the controller reuses a persistent ssh connection and takes a direct health fast path for an already bootstrapped sandbox; it contacts Fleet only for repair or bootstrap;
2. it prepares the destination from the thread's local Git baseline, then applies the accumulated workspace delta from the active sandbox;
3. the extension starts one non-tty ssh jsonl channel; linux runs `cua-tool-host.mjs` directly, while windows authenticates a loopback relay to a broker in the existing interactive desktop session;
4. the host loads pi's normal remote tool registry and reports its protocol and tool manifest;
5. calls, updates, results, errors, cancellation, and user shell output use that channel. `Esc` rejects the local request immediately and asks the host to kill the full remote command process tree.

all target changes use one workspace model: Pi records local and sandbox Git trees at sandbox entry, computes the accumulated binary tree diff when leaving a sandbox, verifies the destination baseline, and applies that diff. local divergence or a patch conflict stops the switch, and failure leaves the previous target active.

## state

execution placement is stored as non-context session metadata and mirrored in the controller database. restore reads the latest placement across the full session rather than the active branch, so `/tree` and compaction cannot change it.

sandbox workspaces are keyed by session id. new threads and forks start from an exact snapshot of the current local checkout. a fork does not copy its parent's active sandbox workspace, so both threads retain independently verifiable local baselines.

placement adds a stable operating-system instruction and logical `workspace root` cwd to the model prompt, but no sandbox name, physical path, or model-visible conversation entry. forks on the same target OS therefore keep the same prompt prefix for provider cache hits even though they receive different physical workspaces.

tool state belongs to the active remote host. switching targets invalidates target-specific references and background processes.

pi-cua emits `cua:execution-target-changed` with local, connecting, and ready target states. a custom footer can consume this event without coupling its layout to the controller.

## guest boundary

the guest receives the pi sdk version, only the user packages that own routed tools, top-level extension definitions, and the generic tool host. the host activates lifecycle handlers only for extensions that own required tools. it does not receive local model credentials, prompts, conversation sessions, or the sandbox controller.

workspace preparation requires a git repository with a network `origin` and does not support submodules, Git content filters, or working-tree encodings. if the guest cannot authenticate to the origin, the controller sends a clean commit snapshot and creates an isolated baseline without copying git credentials. new threads, existing local threads, and forks carry the local changes, limited to 200 mib. guests keep a bare repository cache outside all workspaces, so fresh sessions and forks reuse git objects without sharing mutable files. package-manager caches also remain in the guest user profile. every handoff transfers only the accumulated binary Git tree diff; `.git`, ignored files, credentials, caches, and processes stay with their machine.

on Windows, OpenSSH remains in Session 0. it can reach only an authenticated loopback relay. the relay starts the tool host under the logged-in desktop user's scheduled-task broker, so GUI tools and shell commands share Session 1 without exposing the broker off-machine.

## verification

```bash
uvx --quiet ruff format --check backend.py test_backend.py
uvx --quiet ruff check backend.py test_backend.py
python3 -m unittest -q test_backend.py
node test-session-targets.mjs
node test-tool-broker.mjs
npm exec --yes --package=prettier -- prettier --check index.ts session-targets.mjs test-session-targets.mjs tool-host.mjs tool-broker.mjs tool-relay.mjs test-tool-broker.mjs
node --check tool-host.mjs
pi --list-models
```
