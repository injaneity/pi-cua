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

Pi Cua reads these standard environment variables first and uses Keychain as the durable fallback. Windows provisioning generates its dedicated SSH identity automatically. Git is optional for execution placement; a supported repository with a network `origin` enables workspace transfer.

## behavior

- `/sandbox` opens a compact action search. while a sandbox is active, the first action returns to local execution and syncs first only when the thread has a Git workspace; staying on the current target requires no action, so Escape closes the search without changing it. every session can connect to another online sandbox or create a sandbox; the connect action shows the number of online choices after excluding the active sandbox. connect and create open focused nested searches where Escape returns to the action search, and create entries use the prompt-template heading accent when selected. `/sandbox linux 16 65536` creates a sandbox with 16 CPUs and 65536 MiB of memory; omitting both values uses the existing OS defaults. `/new` and `/fork` hand the active sandbox execution to the replacement session without syncing or tearing it down.
- `/tree` changes conversation history but never changes execution placement.
- `/resume` restores placement from Pi's durable session metadata. a session that shut down cleanly after sandbox use resumes locally; Git-backed execution syncs and removes its generated workspace first, while a non-Git execution directory remains in the sandbox.
- the footer shows the selected sandbox. no remote tui or conversation session is created.

custom images are available through the structured `cua_sandbox` create action's `image` field. they must be Fleet-compatible CUA containerDisks and pinned by `sha256` digest; mutable tags are rejected.

`cua_sandbox` and `report_papercut` are local control-plane tools. every other registered tool is proxied by name, except that `read` handles Pi's controller-local `pi-clipboard-*` image paths locally so pasted screenshots remain visible. ordinary file reads stay remote. sandbox activation fails if the remote pi sdk host does not expose a required tool; calls never fall back to local execution.

## execution path

1. the extension starts one backend process and reads progress and the final result from its jsonl stream; healthy setup uses the controller's existing Python, while provisioning and repair re-exec under the isolated Fleet sdk runtime;
2. one ssh preflight checks machine health and the mutable guest-bundle digest; Windows preflights include the broker loopback listener, while ensure also validates scheduled task `CuaPiDesktopToolBroker`; Git-backed threads additionally check free disk and repository-cache availability;
3. one content-addressed guest bundle is created only when extension files or routed-tool package settings need an update;
4. when the thread has a supported Git workspace, one workspace command prepares an isolated clone from the shared object cache, then applies one direct Git tree patch from the source state to the final destination state;
5. the extension starts one non-tty ssh jsonl channel; linux runs `cua-tool-host.mjs` directly, while Windows uses OpenSSH direct-TCP forwarding to the existing interactive desktop broker;
6. the host loads pi's normal remote tool registry and reports its protocol and tool manifest;
7. calls, updates, results, errors, cancellation, and user shell output use that channel. `Esc` rejects the local request immediately and asks the host to kill the full remote command process tree.

Git-backed target changes use one workspace model: Pi records local and sandbox Git trees at sandbox entry, computes one accumulated binary tree diff from the original commit to the source's final tree, verifies the destination tree, and applies that diff. after a successful move to local or another sandbox, it removes the source workspace, including ignored build outputs. graceful quit and resume shutdowns sync to local and remove the remote workspace. `/new` and `/fork` hand the existing workspace directly to the replacement session. reload checks only machine and mutable configuration before reconnecting. startup and resume validate the saved workspace and reconstruct it from the local tree if it is missing. local divergence, a patch conflict, or cleanup failure is reported explicitly, and a failed sync retains the remote workspace rather than deleting the only copy of changes.

threads outside Git repositories use a persistent execution directory derived from the stored execution identity. placement, tools, shell commands, reload, `/new`, and `/fork` work normally, but Pi does not copy or synchronize the controller's arbitrary local directory. different threads remain isolated while using the same sandbox, and switching targets retires the tool host without deleting the execution directory.

## state

execution placement is stored only as non-context Pi session metadata. restore reads the latest placement across the full session rather than the active branch, so `/tree` and compaction cannot change it. the controller keeps one atomic json record per managed sandbox; no database or background operation queue is involved.

each sandbox execution derives an opaque id from the Pi thread and stores it with the execution target. Git-backed execution uses it for the isolated workspace; non-Git execution uses it for a persistent directory under the sandbox user profile. `/new` and `/fork` transfer the same identity to the replacement session, while the previous session records local placement. saved targets that predate execution identity acquire one during their next resume or handoff. failed Git destination setup removes its incomplete workspace before returning the error.

placement adds a stable operating-system instruction and a logical `workspace root` or `execution root` cwd to the model prompt, but no sandbox name, physical path, or model-visible conversation entry. replacement sessions on the same target OS therefore keep the same prompt prefix for provider cache hits.

tool state belongs to the active remote host. switching targets retires that host and invalidates target-specific references and background processes. a Windows session replacement can reattach to the execution-scoped host because the desktop broker owns it; Linux starts a fresh host on the new SSH channel.

pi-cua emits `cua:execution-target-changed` with local, connecting, failed, and ready target states. a custom footer can consume this event without coupling its layout to the controller.

## guest boundary

the guest receives the pi sdk version, only the user packages that own routed tools, top-level extension definitions, and the generic tool host. machine bootstrap owns operating-system dependencies and the Windows desktop broker; mutable Pi configuration owns the tool host, extensions, and settings. separate content digests let an extension edit synchronize a small archive instead of reinstalling or repairing the sandbox. the host activates lifecycle handlers only for extensions that own required tools. it does not receive local model credentials, prompts, conversation sessions, or the sandbox controller.

workspace transfer requires a git repository with a network `origin` and does not support submodules, Git content filters, or working-tree encodings. if the guest cannot authenticate to the origin, the controller sends a clean commit snapshot and creates an isolated baseline without copying git credentials. entering a sandbox from local carries local changes, limited to 200 mib. guests keep one bare repository cache outside all workspaces; isolated clones borrow its objects through Git alternates instead of duplicating packs or sharing mutable Git configuration. package-manager caches remain in the guest user profile. target changes between local and sandbox environments transfer only the accumulated binary Git tree diff, then remove the generated source workspace. `/new` and `/fork` instead transfer ownership of the active workspace without copying it. ignored files, credentials, caches, and processes are not transferred as task state.

on Windows, OpenSSH remains in Session 0 and forwards its authenticated channel directly to the loopback-only broker. scheduled task `CuaPiDesktopToolBroker` runs that broker as the logged-in user and keeps execution-directory-scoped Pi hosts in Session 1, so GUI tools and shell commands share the interactive desktop without another remote process. disconnects detach from a complete host; a host that omits required tools is retired and loaded once more instead of being cached across reconnects. `cua_sandbox ensure` repairs a missing, disabled, or non-listening broker, while package capability errors remain distinct from task failures.

## verification

```bash
uvx --quiet ruff format --check backend.py test_backend.py
uvx --quiet ruff check backend.py test_backend.py
python3 -m unittest -q test_backend.py
node test-tool-broker.mjs
npm exec --yes --package=prettier -- prettier --check index.ts tool-host.mjs tool-broker.mjs test-tool-broker.mjs
node --check tool-host.mjs
pi --list-models
```
