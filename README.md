# pi-cua

pi's tui, agent, model, and conversation sessions stay local. each local session has one current execution target: local, linux, windows, or a tagged macos host. registered agent tools and user `!` commands execute on that target.

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

external macos targets are existing machines, not Fleet resources. install node 22.20.0, the same pi version as the controller, Git, and Tailscale under the logged-in `administrator` account, then authorize the controller identity at `~/.ssh/cua_macos_ed25519` and assign `tag:cua-sandbox` to the device. pi-cua discovers eligible macos peers from the controller's Tailscale netmap and uses their exact Tailscale IPv4 address and stable node identity without creating a controller claim. the first connection pins the SSH host key only after the peer name, address, operating system, and tag pass that authenticated discovery boundary. untagged devices never enter the execution pool, and external targets never acquire Fleet deletion semantics.

## behavior

- the model can call `enter_environment({os: "linux" | "windows" | "macos", name?: string})` to enter an existing sandbox or switch between sandboxes. selection prefers online targets; unavailable Fleet guests remain eligible for the existing bounded repair path. an already connected matching target is a no-op. no machine is automatically created. call it alone in its tool batch. it uses the same preparation, proxy activation, transfer, and cleanup behavior as the picker, without modifying Pi or reloading on entry. returning locally remains a manual `/sandbox local` action that syncs back and reloads extensions; there is no model-callable local return.
- `/sandbox` opens a compact action search. while a sandbox is active, the first action returns to local execution and syncs first only when the thread has a Git workspace. every session can reconnect to its current sandbox, connect to another online Fleet sandbox or tagged macos peer, or create one. connect and create open focused nested searches where Escape returns to the action search, and create entries use the prompt-template heading accent when selected. `/sandbox linux 16 65536` creates a sandbox with 16 CPUs and 65536 MiB of memory; omitting both values uses the existing OS defaults. `/new` and `/fork` hand the active sandbox execution to the replacement session without syncing or tearing it down.
- `/tree` changes conversation history but never changes execution placement.
- `/resume` restores the selected thread's saved sandbox and workspace. session switching, reload, and quit disconnect without syncing or deleting workspaces. use `/sandbox local` to explicitly sync back.
- the footer shows the selected sandbox. successful environment switches also append a visible thread message naming the previous and new environment. it enters model context on the next normal request without triggering a turn. failed switches and restore-only reconnects do not announce a switch. no remote tui or conversation session is created.

custom images are available through the structured `cua_sandbox` create action's `image` field. they must be Fleet-compatible CUA containerDisks and pinned by `sha256` digest; mutable tags are rejected.

`cua_sandbox`, `enter_environment`, and `report_papercut` are local control-plane tools. every other registered tool is proxied by name, except that `read` handles Pi's controller-local `pi-clipboard-*` image paths locally so pasted screenshots remain visible. ordinary file reads stay remote. sandbox activation fails if the remote pi sdk host does not expose a required tool; calls never fall back to local execution. tools registered after activation are blocked until `/reload` rebuilds the routed tool set, and the active sandbox cannot be deleted until the session returns to local execution.

## portable Pi configuration

Sandbox runtimes inherit portable Pi configuration instead of starting with package settings alone:

- global Pi JSON configuration, including `pi-fff.json`, plus JSON overrides from the current project's `.pi` directory when the controller marks that project trusted;
- global and shared skills, declared skill resources from packages/settings, supporting files, and executable permissions;
- global themes, prompt files, `config/` and `configs/` resources, and the installed Pi documentation/examples.

Authentication, model stores, trust records, model-selection settings, and controller execution hooks stay local. Credential-looking fields and unsupported absolute-path settings are omitted with transfer notes. Packages/extensions remain restricted to the existing routed-tool selection; this does not copy the sandbox controller into the guest or execute another model. Configuration transfer is not arbitrary home-directory synchronization.

Skill roots explicitly declared by the controller may resolve through directory symlinks; their canonical contents and original path aliases are recorded. Other symlinks, dependency caches, environment files, and private-key files are excluded. Files over 8 MiB are reported and skipped; root JSON configuration is limited to 1 MiB per file and the snapshot to 64 MiB. Invalid JSON fails preparation. Review transfer notes for settings that require platform-specific configuration or separate credentials.

`read`, `find`, and `grep` (including fff's prefixed names) translate known controller resource paths into the copied guest runtime. Reads identify the actual guest path so supporting scripts can use it. Ordinary workspace paths are untouched, missing remote files never fall back locally, and mapped configuration writes are rejected. To change configuration, edit it on the controller and reconnect or reload; a live connection is a snapshot, not continuous synchronization. Config/resource changes participate in the runtime digest.

Papercuts are live controller state, not a runtime snapshot. `report_papercut` and `read` of `~/.pi/agent/papercuts/<project-key>/papercuts.md` use the same controller ledger across sandbox switches, including reports added after entry. The configured Pi agent directory is honored. Read results identify their controller location; guest shell commands and search tools still operate on guest files. This is a narrow path rule, not missing-file fallback. Project keys still follow the papercuts extension's controller working-directory identity; unrelated checkouts are not merged.

Tool activation verifies the remote provider, not just its name: builtin search cannot silently stand in for fff. The controller proxy must also win Pi's extension registration precedence. Load pi-cua before competing tool packages. For an auto-discovered local installation, place `"./extensions/cua-sandbox"` first in the global `settings.json` packages array, then `/reload`. This uses normal Pi configuration, not a modified SDK.

Every guest host sets `PI_CODING_AGENT_DIR` to its own runtime before extension initialization. Windows caches separate child host processes under the interactive broker, preserving reconnect state while isolating per-runtime environment variables. They inherit the broker's logged-in desktop session and communicate over IPC behind the same SSH connection; there is no additional network connection or model turn.

## unavailable or replaced machines

Lifecycle policy follows ownership, never hostname or operating system. Fleet-managed guests are disposable. Externally added hosts are persistent, including future externally added Linux and Windows hosts.

The picker retains unavailable targets. Selecting an unavailable Fleet guest makes one bounded setup-recovery attempt through its existing claim. `ensure` installs missing prerequisites and re-enrolls only when enrollment is missing or mismatched. A changed Fleet device generation discards stale resume paths and reconstructs from the controller's source. Guest-only edits and artifacts may be lost; save important work to the controller or another durable location. Recovery reports what happened and never replays an already dispatched tool operation. It does not create or delete Fleet claims automatically.

Persistent hosts never enter Fleet bootstrap or automatic re-enrollment. Offline persistent hosts report an access error, and changed identities block automatic resume. Explicit replacement selection retains the existing confirmation and placement audit record. Persistent does not imply that the extension keeps a machine powered on or backs up its disk.

No recovery flags are needed: use `/sandbox windows-1` or `cua_sandbox` with `action=ensure` and its name. A controller network outage, invalid enrollment response, or guest transport failure stops with an error rather than triggering a blind reset. A peer sharing a hostname cannot establish the identity of a saved target.

## failure and repair boundaries

Cancellation is a control-flow exception, not an unhealthy result. Health, enrollment, transport, and retry handlers must let it escape. Setup preserves SSH errors and invalid protocol responses instead of converting them into automatic repair requests. Fleet connection has one application-level attempt; a known missing prerequisite or refused Windows broker connection may request repair, but authentication failures and timeouts do not.

A machine repair checks enrollment separately. If the tailnet and admission tag already match, bootstrap does not mint an auth key or force reauthentication. This preserves device identity during Pi or prerequisite updates. A missing Tailscale installation or explicit logged-out state permits Fleet recovery. Other failed enrollment inspections stop with their error rather than guessing that reauthentication is safe. Machine prerequisites still share a bootstrap script; they are not yet independently installed runtime components.

Lock acquisition is bounded to 30 seconds per lock. Controller backend processes have a 45-minute deadline; execution materialization and its repair attempt share a 10-minute abort signal. Cancellation allows five seconds for cleanup, then terminates the local backend process group. Forced termination does not prove a detached guest job stopped: retained claims and incomplete staging directories may require inspection before another attempt.

Runtime staging must successfully create and dispose a tool host with the base coding tools before publishing its completion marker. Actual connection still validates the complete requested tool manifest and, on Windows, the interactive broker. This installation check is not a GUI permission or desktop-readiness certification.

## resume checks

A matching saved device generation takes the direct connection path without a separate runtime, disk, or repository preflight. If connection setup falls back to reconciliation, one SSH call checks the saved runtime and Git workspace together, including the saved working directory. An existing usable runtime and workspace can resume below the 1 GiB setup threshold without querying the repository remote or inspecting the controller checkout.

The space gate still applies when installing a missing runtime or preparing a new workspace. A missing workspace enters the normal reconstruction path. This is not a general maintenance mode: first entry that needs a new workspace can still be blocked by low disk space. Identity checks remain unchanged, and no dispatched tool operation is replayed. The controller Pi version is cached only for the lifetime of one backend process, avoiding repeated `pi --version` subprocesses during setup.

## execution path

1. the extension starts one backend process and reads progress and the final result from its jsonl stream; healthy setup uses the controller's existing Python, while provisioning and repair re-exec under the isolated Fleet sdk runtime;
2. one ssh preflight checks machine health and the requested runtime generation; Windows preflights check the broker loopback listener inside that same SSH call, avoiding a second handshake; broker reads and writes have five-second timeouts, while ensure also validates scheduled task `CuaPiDesktopToolBroker`; Git-backed threads additionally check free disk and repository-cache availability;
3. one content-addressed runtime is staged under `~/.cua-pi/runtimes/<digest>`, installs exact npm versions and Git commits with production dependencies but without private copies of Pi peer packages, and is published only after package reconciliation succeeds; the three newest generations coexist instead of rewriting shared Pi settings;
4. when the thread has a supported Git workspace, one workspace command prepares an isolated clone from the shared object cache, then applies one direct Git tree patch from the source state to the final destination state; after replacement, runtime and workspace materialization run concurrently because neither mutates the other;
5. the extension starts one non-tty ssh jsonl channel; linux and macos run `cua-tool-host.mjs` directly, while Windows uses OpenSSH direct-TCP forwarding to the existing interactive desktop broker;
6. the host loads pi's normal remote tool registry from the requested runtime directory, rejects an incomplete required-tool set, then echoes the validated protocol, runtime generation, and tool manifest;
7. calls, updates, results, errors, cancellation, and user shell output use that channel. `Esc` rejects the local request immediately and asks the host to kill the full remote command process tree.

Git-backed target changes use one workspace model: Pi records local and sandbox Git trees at sandbox entry, computes one accumulated binary tree diff from the original commit to the source's final tree, verifies the destination tree, and applies that diff. after a successful move to local or another sandbox, it removes the source workspace, including ignored build outputs. shutdown preserves the workspace and placement. `/new` and `/fork` inherit the sandbox choice and copy the parent's current Git working state into a separate workspace, excluding ignored outputs. a fork does not restore historical filesystem contents. non-Git children start with a separate empty execution directory. startup, reload, resume, explicit reselection, and bridge reconnection resolve the stable sandbox name to its current network endpoint. the normal resume path opens the exact saved runtime and workspace directly; if that open fails before an operation runs, activation performs the full validation and reconstruction path once. non-conflicting local and sandbox edits are merged during sync. a patch conflict or cleanup failure is reported explicitly without modifying the local files, and a failed sync retains the remote workspace rather than deleting the only copy of changes.

threads outside Git repositories use a persistent execution directory derived from the stored execution identity. placement, tools, shell commands, reload, `/new`, and `/fork` work normally, but Pi does not copy or synchronize the controller's arbitrary local directory. different threads remain isolated while using the same sandbox, and switching targets retires the tool host without deleting the execution directory.

## state

execution placement is stored only as non-context Pi session metadata. restore reads the latest placement across the full session rather than the active branch, so `/tree` and compaction cannot change it. saved placement contains the sandbox name, execution identity, and verified device generation, never an address or runtime generation. a pending target change is also stored until activation succeeds, so `/reload` can resume a connection that it interrupted. the controller keeps one atomic json claim per Fleet sandbox; tagged macos peers remain derived tailnet state. a matching device generation opens the host directly; a changed generation reconciles the runtime and workspace before opening it. no database, transport cache, or background operation queue is involved. claim lifecycle and health checks hold the controller lock, while activation, transfer, and cleanup lock only the involved sandboxes. multi-sandbox transfers acquire their locks in stable order, so unrelated targets can proceed concurrently without deadlocking.

each sandbox execution derives an opaque id from the Pi thread and stores it with the execution target. Git-backed execution uses it for the isolated workspace; non-Git execution uses it for a persistent directory under the sandbox user profile. `/new` and `/fork` use the new thread's identity and never change the parent's saved placement. copied fork placement and pending connection metadata are cleared before child setup. failed child setup blocks execution for that runtime and leaves local placement for a later reload; it never falls back to the parent's mutable workspace. retained workspaces consume disk until explicitly cleaned up. saved targets that predate execution identity acquire one during their next resume. failed Git destination setup removes its incomplete workspace before returning the error.

placement adds an operating-system instruction and a logical `workspace root` or `execution root` cwd to the model prompt. switch messages provide chronological environment context in the conversation without exposing physical workspace paths. runtime placement metadata remains the authority for restoring the connection.

tool state belongs to one immutable bridge generation. activation prepares and validates a replacement bridge before publishing it, then retires the previous bridge. a disconnected bridge is never retargeted, and no dispatched operation is replayed. a Windows session replacement can reattach to the execution-scoped host because the desktop broker owns it; Linux and macos start a fresh host on the new SSH channel.

pi-cua emits `cua:execution-target-changed` with local, connecting, failed, and ready target states. a custom footer can consume this event without coupling its layout to the controller.

## guest boundary

the guest receives the pi sdk version, routed-tool packages and declared regular user-extension entry files, the portable configuration snapshot described above, and the generic tool host. symlinks and undeclared extension files do not cross the guest boundary. machine bootstrap owns operating-system dependencies and the Windows desktop broker. execution runtimes own their isolated host, extensions, settings, and package installs. the local route catalog is captured once before proxies replace tool definitions, and package sources are pinned to the installed npm version or Git commit. because each runtime contains only routed-tool packages, the host can run their normal lifecycle before validating the required-tool set, including extensions that register tools during session startup. it does not receive local model credentials, prompts, conversation sessions, or the sandbox controller.

workspace transfer requires a git repository with a network `origin` and does not support submodules, Git content filters, or working-tree encodings. if the guest cannot authenticate to the origin, the controller sends a clean commit snapshot and creates an isolated baseline without copying git credentials. entering a sandbox from local carries local changes, limited to 200 mib. guests keep one bare repository cache outside all workspaces; isolated clones borrow its objects through Git alternates instead of duplicating packs or sharing mutable Git configuration. package-manager caches remain in the guest user profile. target changes between local and sandbox environments transfer only the accumulated binary Git tree diff, then remove the generated source workspace. `/new` and `/fork` instead transfer ownership of the active workspace without copying it. ignored files, credentials, caches, and processes are not transferred as task state.

on macos, the external host must already have a logged-in graphical session. desktop tools also require the relevant Accessibility and Screen Recording approvals for the installed runtime. registration and health checks prove only SSH and command-line readiness; they do not grant TCC rights or claim universal GUI support.

on Windows, OpenSSH remains in Session 0 and forwards its authenticated channel directly to the loopback-only broker. scheduled task `CuaPiDesktopToolBroker` runs that broker as the logged-in user and keeps execution-and-generation-scoped child Pi hosts in the same interactive session, so GUI tools and shell commands share the desktop while configuration remains process-isolated. bootstrap disables Windows Server's shutdown event tracker so an unexpected guest restart cannot leave a modal dialog blocking unattended desktop work. the broker accepts only a runtime directory that matches the requested content digest, caches exact generation matches, and returns typed broker or runtime open failures. `cua_sandbox ensure` repairs a missing, disabled, or non-listening broker, while package capability errors remain distinct from task failures.

## verification

```bash
uvx --quiet ruff format --check backend.py pi_config.py test_backend.py test_pi_config.py
uvx --quiet ruff check backend.py pi_config.py test_backend.py test_pi_config.py
python3 -m unittest -q test_backend.py test_pi_config.py
node --test test-tool-broker.mjs test-session-lifecycle.mjs test-tool-host-worker.mjs
npm exec --yes --package=prettier -- prettier --check index.ts tool-host.mjs tool-broker.mjs test-tool-broker.mjs test-session-lifecycle.mjs test-tool-host-worker.mjs
node --check tool-host.mjs
pi --list-models
```

For an opt-in native configuration smoke, install fff locally in override mode and run `node smoke-pi-config.mjs linux` (or `macos`/`windows`). It uses an isolated SDK conversation with model networking disabled, enters an existing guest, verifies fff search, mapped skill/config reads, and execution of a copied helper. It does not create or delete machines; its small execution workspace is retained by the normal lifecycle.

The configuration-transfer change has native Linux and macOS command-line evidence, plus broker/worker lifecycle coverage using local IPC. Windows native validation is blocked by its unavailable guest and timed-out repair; these tests do not claim Windows desktop or GUI readiness. Session-only extension mode changes and environment-variable overrides are not copied as configuration: persist portable settings in JSON, and inspect provider-mismatch errors or transfer notes rather than assuming a fallback is equivalent.
