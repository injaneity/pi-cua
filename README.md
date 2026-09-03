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

- `/sandbox` opens a compact action search. while a sandbox is active, the first action returns to local execution and syncs first only when the thread has a Git workspace. every session can reconnect to its current sandbox, connect to another online sandbox, or create one. connect and create open focused nested searches where Escape returns to the action search, and create entries use the prompt-template heading accent when selected. `/sandbox linux 16 65536` creates a sandbox with 16 CPUs and 65536 MiB of memory; omitting both values uses the existing OS defaults. `/new` and `/fork` hand the active sandbox execution to the replacement session without syncing or tearing it down.
- `/tree` changes conversation history but never changes execution placement.
- `/resume` restores placement from Pi's durable session metadata. a session that shut down cleanly after sandbox use resumes locally; Git-backed execution syncs and removes its generated workspace first, while a non-Git execution directory remains in the sandbox.
- the footer shows the selected sandbox. no remote tui or conversation session is created.

custom images are available through the structured `cua_sandbox` create action's `image` field. they must be Fleet-compatible CUA containerDisks and pinned by `sha256` digest; mutable tags are rejected.

`cua_sandbox` and `report_papercut` are local control-plane tools. every other registered tool is proxied by name, except that `read` handles Pi's controller-local `pi-clipboard-*` image paths locally so pasted screenshots remain visible. ordinary file reads stay remote. sandbox activation fails if the remote pi sdk host does not expose a required tool; calls never fall back to local execution. tools registered after activation are blocked until `/reload` rebuilds the routed tool set, and the active sandbox cannot be deleted until the session returns to local execution.

## execution path

1. the extension starts one backend process and reads progress and the final result from its jsonl stream; healthy setup uses the controller's existing Python, while provisioning and repair re-exec under the isolated Fleet sdk runtime;
2. one ssh preflight checks machine health and the requested runtime generation; Windows preflights include the broker loopback listener, while ensure also validates scheduled task `CuaPiDesktopToolBroker`; Git-backed threads additionally check free disk and repository-cache availability;
3. one content-addressed runtime is staged under `~/.cua-pi/runtimes/<digest>`, installs exact npm versions and Git commits with production dependencies but without private copies of Pi peer packages, and is published only after package reconciliation succeeds; the three newest generations coexist instead of rewriting shared Pi settings;
4. when the thread has a supported Git workspace, one workspace command prepares an isolated clone from the shared object cache, then applies one direct Git tree patch from the source state to the final destination state; after replacement, runtime and workspace materialization run concurrently because neither mutates the other;
5. the extension starts one non-tty ssh jsonl channel; linux runs `cua-tool-host.mjs` directly, while Windows uses OpenSSH direct-TCP forwarding to the existing interactive desktop broker;
6. the host loads pi's normal remote tool registry from the requested runtime directory, rejects an incomplete required-tool set, then echoes the validated protocol, runtime generation, and tool manifest;
7. calls, updates, results, errors, cancellation, and user shell output use that channel. `Esc` rejects the local request immediately and asks the host to kill the full remote command process tree.

Git-backed target changes use one workspace model: Pi records local and sandbox Git trees at sandbox entry, computes one accumulated binary tree diff from the original commit to the source's final tree, verifies the destination tree, and applies that diff. after a successful move to local or another sandbox, it removes the source workspace, including ignored build outputs. graceful quit and resume shutdowns sync to local and remove the remote workspace. `/new` and `/fork` hand the existing workspace directly to the replacement session. startup, reload, resume, explicit reselection, and bridge reconnection resolve the stable sandbox name to its current network endpoint. the normal resume path opens the exact saved runtime and workspace directly; if that open fails before an operation runs, activation performs the full validation and reconstruction path once. non-conflicting local and sandbox edits are merged during sync. a patch conflict or cleanup failure is reported explicitly without modifying the local files, and a failed sync retains the remote workspace rather than deleting the only copy of changes.

threads outside Git repositories use a persistent execution directory derived from the stored execution identity. placement, tools, shell commands, reload, `/new`, and `/fork` work normally, but Pi does not copy or synchronize the controller's arbitrary local directory. different threads remain isolated while using the same sandbox, and switching targets retires the tool host without deleting the execution directory.

## state

execution placement is stored only as non-context Pi session metadata. restore reads the latest placement across the full session rather than the active branch, so `/tree` and compaction cannot change it. saved placement contains the sandbox name, execution identity, and verified device generation, never an address or runtime generation. a pending target change is also stored until activation succeeds, so `/reload` can resume a connection that it interrupted. the controller keeps one atomic json claim per managed sandbox. a matching device generation opens the host directly; a changed generation reconciles the runtime and workspace before opening it. no database, transport cache, or background operation queue is involved.

each sandbox execution derives an opaque id from the Pi thread and stores it with the execution target. Git-backed execution uses it for the isolated workspace; non-Git execution uses it for a persistent directory under the sandbox user profile. `/new` and `/fork` transfer the same identity to the replacement session, while the previous session records local placement. saved targets that predate execution identity acquire one during their next resume or handoff. failed Git destination setup removes its incomplete workspace before returning the error.

placement adds a stable operating-system instruction and a logical `workspace root` or `execution root` cwd to the model prompt, but no sandbox name, physical path, or model-visible conversation entry. replacement sessions on the same target OS therefore keep the same prompt prefix for provider cache hits.

tool state belongs to one immutable bridge generation. activation prepares and validates a replacement bridge before publishing it, then retires the previous bridge. a disconnected bridge is never retargeted, and no dispatched operation is replayed. a Windows session replacement can reattach to the execution-scoped host because the desktop broker owns it; Linux starts a fresh host on the new SSH channel.

pi-cua emits `cua:execution-target-changed` with local, connecting, failed, and ready target states. a custom footer can consume this event without coupling its layout to the controller.

## guest boundary

the guest receives the pi sdk version, only the user packages and declared regular user-extension entry files that own routed tools, and the generic tool host. symlinks and undeclared extension files do not cross the guest boundary. machine bootstrap owns operating-system dependencies and the Windows desktop broker. execution runtimes own their isolated host, extensions, settings, and package installs. the local route catalog is captured once before proxies replace tool definitions, and package sources are pinned to the installed npm version or Git commit. because each runtime contains only routed-tool packages, the host can run their normal lifecycle before validating the required-tool set, including extensions that register tools during session startup. it does not receive local model credentials, prompts, conversation sessions, or the sandbox controller.

workspace transfer requires a git repository with a network `origin` and does not support submodules, Git content filters, or working-tree encodings. if the guest cannot authenticate to the origin, the controller sends a clean commit snapshot and creates an isolated baseline without copying git credentials. entering a sandbox from local carries local changes, limited to 200 mib. guests keep one bare repository cache outside all workspaces; isolated clones borrow its objects through Git alternates instead of duplicating packs or sharing mutable Git configuration. package-manager caches remain in the guest user profile. target changes between local and sandbox environments transfer only the accumulated binary Git tree diff, then remove the generated source workspace. `/new` and `/fork` instead transfer ownership of the active workspace without copying it. ignored files, credentials, caches, and processes are not transferred as task state.

on Windows, OpenSSH remains in Session 0 and forwards its authenticated channel directly to the loopback-only broker. scheduled task `CuaPiDesktopToolBroker` runs that broker as the logged-in user and keeps execution-and-generation-scoped Pi hosts in Session 1, so GUI tools and shell commands share the interactive desktop without another remote process. bootstrap disables Windows Server's shutdown event tracker so an unexpected guest restart cannot leave a modal dialog blocking unattended desktop work. the broker accepts only a runtime directory that matches the requested content digest, caches exact generation matches, and returns typed broker or runtime open failures. `cua_sandbox ensure` repairs a missing, disabled, or non-listening broker, while package capability errors remain distinct from task failures.

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
