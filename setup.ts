import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { layout, pathPrefix, run, sh, type Remote } from "./remote.ts";
import { isSpaceOS, type ProcessHandle, type SpaceItem, type SpacesClient } from "./spaces.ts";
import type { Runtime } from "./config.ts";
import { freeSpaceCheck } from "./workspace.ts";

const extensionDir = dirname(fileURLToPath(import.meta.url));
export const protocolVersion = 5;
const maxLine = 64 * 1024 * 1024;

export function hostFiles(): Record<string, Buffer> {
  return {
    "cua-tool-host.mjs": readFileSync(join(extensionDir, "tool-host.mjs")),
  };
}

const publish = `node -e 'const fs = require("node:fs"); try { fs.renameSync(process.argv[1], process.argv[2]); } catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error; }'`;

export type Probe = { home: string; machineId: string; freeBytes: number };

export async function probe(
  client: SpacesClient,
  space: SpaceItem,
  signal?: AbortSignal,
): Promise<{ remote: Remote; probe: Probe }> {
  if (!isSpaceOS(space.os))
    throw new Error(`${space.name} runs ${space.os || "an unknown OS"}; pi-cua supports Linux and macOS Spaces`);
  const partial: Remote = { client, spaceId: space.id, name: space.name, os: space.os, home: "" };
  const machineId =
    space.os === "macos"
      ? `ioreg -rd1 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/ { print $4 }'`
      : "cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id";
  const result = await run(
    partial,
    `missing=""
for tool in node npm git; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done
if [ -n "$missing" ]; then echo "missing:$missing" >&2; exit 20; fi
printf 'home=%s\\n' "$HOME"
mkdir -p "$HOME/.cua-pi"
[ -s "$HOME/.cua-pi/machine-id" ] || node -e 'process.stdout.write(require("node:crypto").randomUUID())' > "$HOME/.cua-pi/machine-id"
printf 'machine=%s/%s\\n' "$(${machineId})" "$(cat "$HOME/.cua-pi/machine-id")"
printf 'free=%s\\n' "$(( $(df -Pk "$HOME" | awk 'NR == 2 { print $4 }') * 1024 ))"`,
    { timeoutMs: 30_000, signal, label: "prerequisite check", check: false },
  );
  if (result.exitCode === 20)
    throw new Error(
      `${space.name} is missing${result.stderr.replace(/^missing:/, "").trim().replace(/^/, " ")}; install Node.js 22+, npm and git there, then try again`,
    );
  if (result.exitCode !== 0)
    throw new Error(`prerequisite check on ${space.name} failed: ${(result.stderr || result.stdout.toString("utf8")).trim().slice(-500)}`);
  const fields = Object.fromEntries(
    result.stdout
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  if (!fields.home?.startsWith("/") || !fields.machine || !/^\d+$/.test(fields.free ?? ""))
    throw new Error(`invalid prerequisite response from ${space.name}`);
  return {
    remote: { ...partial, home: fields.home },
    probe: { home: fields.home, machineId: fields.machine.trim(), freeBytes: Number(fields.free) },
  };
}

export async function ensurePi(remote: Remote, version: string, signal?: AbortSignal): Promise<string> {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`unexpected Pi version: ${version}`);
  const paths = layout(remote.home);
  const root = paths.pi(version);
  await run(
    remote,
    `set -eu
root=${sh(root)}
if [ -f "$root/complete" ]; then exit 0; fi
${freeSpaceCheck}
staging="$root.$$"
trap 'rm -rf "$staging"' EXIT
rm -rf "$staging"
mkdir -p "$staging"
npm_config_cache=${sh(paths.npmCache)} npm install --prefix "$staging" --omit=dev --no-audit --no-fund --loglevel=error ${sh(`@earendil-works/pi-coding-agent@${version}`)} >&2
touch "$staging/complete"
mkdir -p "$(dirname "$root")"
${publish.trim()} "$staging" "$root"`,
    { timeoutMs: 15 * 60_000, signal, label: `installing pi ${version}` },
  );
  return root;
}

const extractScript = `const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const target = process.argv[1];
const bundle = JSON.parse(zlib.gunzipSync(fs.readFileSync(0)).toString("utf8"));
const executables = new Set(bundle.executables);
for (const [name, content] of Object.entries(bundle.files)) {
  if (path.isAbsolute(name) || name.split("/").includes("..")) throw new Error("invalid runtime path: " + name);
  const destination = path.join(target, "agent", name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, Buffer.from(content, "base64"), { mode: executables.has(name) ? 0o755 : 0o644 });
}`;

export async function ensureRuntime(
  remote: Remote,
  runtime: Runtime,
  piRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  const paths = layout(remote.home);
  const root = paths.runtime(runtime.hash);
  const present = await run(remote, `test -f ${sh(`${root}/complete`)}`, { check: false, signal, label: "runtime check" });
  if (present.exitCode === 0) return root;
  const manifest = Buffer.from(JSON.stringify({ tools: ["read", "bash", "edit", "write"], runtimeDigest: runtime.hash })).toString("base64");
  const validation = `import { pathToFileURL } from "node:url";
const stage = process.env.CUA_RUNTIME_STAGE;
const { createToolHost } = await import(pathToFileURL(stage + "/agent/cua-tool-host.mjs"));
const host = await createToolHost({ cwd: stage + "/agent", agentDir: stage + "/agent", piRoot: process.env.CUA_PI_ROOT, encodedManifest: ${JSON.stringify(manifest)} });
await host.dispose();`;
  await run(
    remote,
    `set -eu
root=${sh(root)}
${freeSpaceCheck}
staging="$root.$$"
trap 'rm -rf "$staging"' EXIT
rm -rf "$staging"
mkdir -p "$staging"
node -e ${sh(extractScript)} "$staging"
PI_CODING_AGENT_DIR="$staging/agent" npm_config_cache=${sh(paths.npmCache)} npm_config_omit=dev npm_config_legacy_peer_deps=true node ${sh(`${piRoot}/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`)} update --extensions --no-approve >&2
CUA_RUNTIME_STAGE="$staging" CUA_PI_ROOT=${sh(piRoot)} node --input-type=module -e ${sh(validation)} >&2
printf '%s\\n' ${sh(runtime.hash)} > "$staging/complete"
${publish.trim()} "$staging" "$root"`,
    { timeoutMs: 20 * 60_000, signal, label: "runtime setup", input: runtime.bundle },
  );
  return root;
}

type ToolUpdate = { content?: unknown; details?: unknown };

export type RemoteToolInfo = {
  name: string;
  sourceInfo?: { origin?: string; source?: string; path?: string };
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  constrainedSampling?: unknown;
  renderShell?: unknown;
  executionMode?: unknown;
};

type HostMessage = {
  type: string;
  id?: string;
  error?: string;
  result?: AgentToolResult<unknown>;
  update?: ToolUpdate;
  data?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  aborted?: boolean;
  tools?: RemoteToolInfo[];
  protocol?: number;
  runtimeDigest?: string;
};

type Pending = {
  resolve: (message: HostMessage) => void;
  reject: (error: Error) => void;
  onMessage: (message: HostMessage) => void;
};

export class RemoteHost {
  private process: ProcessHandle | undefined;
  private starting: Promise<void> | undefined;
  private tools = new Map<string, RemoteToolInfo>();
  private readonly pending = new Map<string, Pending>();
  private stderr = "";

  constructor(
    readonly remote: Remote,
    readonly executionId: string,
    readonly runtimeHash: string,
    private readonly runtimeRoot: string,
    private readonly piRoot: string,
    private readonly cwd: string,
    private readonly expectedTools: readonly string[],
  ) {}

  private get tag(): string {
    return `pi-cua-${this.executionId}`;
  }

  private fail(error: Error): void {
    this.process = undefined;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private async start(signal?: AbortSignal): Promise<void> {
    await this.remote.client.killTag(this.remote.spaceId, this.tag, signal);
    const manifest = Buffer.from(JSON.stringify({ tools: this.expectedTools, runtimeDigest: this.runtimeHash })).toString("base64");
    let buffer = "";
    let ready: (message: HostMessage) => void;
    let failed: (error: Error) => void;
    const opened = new Promise<HostMessage>((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });
    this.stderr = "";
    const process = await this.remote.client.spawn(
      this.remote.spaceId,
      {
        program: "/bin/sh",
        args: [
          "-c",
          `${pathPrefix}cd "$1" && exec node "$2" "$1" "$3" "$4" "$5"`,
          "sh",
          this.cwd,
          `${this.runtimeRoot}/agent/cua-tool-host.mjs`,
          `${this.runtimeRoot}/agent`,
          this.piRoot,
          manifest,
        ],
        tag: this.tag,
        stdin: true,
      },
      (stream, data) => {
        if (stream === "stderr") {
          this.stderr = `${this.stderr}${data}`.slice(-8000);
          return;
        }
        buffer += data.toString("utf8");
        if (buffer.length > maxLine && !buffer.includes("\n")) {
          failed(new Error("tool host exceeded the protocol line limit"));
          void process.kill();
          return;
        }
        for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          let message: HostMessage;
          try {
            message = JSON.parse(line);
          } catch {
            this.stderr = `${this.stderr}\ninvalid host output: ${line.slice(0, 200)}`.slice(-8000);
            continue;
          }
          if (message.type === "ready" || message.type === "open_error") ready(message);
          else if (message.id) this.pending.get(message.id)?.onMessage(message);
        }
      },
      signal,
    );
    this.process = process;
    void process.exited.then((exit) => {
      const detail = this.stderr.trim();
      const error = new Error(
        `tool host on ${this.remote.name} exited (${exit.code ?? exit.signal ?? exit.error ?? "unknown"})${detail ? `: ${detail.slice(-1000)}` : ""}`,
      );
      failed(error);
      if (this.process === process) this.fail(error);
    });
    const timer = setTimeout(() => failed(new Error(`tool host on ${this.remote.name} did not start: ${this.stderr.trim().slice(-1000)}`)), 180_000);
    try {
      const message = await opened;
      if (message.type === "open_error") throw new Error(`tool host on ${this.remote.name} failed to start: ${message.error}`);
      if (message.protocol !== protocolVersion)
        throw new Error(`remote tool protocol mismatch: expected ${protocolVersion}, got ${message.protocol ?? "none"}`);
      if (message.runtimeDigest !== this.runtimeHash)
        throw new Error(`remote runtime mismatch on ${this.remote.name}: expected ${this.runtimeHash}, got ${message.runtimeDigest ?? "none"}`);
      this.tools = new Map((message.tools ?? []).map((tool) => [tool.name, tool]));
    } catch (error) {
      void process.kill();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async ensure(signal?: AbortSignal): Promise<void> {
    if (this.process) return;
    this.starting ??= this.start(signal).finally(() => {
      this.starting = undefined;
    });
    await this.starting;
  }

  definition(name: string): RemoteToolInfo | undefined {
    return this.tools.get(name);
  }

  private async request(
    message: Record<string, unknown> & { id: string },
    onMessage: (message: HostMessage) => boolean,
    signal?: AbortSignal,
  ): Promise<HostMessage> {
    if (signal?.aborted) throw new Error("aborted");
    await this.ensure(signal);
    const process = this.process;
    if (!process) throw new Error(`tool host on ${this.remote.name} is not running`);
    return new Promise<HostMessage>((resolve, reject) => {
      const finish = (callback: () => void) => {
        this.pending.delete(message.id);
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => {
        void process.write(Buffer.from(`${JSON.stringify({ type: "cancel", id: message.id })}\n`)).catch(() => undefined);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(message.id, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
        onMessage: (value) => {
          if (onMessage(value)) finish(() => resolve(value));
        },
      });
      process.write(Buffer.from(`${JSON.stringify(message)}\n`)).catch((error) => this.pending.get(message.id)?.reject(error));
    });
  }

  async execute(
    toolName: string,
    id: string,
    input: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((update: any) => void) | undefined,
  ): Promise<AgentToolResult<unknown>> {
    const message = await this.request(
      { type: "execute", id, tool: toolName, input },
      (value) => {
        if (value.type === "update" && value.update) onUpdate?.(value.update);
        return value.type === "result" || value.type === "error";
      },
      signal,
    );
    if (message.type === "error") throw new Error(message.error || "remote tool failed");
    return message.result!;
  }

  async bash(
    id: string,
    command: string,
    options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
  ): Promise<{ exitCode: number | null }> {
    const message = await this.request(
      { type: "bash", id, command, timeout: options.timeout },
      (value) => {
        if (value.type === "bash_update" && value.data) options.onData(Buffer.from(value.data, "base64"));
        return value.type === "bash_result" || value.type === "error";
      },
      options.signal,
    );
    if (message.type === "error") throw new Error(message.error || "remote command failed");
    if (message.aborted) throw new Error("aborted");
    if (message.timedOut) throw new Error(`timeout:${options.timeout}`);
    return { exitCode: message.exitCode ?? null };
  }

  async shutdown(): Promise<void> {
    const process = this.process;
    this.fail(new Error("tool host was shut down"));
    if (process) await process.kill().catch(() => undefined);
    else await this.remote.client.killTag(this.remote.spaceId, this.tag).catch(() => undefined);
  }
}
