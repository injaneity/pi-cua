import {
  type AgentToolResult,
  type BashOperations,
  createReadTool,
  type ExtensionAPI,
  type ReadToolInput,
  type ExtensionCommandContext,
  type ExtensionContext,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  Editor,
  Key,
  matchesKey,
  SelectList,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const backend = join(extensionDir, "backend.py");
const windowsIdentity = join(homedir(), ".ssh", "cua_windows_ed25519");
const macosIdentity = join(homedir(), ".ssh", "cua_macos_ed25519");
const sandboxKnownHosts = join(homedir(), ".ssh", "cua_known_hosts");
const protocolVersion = 3;
const maxProtocolLine = 1024 * 1024;
const windowsBrokerTask = "CuaPiDesktopToolBroker";
const executionTargetEntry = "cua-execution-target";
const executionTargetHandoffEntry = "cua-execution-target-handoff";
const executionTargetIntentEntry = "cua-execution-target-intent";
const localTools = new Set(["cua_sandbox", "report_papercut"]);

function latestCustomEntryData(
  entries: Array<{ type: string; customType?: string; data?: unknown }>,
  customType: string,
): unknown {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type === "custom" && entry.customType === customType)
      return entry.data;
  }
  return undefined;
}

function shouldHandoffExecutionTarget(reason: string): boolean {
  return reason === "new" || reason === "fork";
}

function shouldUseControllerTool(
  toolName: string,
  input: unknown,
): input is ReadToolInput {
  if (toolName !== "read" || input === null || typeof input !== "object")
    return false;
  const path = (input as { path?: unknown }).path;
  return (
    typeof path === "string" &&
    /^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T\/pi-clipboard-[^/]+\.(?:png|jpe?g|gif|webp|bmp)$/i.test(
      path,
    )
  );
}

const resourceSchema = Type.Object({
  action: StringEnum(["list", "create", "ensure", "delete"] as const),
  name: Type.Optional(
    Type.String({ description: "Managed sandbox name, such as linux-1" }),
  ),
  os: Type.Optional(StringEnum(["linux", "windows"] as const)),
  cpu: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      description: "CPU count; supply with memory_mb",
    }),
  ),
  memory_mb: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      description: "Memory in MiB; supply with cpu",
    }),
  ),
  image: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Digest-pinned OCI image for create",
    }),
  ),
  confirm: Type.Optional(
    Type.Boolean({
      description: "Required for create or delete when no UI is available",
    }),
  ),
});

type ResourceInput = Static<typeof resourceSchema>;
type SandboxOS = "linux" | "windows" | "macos";

function isSandboxOS(value: unknown): value is SandboxOS {
  return value === "linux" || value === "windows" || value === "macos";
}

type SandboxResources = { cpu: number; memory_mb: number };
type SandboxItem = {
  name: string;
  os: SandboxOS;
  pool: string;
  kind?: "fleet" | "external";
  discovered?: boolean;
  address?: string;
  generation?: string;
  online: boolean;
};
type WorkspaceState = {
  version: 1;
  localRoot: string;
  // immutable objects captured when this workspace first enters a sandbox
  commit: string;
  commitTree: string;
  baselineTree: string;
};
type BackendResult = {
  ok: boolean;
  error?: string;
  error_type?: string;
  progress?: boolean;
  phase?: string;
  message?: string;
  sandboxes?: SandboxItem[];
  name?: string;
  os?: SandboxOS;
  address?: string;
  changed?: boolean;
  remote_cwd?: string;
  workspace_state?: WorkspaceState;
  runtime_digest?: string;
  reconciled?: boolean;
  sandbox_generation?: string;
  additions?: number;
  deletions?: number;
  pending_sync?: boolean;
  removed?: boolean;
};
class BackendError extends Error {
  constructor(
    message: string,
    readonly errorType?: string,
  ) {
    super(message);
  }
}

type Destination =
  { kind: "local" } | { kind: "sandbox"; name: string; os: SandboxOS };
type StoredExecutionTarget =
  | { kind: "local" }
  | {
      kind: "sandbox";
      name: string;
      os: SandboxOS;
      executionId?: string;
      sandboxGeneration?: string;
      localCwd: string;
      remoteCwd: string;
      workspaceState?: WorkspaceState;
    };
type ExecutionTarget =
  | { kind: "local" }
  | (Extract<StoredExecutionTarget, { kind: "sandbox" }> & {
      address: string;
      runtimeDigest: string;
      reconciled: boolean;
    });
type ExecutionTargetIntent = {
  id: string;
  destination: Destination;
  source: StoredExecutionTarget;
};
type UIContext = ExtensionContext | ExtensionCommandContext;

type ToolWithSource = ReturnType<ExtensionAPI["getAllTools"]>[number];

function packageRoot(path: string, packageName?: string): string | undefined {
  let current = dirname(path);
  for (;;) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      if (!packageName) return current;
      try {
        const value = JSON.parse(readFileSync(manifest, "utf8")) as {
          name?: unknown;
        };
        if (value.name === packageName) return current;
      } catch {}
    }
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) return undefined;
    current = parent;
  }
}

function immutablePackageSource(tool: ToolWithSource): string {
  const source = tool.sourceInfo.source;
  if (source.startsWith("npm:")) {
    const match = source.match(/^npm:(@[^/]+\/[^@]+|[^@]+)(?:@.+)?$/);
    if (!match) throw new Error(`unsupported npm tool package: ${source}`);
    const root = packageRoot(tool.sourceInfo.path, match[1]);
    if (!root)
      throw new Error(`cannot locate installed tool package: ${source}`);
    const manifest = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as {
      version?: unknown;
    };
    if (typeof manifest.version !== "string" || !manifest.version)
      throw new Error(`tool package has no version: ${source}`);
    return `npm:${match[1]}@${manifest.version}`;
  }

  const root = packageRoot(tool.sourceInfo.path);
  if (!root) throw new Error(`cannot locate installed tool package: ${source}`);
  const revision = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  const commit = revision.stdout.trim();
  if (revision.status !== 0 || !/^[0-9a-f]{40,64}$/.test(commit))
    throw new Error(`cannot resolve tool package revision: ${source}`);
  const marker = source.lastIndexOf("@");
  const pathStart = Math.max(source.lastIndexOf("/"), source.lastIndexOf(":"));
  const repository = marker > pathStart ? source.slice(0, marker) : source;
  return `${repository}@${commit}`;
}

function formatSandboxProgress(
  name: string,
  phase?: string,
  message?: string,
): string {
  if (phase === "lock")
    return `${name} (waiting for another sandbox operation)`;

  let activity = "connecting";
  if (phase?.startsWith("bootstrap.") || phase?.startsWith("upload.windows."))
    activity = "repairing guest";
  else if (phase?.startsWith("workspace.")) activity = "syncing workspace";

  const detail =
    message && !["started", "completed"].includes(message)
      ? ` • ${message}`
      : "";
  return `${name} (${activity})${detail}`;
}
type AnyToolDefinition = ToolDefinition<any, any, any>;
type ToolUpdate = Parameters<
  NonNullable<Parameters<AnyToolDefinition["execute"]>[3]>
>[0];

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onUpdate?: (update: ToolUpdate) => void;
  onData?: (data: Buffer) => void;
};

type RemoteToolInfo = {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: AnyToolDefinition["parameters"];
  constrainedSampling?: AnyToolDefinition["constrainedSampling"];
  renderShell?: AnyToolDefinition["renderShell"];
  executionMode?: AnyToolDefinition["executionMode"];
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
  owner?: "broker" | "runtime";
  code?: string;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function sshArgs(
  target: Extract<ExecutionTarget, { kind: "sandbox" }>,
): string[] {
  return [
    ...(target.os === "windows"
      ? ["-i", windowsIdentity]
      : target.os === "macos"
        ? ["-i", macosIdentity]
        : []),
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${sandboxKnownHosts}`,
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    "LogLevel=ERROR",
    "-T",
    ...(target.os === "windows" ? ["-W", "127.0.0.1:43121"] : []),
    `${target.os === "macos" ? "administrator" : "cua"}@${target.address}`,
  ];
}

function encodedToolManifest(
  expectedTools: string[],
  runtimeDigest: string,
): string {
  return Buffer.from(
    JSON.stringify({
      tools: expectedTools,
      runtimeDigest,
    }),
  ).toString("base64");
}

function runtimeAgentDir(
  target: Extract<ExecutionTarget, { kind: "sandbox" }>,
): string {
  if (!target.runtimeDigest)
    throw new Error(`sandbox ${target.name} has no runtime generation`);
  return target.os === "windows"
    ? `C:\\Users\\cua\\.cua-pi\\runtimes\\${target.runtimeDigest}\\agent`
    : `${target.os === "macos" ? "/Users/administrator" : "/home/cua"}/.cua-pi/runtimes/${target.runtimeDigest}/agent`;
}

function hostCommand(
  target: Extract<ExecutionTarget, { kind: "sandbox" }>,
  manifest: string,
): string {
  const agentDir = runtimeAgentDir(target);
  const environment =
    target.os === "macos"
      ? "PATH=/usr/local/bin:/usr/bin:/bin; export PATH; "
      : "";
  const node = target.os === "macos" ? "/usr/local/bin/node" : "node";
  return `${environment}cd ${shellQuote(target.remoteCwd)} && exec ${node} ${shellQuote(`${agentDir}/cua-tool-host.mjs`)} ${shellQuote(target.remoteCwd)} ${shellQuote(agentDir)} ${shellQuote(manifest)}`;
}

function brokerStartupError(
  target: Extract<ExecutionTarget, { kind: "sandbox" }>,
  message: string,
): Error {
  if (target.os !== "windows") return new Error(message);
  const request = JSON.stringify({ action: "ensure", name: target.name });
  return new Error(
    `${message}; Windows broker task ${windowsBrokerTask} is unavailable or stale: run cua_sandbox with ${request}, then run /reload`,
  );
}

class ToolBridge {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private startPromise: Promise<void> | undefined;
  private stderr = "";
  private ready = false;
  private closed = false;
  private readonly remoteTools = new Map<string, RemoteToolInfo>();

  constructor(
    private readonly target: Extract<ExecutionTarget, { kind: "sandbox" }>,
    private readonly expectedTools: string[],
  ) {}

  private send(message: Record<string, unknown>): void {
    if (!this.child?.stdin.writable)
      throw new Error("remote tool host is not connected");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handle(message: HostMessage): void {
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === "update" && message.update) {
      pending.onUpdate?.(message.update);
      return;
    }
    if (message.type === "bash_update" && message.data) {
      pending.onData?.(Buffer.from(message.data, "base64"));
      return;
    }
    if (message.type === "result" && message.result) {
      this.pending.delete(message.id);
      pending.resolve(message.result);
      return;
    }
    if (message.type === "bash_result") {
      this.pending.delete(message.id);
      if (message.aborted) pending.reject(new Error("aborted"));
      else if (message.timedOut)
        pending.reject(new Error("remote command timed out"));
      else pending.resolve({ exitCode: message.exitCode ?? null });
      return;
    }
    if (message.type === "error") {
      this.pending.delete(message.id);
      pending.reject(new Error(message.error || "remote tool failed"));
    }
  }

  private open(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.stderr = "";
      if (!this.target.runtimeDigest)
        throw new Error(
          `sandbox ${this.target.name} has no runtime generation`,
        );
      const manifest = encodedToolManifest(
        this.expectedTools,
        this.target.runtimeDigest,
      );
      const child = spawn(
        "ssh",
        [
          ...sshArgs(this.target),
          ...(this.target.os !== "windows"
            ? [hostCommand(this.target, manifest)]
            : []),
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      this.child = child;
      if (this.target.os === "windows") {
        child.stdin.write(
          `${JSON.stringify({
            type: "open",
            cwd: this.target.remoteCwd,
            agentDir: runtimeAgentDir(this.target),
            manifest,
          })}\n`,
        );
      }
      const decoder = new StringDecoder("utf8");
      let stdout = "";
      const timeout = setTimeout(() => {
        child.kill();
        reject(
          brokerStartupError(
            this.target,
            `remote tool host did not start on ${this.target.name}`,
          ),
        );
      }, 300_000);
      child.stdout.on("data", (chunk: Buffer) => {
        if (this.closed || this.child !== child) return;
        stdout += decoder.write(chunk);
        if (stdout.length > maxProtocolLine && !stdout.includes("\n")) {
          child.kill();
          reject(
            new Error("remote tool host exceeded the protocol line limit"),
          );
          return;
        }
        for (;;) {
          const index = stdout.indexOf("\n");
          if (index < 0) break;
          const line = stdout.slice(0, index).replace(/\r$/, "");
          stdout = stdout.slice(index + 1);
          if (!line) continue;
          if (line.length > maxProtocolLine) {
            child.kill();
            reject(
              new Error("remote tool host exceeded the protocol line limit"),
            );
            return;
          }
          try {
            const message = JSON.parse(line) as HostMessage;
            if (message.type === "open_error") {
              child.kill();
              reject(
                new Error(
                  `remote ${message.owner ?? "runtime"} ${message.code ?? "open_failed"} on ${this.target.name} generation ${this.target.runtimeDigest}: ${message.error ?? "tool host failed"}`,
                ),
              );
              return;
            }
            if (message.type === "ready") {
              const tools = Array.isArray(message.tools) ? message.tools : [];
              if (message.protocol !== protocolVersion) {
                child.kill();
                reject(
                  new Error(
                    `remote tool protocol mismatch: expected ${protocolVersion}, got ${message.protocol ?? "none"}`,
                  ),
                );
                return;
              }
              if (message.runtimeDigest !== this.target.runtimeDigest) {
                child.kill();
                reject(
                  new Error(
                    `remote runtime generation mismatch on ${this.target.name}: expected ${this.target.runtimeDigest}, got ${message.runtimeDigest ?? "none"}`,
                  ),
                );
                return;
              }
              this.remoteTools.clear();
              for (const item of tools) this.remoteTools.set(item.name, item);
              this.ready = true;
              clearTimeout(timeout);
              resolve();
              continue;
            }
            this.handle(message);
          } catch {
            this.stderr = `${this.stderr}\ninvalid host output: ${line}`
              .trim()
              .slice(-8_000);
          }
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        this.stderr = `${this.stderr}${chunk.toString()}`.slice(-8_000);
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        this.ready = false;
        this.child = undefined;
        const detail = this.stderr.trim();
        const message = `remote tool host on ${this.target.name} exited (${code ?? "signal"})${detail ? `: ${detail}` : ""}`;
        const error = detail
          ? new Error(message)
          : brokerStartupError(this.target, message);
        reject(error);
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
      });
    });
  }

  connect(): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error("remote tool bridge is closed"));
    if (this.ready) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.open().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  get connected(): boolean {
    return this.ready;
  }

  definition(name: string): RemoteToolInfo | undefined {
    return this.remoteTools.get(name);
  }

  private async request<T>(
    id: string,
    message: Record<string, unknown>,
    options: {
      signal?: AbortSignal;
      onUpdate?: (update: ToolUpdate) => void;
      onData?: (data: Buffer) => void;
    } = {},
  ): Promise<T> {
    if (!this.ready) throw new Error("remote tool host is not connected");
    if (options.signal?.aborted) throw new Error("aborted");
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => {
        try {
          this.send({ type: "cancel", id });
        } catch {}
        this.pending.delete(id);
        finish(() => reject(new Error("aborted")));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => finish(() => resolve(value as T)),
        reject: (error) => finish(() => reject(error)),
        onUpdate: options.onUpdate,
        onData: options.onData,
      });
      try {
        this.send(message);
      } catch (error) {
        this.pending.delete(id);
        finish(() =>
          reject(error instanceof Error ? error : new Error(String(error))),
        );
      }
    });
  }

  execute(
    toolName: string,
    id: string,
    input: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((update: ToolUpdate) => void) | undefined,
  ): Promise<AgentToolResult<unknown>> {
    return this.request(
      id,
      { type: "execute", id, tool: toolName, input },
      {
        signal,
        onUpdate,
      },
    );
  }

  bash(
    id: string,
    command: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
    },
  ): Promise<{ exitCode: number | null }> {
    return this.request(
      id,
      { type: "bash", id, command, timeout: options.timeout },
      options,
    );
  }

  close(dispose = false): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("remote tool bridge is closed");
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    const child = this.child;
    this.child = undefined;
    this.ready = false;
    if (!child) return;
    if (child.stdin.writable) {
      child.stdin.write(
        `${JSON.stringify({ type: dispose ? "shutdown" : "detach" })}\n`,
      );
      child.stdin.end();
    }
    const killTimer = setTimeout(() => child.kill(), 1_000);
    killTimer.unref();
  }
}

function creationDescription(
  resources?: SandboxResources,
  image?: string,
): string {
  return [
    resources
      ? `this provisions ${resources.cpu} CPUs and ${resources.memory_mb} MiB of memory.`
      : "this provisions the configured default resources.",
    image ? `image: ${image}` : "image: configured default",
    "this incurs cost.",
  ].join("\n");
}

function formatList(items: SandboxItem[]): string {
  if (items.length === 0) return "no managed sandboxes";
  return items
    .map(
      (item) =>
        `${item.name}\t${item.os}\t${item.online ? "online" : "offline"}`,
    )
    .join("\n");
}

function requireSandbox(result: BackendResult): {
  name: string;
  os: SandboxOS;
} {
  if (typeof result.name !== "string" || !isSandboxOS(result.os)) {
    throw new Error("cua backend returned an invalid sandbox reference");
  }
  return { name: result.name, os: result.os };
}

function parseWorkspaceState(value: unknown): WorkspaceState | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object")
    throw new Error("saved sandbox workspace state is unsupported");
  const state = value as Record<string, unknown>;
  if (
    state.version !== 1 ||
    typeof state.localRoot !== "string" ||
    typeof state.commit !== "string" ||
    typeof state.commitTree !== "string" ||
    typeof state.baselineTree !== "string"
  )
    throw new Error("saved sandbox workspace state is unsupported");
  return state as WorkspaceState;
}

function parseTarget(value: unknown): StoredExecutionTarget | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object")
    throw new Error("saved execution target is invalid");
  const data = value as Record<string, unknown>;
  if (data.kind === "local") return { kind: "local" };
  if (
    data.kind !== "sandbox" ||
    typeof data.name !== "string" ||
    !isSandboxOS(data.os) ||
    typeof data.localCwd !== "string" ||
    typeof data.remoteCwd !== "string"
  )
    throw new Error("saved execution target is invalid");
  const workspaceState = parseWorkspaceState(data.workspaceState);
  return {
    kind: "sandbox",
    name: data.name,
    os: data.os,
    executionId:
      typeof data.executionId === "string" && data.executionId
        ? data.executionId
        : undefined,
    sandboxGeneration:
      typeof data.sandboxGeneration === "string" && data.sandboxGeneration
        ? data.sandboxGeneration
        : undefined,
    localCwd: data.localCwd,
    remoteCwd: data.remoteCwd,
    workspaceState,
  };
}

function parseTargetIntent(value: unknown): ExecutionTargetIntent | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object")
    throw new Error("saved sandbox connection intent is invalid");
  const data = value as Record<string, unknown>;
  const id = typeof data.id === "string" && data.id ? data.id : "legacy";
  const destination = data.destination as Record<string, unknown> | undefined;
  if (!destination)
    throw new Error("saved sandbox connection intent is invalid");
  let parsedDestination: Destination;
  if (destination.kind === "local") {
    parsedDestination = { kind: "local" };
  } else if (
    destination.kind === "sandbox" &&
    typeof destination.name === "string" &&
    isSandboxOS(destination.os)
  ) {
    parsedDestination = {
      kind: "sandbox",
      name: destination.name,
      os: destination.os,
    };
  } else {
    throw new Error("saved sandbox connection intent is invalid");
  }
  const source = parseTarget(data.source);
  if (!source) throw new Error("saved sandbox connection intent is invalid");
  return { id, destination: parsedDestination, source };
}

export default function cuaSandbox(pi: ExtensionAPI): void {
  let target: ExecutionTarget = { kind: "local" };
  let placementError: Error | undefined;
  let bridge: ToolBridge | undefined;
  let reconnectPromise: Promise<ToolBridge> | undefined;
  let workspaceDiffGeneration = 0;
  let runtimeClosed = false;
  let routeCatalog:
    | Readonly<{
        tools: readonly string[];
        packages: readonly string[];
        files: readonly string[];
        definitions: readonly ToolWithSource[];
      }>
    | undefined;

  async function runBackend(
    request: Record<string, unknown>,
    signal?: AbortSignal,
    onStatus?: (status: BackendResult) => void,
  ): Promise<BackendResult> {
    if (signal?.aborted) throw new Error("operation cancelled");
    return new Promise((resolve, reject) => {
      const child = spawn("python3", [backend, JSON.stringify(request)], {
        detached: true,
        env: { ...process.env, CUA_PROGRESS_JSON: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const decoder = new StringDecoder("utf8");
      let stdout = "";
      let stderr = "";
      let result: BackendResult | undefined;
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
        }
      };
      const consume = () => {
        for (;;) {
          const newline = stdout.indexOf("\n");
          if (newline < 0) break;
          const line = stdout.slice(0, newline).replace(/\r$/, "");
          stdout = stdout.slice(newline + 1);
          if (!line) continue;
          try {
            const message = JSON.parse(line) as BackendResult;
            if (message.progress) onStatus?.(message);
            else result = message;
          } catch {
            stderr = `${stderr}\ninvalid backend output: ${line}`.slice(-8_000);
          }
        }
        if (stdout.length > 1024 * 1024) onAbort();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += decoder.write(chunk);
        consume();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-8_000);
      });
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", (code) => {
        stdout += decoder.end();
        if (stdout && !stdout.endsWith("\n")) stdout += "\n";
        consume();
        if (signal?.aborted) {
          finish(() => reject(new Error("operation cancelled")));
          return;
        }
        if (code === 0 && result?.ok) {
          finish(() => resolve(result!));
          return;
        }
        const context = result?.phase ? `[${result.phase}] ` : "";
        const detail = result?.error || stderr.trim() || "cua operation failed";
        finish(() =>
          reject(new BackendError(`${context}${detail}`, result?.error_type)),
        );
      });
    });
  }

  function loadSessionTarget(
    ctx: UIContext,
  ): StoredExecutionTarget | undefined {
    return parseTarget(
      latestCustomEntryData(
        ctx.sessionManager.getEntries(),
        executionTargetEntry,
      ),
    );
  }

  function loadConnectionIntent(
    ctx: UIContext,
  ): ExecutionTargetIntent | undefined {
    return parseTargetIntent(
      latestCustomEntryData(
        ctx.sessionManager.getEntries(),
        executionTargetIntentEntry,
      ),
    );
  }

  function loadHandoffTarget(
    previousSessionFile?: string,
  ): StoredExecutionTarget | undefined {
    if (!previousSessionFile) return undefined;
    const previous = SessionManager.open(previousSessionFile);
    return parseTarget(
      latestCustomEntryData(previous.getEntries(), executionTargetHandoffEntry),
    );
  }

  function storedTarget(
    next: ExecutionTarget | StoredExecutionTarget,
  ): StoredExecutionTarget {
    if (next.kind === "local") return next;
    return {
      kind: "sandbox",
      name: next.name,
      os: next.os,
      executionId: next.executionId,
      sandboxGeneration: next.sandboxGeneration,
      localCwd: next.localCwd,
      remoteCwd: next.remoteCwd,
      workspaceState: next.workspaceState,
    };
  }

  function saveTarget(next: ExecutionTarget | StoredExecutionTarget): void {
    pi.appendEntry(executionTargetEntry, storedTarget(next));
  }

  function saveConnectionIntent(
    destination: Destination,
  ): ExecutionTargetIntent {
    const intent = {
      id: crypto.randomUUID(),
      destination,
      source: storedTarget(target),
    };
    pi.appendEntry(executionTargetIntentEntry, intent);
    return intent;
  }

  function ownsConnectionIntent(
    ctx: UIContext,
    intent: ExecutionTargetIntent | undefined,
  ): intent is ExecutionTargetIntent {
    return Boolean(intent && loadConnectionIntent(ctx)?.id === intent.id);
  }

  function clearConnectionIntent(
    ctx: UIContext,
    intent: ExecutionTargetIntent | undefined,
  ): void {
    if (ownsConnectionIntent(ctx, intent))
      pi.appendEntry(executionTargetIntentEntry, null);
  }

  async function createSandbox(
    os: SandboxOS,
    ctx: UIContext,
    resources?: SandboxResources,
  ): Promise<Destination | undefined> {
    if (!ctx.hasUI) return undefined;
    const confirmed = await ctx.ui.confirm(
      `create ${os} sandbox?`,
      creationDescription(resources),
    );
    if (!confirmed) return undefined;
    pi.events.emit("cua:execution-target-changed", {
      kind: "progress",
      state: "creating",
      os,
    });
    try {
      const result = await runBackend(
        { action: "create", os, ...resources },
        ctx.signal,
        (status) => {
          if (runtimeClosed) return;
          pi.events.emit("cua:execution-target-changed", {
            kind: "progress",
            state: "creating",
            os,
            phase: status.phase,
            message: status.message,
          });
        },
      );
      if (runtimeClosed)
        throw new Error(
          "extension runtime was replaced during sandbox creation",
        );
      const sandbox = requireSandbox(result);
      pi.events.emit("cua:sandboxes-changed", result);
      pi.events.emit("cua:execution-target-changed", {
        kind: "sandbox",
        ...sandbox,
        state: "connecting",
      });
      return { kind: "sandbox", ...sandbox };
    } catch (error) {
      if (!runtimeClosed)
        pi.events.emit("cua:execution-target-changed", target);
      throw error;
    }
  }

  type DestinationSearchOption = {
    value: string;
    label: string;
    description?: string;
    create?: boolean;
  };

  async function searchDestinationOptions(
    ctx: UIContext,
    options: DestinationSearchOption[],
  ): Promise<string | undefined> {
    const input =
      ctx.mode === "tui"
        ? await ctx.ui.custom<string | null>(
            (tui, theme, _keybindings, done) => {
              const createLabels = options
                .filter((option) => option.create)
                .map((option) => option.label);
              const selectedRow = (
                text: string,
                colour: "accent" | "mdHeading",
              ) => {
                const columns = text.match(/^(.*\S)(\s{2,})(\S.*)$/);
                if (!columns) return theme.fg(colour, text);
                return (
                  theme.fg(colour, columns[1]!) +
                  theme.fg("muted", columns[2]! + columns[3]!)
                );
              };
              const listTheme = {
                selectedPrefix: (text: string) => theme.fg("accent", text),
                selectedText: (text: string) =>
                  selectedRow(
                    text,
                    createLabels.some((label) => text.includes(label))
                      ? "mdHeading"
                      : "accent",
                  ),
                description: (text: string) => theme.fg("muted", text),
                scrollInfo: (text: string) => theme.fg("muted", text),
                noMatch: (text: string) => theme.fg("muted", text),
              };
              const editor = new Editor(tui, {
                borderColor: (text) => theme.fg("borderMuted", text),
                selectList: listTheme,
              });
              editor.disableSubmit = true;
              let list: SelectList;
              const rebuildList = (query: string) => {
                const normalized = query.trim().toLowerCase();
                const filtered = options.filter((option) =>
                  `${option.label} ${option.description ?? ""}`
                    .toLowerCase()
                    .includes(normalized),
                );
                const primaryWidth =
                  Math.max(
                    1,
                    ...filtered.map((option) => visibleWidth(option.label)),
                  ) + 4;
                list = new SelectList(
                  filtered.map((option) => ({
                    value: option.value,
                    label: option.label,
                    description: option.description,
                  })),
                  Math.max(1, Math.min(filtered.length, 5)),
                  listTheme,
                  {
                    minPrimaryColumnWidth: primaryWidth,
                    maxPrimaryColumnWidth: primaryWidth,
                  },
                );
                list.onSelect = (item) => done(item.value);
              };
              rebuildList("");
              editor.onChange = rebuildList;
              return {
                get focused() {
                  return editor.focused;
                },
                set focused(value: boolean) {
                  editor.focused = value;
                },
                invalidate() {
                  editor.invalidate();
                  list.invalidate();
                },
                render: (width: number) => [
                  ...editor.render(width),
                  ...list.render(width),
                ],
                handleInput(data: string) {
                  if (matchesKey(data, Key.escape)) return done(null);
                  if (
                    matchesKey(data, Key.up) ||
                    matchesKey(data, Key.down) ||
                    matchesKey(data, Key.enter)
                  ) {
                    list.handleInput(data);
                  } else {
                    editor.handleInput(data);
                  }
                  tui.requestRender();
                },
              };
            },
          )
        : await ctx.ui.input(
            "Session execution",
            options.map((option) => option.label).join(" • "),
          );
    if (input === undefined || input === null) return undefined;
    return input.trim().toLowerCase();
  }

  async function pickDestination(
    ctx: UIContext,
    active?: ExecutionTarget,
  ): Promise<Destination | undefined> {
    if (!ctx.hasUI) return undefined;
    const listed = await runBackend({ action: "list" }, ctx.signal);
    const available = (listed.sandboxes ?? []).filter(
      (sandbox) => sandbox.online,
    );
    const actions: DestinationSearchOption[] = [
      ...(active?.kind === "sandbox"
        ? [
            {
              value: "local",
              label: active.workspaceState
                ? "sync back to local directory"
                : "return to local execution",
            },
          ]
        : []),
      ...(available.length > 0
        ? [
            {
              value: "connect",
              label: `${active?.kind === "sandbox" ? "connect or reconnect to" : "connect to"} a sandbox (${available.length} available)`,
            },
          ]
        : []),
      {
        value: "create",
        label: "create a new sandbox",
        create: true,
      },
    ];
    while (true) {
      const action = await searchDestinationOptions(ctx, actions);
      if (!action) return undefined;
      if (action === "local") return { kind: "local" };

      if (action === "create") {
        const os = await searchDestinationOptions(ctx, [
          {
            value: "linux",
            label: "linux",
            description: "create a persistent Linux sandbox",
            create: true,
          },
          {
            value: "windows",
            label: "windows",
            description: "create a persistent Windows sandbox",
            create: true,
          },
        ]);
        if (!os) continue;
        if (os !== "linux" && os !== "windows")
          throw new Error(`unknown sandbox operating system: ${os}`);
        return createSandbox(os, ctx);
      }
      if (action !== "connect")
        throw new Error(`unknown sandbox action: ${action}`);

      const name = await searchDestinationOptions(
        ctx,
        available.map((sandbox) => ({
          value: sandbox.name,
          label: sandbox.name,
          description: `${sandbox.os} • ${active?.kind === "sandbox" && sandbox.name === active.name ? "current; reconnect" : sandbox.discovered ? "tagged Tailscale host" : sandbox.kind === "external" ? "registered external host" : "reachable over Tailscale"}`,
        })),
      );
      if (!name) continue;
      const item = available.find((sandbox) => sandbox.name === name);
      if (!item) throw new Error(`unknown or offline sandbox: ${name}`);
      return { kind: "sandbox", name: item.name, os: item.os };
    }
  }

  async function destinationFromArgument(
    args: string,
    ctx: UIContext,
  ): Promise<Destination | undefined> {
    const value = args.trim().toLowerCase();
    if (!value) return pickDestination(ctx, target);
    if (value === "local") return { kind: "local" };
    const createMatch = value.match(
      /^(?:new\s+)?(linux|windows)(?:\s+([1-9]\d*)\s+([1-9]\d*))?$/,
    );
    if (createMatch) {
      if (!createMatch[2])
        return createSandbox(createMatch[1] as SandboxOS, ctx);
      const resources = {
        cpu: Number(createMatch[2]),
        memory_mb: Number(createMatch[3]),
      };
      if (
        !Number.isSafeInteger(resources.cpu) ||
        !Number.isSafeInteger(resources.memory_mb)
      )
        throw new Error("cpu and memory_mb are too large");
      return createSandbox(createMatch[1] as SandboxOS, ctx, resources);
    }
    if (/^(?:new\s+)?(?:linux|windows)(?:\s|$)/.test(value))
      throw new Error("usage: /sandbox <linux|windows> [cpu memory_mb]");
    const listed = await runBackend({ action: "list" }, ctx.signal);
    const item = (listed.sandboxes ?? []).find(
      (candidate) => candidate.name === value,
    );
    if (!item) throw new Error(`unknown managed sandbox: ${value}`);
    return { kind: "sandbox", name: item.name, os: item.os };
  }

  function executionRoutes(): Readonly<{
    tools: readonly string[];
    packages: readonly string[];
    files: readonly string[];
    definitions: readonly ToolWithSource[];
  }> {
    if (routeCatalog) return routeCatalog;
    const definitions = pi
      .getAllTools()
      .filter((tool) => !localTools.has(tool.name));
    const packages = new Set<string>();
    const files = new Set<string>();
    for (const tool of definitions) {
      if (
        tool.sourceInfo.origin === "package" &&
        tool.sourceInfo.scope === "user" &&
        ["git:", "npm:", "https://", "http://", "ssh://"].some((prefix) =>
          tool.sourceInfo.source.startsWith(prefix),
        ) &&
        !tool.sourceInfo.source.toLowerCase().includes("pi-cua")
      ) {
        packages.add(immutablePackageSource(tool));
      }
      if (
        tool.sourceInfo.origin === "top-level" &&
        tool.sourceInfo.scope === "user"
      )
        files.add(tool.sourceInfo.path);
    }
    routeCatalog = Object.freeze({
      tools: Object.freeze(definitions.map((tool) => tool.name)),
      packages: Object.freeze([...packages]),
      files: Object.freeze([...files]),
      definitions: Object.freeze(definitions),
    });
    return routeCatalog;
  }

  function reportTargetProgress(
    active: { kind: "sandbox"; name: string; os: SandboxOS },
    ctx: UIContext,
    phase?: string,
    message?: string,
  ): void {
    if (runtimeClosed) return;
    ctx.ui.setStatus(
      "cua-session",
      formatSandboxProgress(active.name, phase, message),
    );
    pi.events.emit("cua:execution-target-changed", {
      ...active,
      state: "connecting",
      phase,
      message,
    });
  }

  async function materializeTarget(
    destination: Extract<Destination, { kind: "sandbox" }>,
    ctx: UIContext,
    options: {
      inheritExecution?: boolean;
      resume?: Extract<StoredExecutionTarget, { kind: "sandbox" }>;
      forceReconcile?: boolean;
    } = {},
  ): Promise<Extract<ExecutionTarget, { kind: "sandbox" }>> {
    const { inheritExecution = true, resume, forceReconcile = false } = options;
    const routes = executionRoutes();
    const executionId =
      resume?.executionId ??
      (inheritExecution && target.kind === "sandbox"
        ? target.executionId
        : undefined) ??
      ctx.sessionManager.getSessionId();
    reportTargetProgress(destination, ctx);
    const request = {
      action: "activate_execution",
      name: destination.name,
      source_cwd: resume?.localCwd ?? ctx.cwd,
      execution_id: executionId,
      tool_packages: routes.packages,
      tool_files: routes.files,
      force_reconcile: !resume || forceReconcile,
      sandbox_generation: resume?.sandboxGeneration,
      source:
        !resume && inheritExecution && target.kind === "sandbox"
          ? workspaceSource(target)
          : undefined,
      resume: resume
        ? {
            os: resume.os,
            remoteCwd: resume.remoteCwd,
            ...(resume.workspaceState ? { state: resume.workspaceState } : {}),
          }
        : undefined,
    };
    const onStatus = (status: BackendResult) =>
      reportTargetProgress(destination, ctx, status.phase, status.message);
    try {
      let result: BackendResult;
      try {
        result = await runBackend(request, ctx.signal, onStatus);
      } catch (error) {
        if (
          !(error instanceof BackendError) ||
          error.errorType !== "SandboxRepairRequired"
        )
          throw error;
        await runBackend(
          { action: "ensure", name: destination.name },
          ctx.signal,
          onStatus,
        );
        result = await runBackend(request, ctx.signal, onStatus);
      }
      if (
        typeof result.remote_cwd !== "string" ||
        typeof result.address !== "string" ||
        typeof result.runtime_digest !== "string" ||
        typeof result.reconciled !== "boolean" ||
        (result.sandbox_generation !== undefined &&
          typeof result.sandbox_generation !== "string")
      ) {
        throw new Error("cua backend returned an invalid execution target");
      }
      if (runtimeClosed)
        throw new Error(
          "extension runtime was replaced during sandbox connection",
        );
      pi.events.emit("cua:sandboxes-changed", result);
      return {
        ...destination,
        address: result.address,
        executionId,
        sandboxGeneration: result.sandbox_generation,
        localCwd: resume?.localCwd ?? ctx.cwd,
        remoteCwd: result.remote_cwd,
        workspaceState: parseWorkspaceState(result.workspace_state),
        runtimeDigest: result.runtime_digest,
        reconciled: result.reconciled,
      };
    } catch (error) {
      if (!runtimeClosed) {
        ctx.ui.setStatus("cua-session", undefined);
        pi.events.emit("cua:execution-target-changed", target);
      }
      throw error;
    }
  }

  async function resumeTarget(
    saved: StoredExecutionTarget,
    ctx: UIContext,
  ): Promise<ExecutionTarget> {
    if (saved.kind === "local") return saved;
    return materializeTarget(
      { kind: "sandbox", name: saved.name, os: saved.os },
      ctx,
      { inheritExecution: false, resume: saved },
    );
  }

  function executionSource(
    active: Extract<ExecutionTarget, { kind: "sandbox" }>,
  ): Record<string, unknown> {
    return {
      address: active.address,
      os: active.os,
      remoteCwd: active.remoteCwd,
      ...(active.workspaceState ? { state: active.workspaceState } : {}),
    };
  }

  function workspaceSource(
    active: Extract<ExecutionTarget, { kind: "sandbox" }>,
  ): Record<string, unknown> | undefined {
    return active.workspaceState ? executionSource(active) : undefined;
  }

  async function cleanupTarget(
    active: Extract<ExecutionTarget, { kind: "sandbox" }>,
    ctx: UIContext,
    signal?: AbortSignal,
  ): Promise<void> {
    const source = workspaceSource(active);
    if (!source) return;
    try {
      await runBackend({ action: "cleanup_workspace", source }, signal);
    } catch (error) {
      ctx.ui.notify(
        `workspace cleanup failed on ${active.name}: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  }

  async function syncTargetToLocal(
    active: Extract<ExecutionTarget, { kind: "sandbox" }>,
    signal?: AbortSignal,
    onStatus?: (status: BackendResult) => void,
  ): Promise<void> {
    const source = workspaceSource(active);
    if (!source) return;
    await runBackend(
      {
        action: "sync_workspace_to_local",
        source,
        local_cwd: active.localCwd,
      },
      signal,
      onStatus,
    );
  }

  async function refreshWorkspaceDiff(): Promise<void> {
    if (runtimeClosed) return;
    const generation = ++workspaceDiffGeneration;
    const active = target;
    if (active.kind === "local") {
      pi.events.emit("cua:workspace-diff-changed", { kind: "local" });
      return;
    }
    const source = workspaceSource(active);
    if (!source) {
      pi.events.emit("cua:workspace-diff-changed", {
        kind: "sandbox",
        name: active.name,
        additions: 0,
        deletions: 0,
        pendingSync: false,
      });
      return;
    }
    try {
      const result = await runBackend(
        {
          action: "workspace_diff_status",
          source,
          local_cwd: active.localCwd,
        },
        new AbortController().signal,
      );
      if (
        runtimeClosed ||
        generation !== workspaceDiffGeneration ||
        target.kind !== "sandbox" ||
        target.name !== active.name ||
        target.address !== active.address ||
        typeof result.additions !== "number" ||
        typeof result.deletions !== "number" ||
        typeof result.pending_sync !== "boolean"
      )
        return;
      pi.events.emit("cua:workspace-diff-changed", {
        kind: "sandbox",
        name: active.name,
        additions: result.additions,
        deletions: result.deletions,
        pendingSync: result.pending_sync,
      });
    } catch {
      // A status refresh must not interrupt the active Pi session.
    }
  }

  function installProxies(nextBridge: ToolBridge): void {
    const active = pi.getActiveTools();
    const definitions = executionRoutes().definitions.map((info) => {
      const remote = nextBridge.definition(info.name);
      if (!remote)
        throw new Error(`remote tool metadata missing: ${info.name}`);
      return { info, remote };
    });
    for (const { info, remote } of definitions) {
      pi.registerTool({
        ...remote,
        async execute(id, input, signal, onUpdate, toolCtx) {
          if (shouldUseControllerTool(info.name, input)) {
            return createReadTool(toolCtx.cwd).execute(
              id,
              input,
              signal,
              onUpdate,
            );
          }
          const activeBridge = await connectedBridge(toolCtx);
          return activeBridge.execute(info.name, id, input, signal, onUpdate);
        },
      });
    }
    pi.setActiveTools(active);
  }

  async function activate(
    next: ExecutionTarget,
    ctx: UIContext,
    options: { persist?: boolean } = {},
  ): Promise<void> {
    if (runtimeClosed)
      throw new Error(
        "extension runtime was replaced during sandbox connection",
      );
    if (next === target && bridge) {
      if (options.persist !== false) saveTarget(next);
      return;
    }
    const expectedTools = [...executionRoutes().tools];
    let resolved = next;
    let nextBridge =
      resolved.kind === "sandbox"
        ? new ToolBridge(resolved, expectedTools)
        : undefined;
    if (resolved.kind === "sandbox") {
      ctx.ui.setStatus(
        "cua-session",
        formatSandboxProgress(
          resolved.name,
          "connect.tools",
          "starting remote tools",
        ),
      );
      pi.events.emit("cua:execution-target-changed", {
        ...resolved,
        state: "connecting",
        phase: "connect.tools",
        message: "starting remote tools",
      });
    }
    try {
      try {
        await nextBridge?.connect();
      } catch (error) {
        if (resolved.kind !== "sandbox" || resolved.reconciled) throw error;
        nextBridge?.close(true);
        resolved = await materializeTarget(
          { kind: "sandbox", name: resolved.name, os: resolved.os },
          ctx,
          {
            inheritExecution: false,
            resume: resolved,
            forceReconcile: true,
          },
        );
        nextBridge = new ToolBridge(resolved, expectedTools);
        await nextBridge.connect();
      }
      if (runtimeClosed)
        throw new Error(
          "extension runtime was replaced during sandbox connection",
        );
      if (resolved.kind === "sandbox" && nextBridge) installProxies(nextBridge);
      if (options.persist !== false) saveTarget(resolved);
    } catch (error) {
      nextBridge?.close(true);
      if (!runtimeClosed) {
        ctx.ui.setStatus("cua-session", undefined);
        pi.events.emit("cua:execution-target-changed", target);
      }
      throw error;
    }
    bridge?.close(true);
    target = resolved;
    placementError = undefined;
    bridge = nextBridge;
    ctx.ui.setStatus("cua-session", undefined);
    pi.events.emit("cua:execution-target-changed", resolved);
    void refreshWorkspaceDiff();
  }

  async function connectedBridge(ctx: UIContext): Promise<ToolBridge> {
    if (target.kind !== "sandbox")
      throw new Error("this session has no active sandbox");
    if (bridge?.connected) return bridge;
    if (reconnectPromise) return reconnectPromise;
    const active = target;
    reconnectPromise = (async () => {
      const renewed = await materializeTarget(
        { kind: "sandbox", name: active.name, os: active.os },
        ctx,
        { inheritExecution: false, resume: active },
      );
      if (
        target.kind !== "sandbox" ||
        target.name !== active.name ||
        target.executionId !== active.executionId
      ) {
        throw new Error("sandbox target changed while reconnecting");
      }
      await activate(renewed, ctx);
      if (!bridge?.connected)
        throw new Error(`remote tool host on ${renewed.name} did not connect`);
      return bridge;
    })().finally(() => {
      reconnectPromise = undefined;
    });
    return reconnectPromise;
  }

  pi.registerTool({
    name: "cua_sandbox",
    label: "CUA Sandbox",
    description:
      "List tagged Tailscale hosts or provision, repair, and delete Fleet sandboxes.",
    promptSnippet: "Manage Linux, Windows, and tagged macOS execution targets",
    promptGuidelines: [
      "Use cua_sandbox for sandbox resources; use /sandbox to choose where the current session executes tools.",
      "For custom resources, cua_sandbox create requires both cpu and memory_mb; omit both to use the OS defaults.",
      "Use a custom image only when the user explicitly provides a digest-pinned OCI reference.",
      "Tagged macOS peers are discovered from Tailscale and never acquire Fleet deletion semantics.",
      "Do not delete a CUA sandbox unless the user explicitly asks.",
    ],
    parameters: resourceSchema,
    async execute(_id, input: ResourceInput, signal, onUpdate, ctx) {
      if (
        input.action === "create" &&
        input.os !== "linux" &&
        input.os !== "windows"
      )
        throw new Error("create requires os=linux or os=windows");
      const hasResources =
        input.cpu !== undefined || input.memory_mb !== undefined;
      if (
        input.action === "create" &&
        hasResources &&
        (input.cpu === undefined || input.memory_mb === undefined)
      )
        throw new Error("cpu and memory_mb must be supplied together");
      if (input.action !== "create" && hasResources)
        throw new Error("cpu and memory_mb are only valid for create");
      if (input.image !== undefined && input.action !== "create")
        throw new Error("image is only valid for create");
      if (["ensure", "delete"].includes(input.action) && !input.name) {
        throw new Error(`${input.action} requires name`);
      }
      if (
        input.action === "delete" &&
        target.kind === "sandbox" &&
        input.name === target.name
      )
        throw new Error(
          `move this session to local execution before deleting ${target.name}`,
        );
      if (input.action === "create" || input.action === "delete") {
        const createResources =
          input.cpu !== undefined && input.memory_mb !== undefined
            ? { cpu: input.cpu, memory_mb: input.memory_mb }
            : undefined;
        const allowed = ctx.hasUI
          ? await ctx.ui.confirm(
              input.action === "create"
                ? `create ${input.name || input.os} sandbox?`
                : `delete ${input.name}?`,
              input.action === "create"
                ? creationDescription(createResources, input.image)
                : "this permanently releases its fleet claim and filesystem.",
            )
          : input.confirm === true;
        if (!allowed)
          throw new Error(
            ctx.hasUI ? "cancelled by user" : "confirm=true required",
          );
      }
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `${input.action} ${input.name || input.os || "sandboxes"}...`,
          },
        ],
        details: { action: input.action },
      });
      const result = await runBackend(input, signal);
      if (input.action !== "list")
        pi.events.emit("cua:sandboxes-changed", result);
      const text =
        input.action === "list"
          ? formatList(result.sandboxes ?? [])
          : input.action === "delete"
            ? `deleted ${result.name}`
            : `${result.name} (${result.os}) ${result.changed ? "configured" : "ready"}${result.address ? ` at ${result.address}` : ""}`;
      return { content: [{ type: "text", text }], details: result };
    },
  });

  pi.registerCommand("sandbox", {
    description: "Choose where this local Pi session executes tools",
    handler: async (args, ctx) => {
      let intent: ExecutionTargetIntent | undefined;
      try {
        await ctx.waitForIdle();
        const destination = await destinationFromArgument(args, ctx);
        if (!destination) return;
        intent = saveConnectionIntent(destination);
        if (destination.kind === "local") {
          const source = target.kind === "sandbox" ? target : undefined;
          if (source?.workspaceState) {
            pi.events.emit("cua:execution-target-changed", {
              ...source,
              state: "connecting",
              phase: "workspace.local.sync",
              message: "syncing sandbox changes to local",
            });
            await syncTargetToLocal(source, ctx.signal, (status) => {
              pi.events.emit("cua:execution-target-changed", {
                ...source,
                state: "connecting",
                phase: status.phase,
                message: status.message,
              });
            });
          }
          const local: ExecutionTarget = { kind: "local" };
          if (!ownsConnectionIntent(ctx, intent)) return;
          await activate(local, ctx);
          if (source) await cleanupTarget(source, ctx, ctx.signal);
          clearConnectionIntent(ctx, intent);
          await ctx.reload();
          return;
        }
        const source = target.kind === "sandbox" ? target : undefined;
        const reconnecting = source?.name === destination.name;
        const prepared = await materializeTarget(
          destination,
          ctx,
          reconnecting
            ? { inheritExecution: false, resume: source }
            : undefined,
        );
        if (!ownsConnectionIntent(ctx, intent)) return;
        await activate(prepared, ctx);
        clearConnectionIntent(ctx, intent);
        if (source && !reconnecting)
          await cleanupTarget(source, ctx, ctx.signal);
      } catch (error) {
        if (runtimeClosed) return;
        clearConnectionIntent(ctx, intent);
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });

  let pendingSessionStart:
    | {
        reason: "startup" | "reload" | "new" | "resume" | "fork";
        previousSessionFile?: string;
      }
    | undefined;

  pi.on("session_start", (event) => {
    pendingSessionStart = event;
  });

  pi.on("resources_discover", async (_event, ctx) => {
    const event = pendingSessionStart;
    pendingSessionStart = undefined;
    if (!event) return;
    let intendedTarget:
      StoredExecutionTarget | ExecutionTarget | Destination | undefined;
    let intent: ExecutionTargetIntent | undefined;
    try {
      intent = loadConnectionIntent(ctx);
      if (intent) {
        intendedTarget = intent.destination;
        let source: Extract<ExecutionTarget, { kind: "sandbox" }> | undefined;
        if (intent.source.kind === "sandbox") {
          const resumed = await resumeTarget(intent.source, ctx);
          if (resumed.kind !== "sandbox")
            throw new Error("sandbox connection intent lost its source target");
          source = resumed;
          await activate(source, ctx, { persist: false });
        } else {
          await activate({ kind: "local" }, ctx, { persist: false });
        }
        if (intent.destination.kind === "local") {
          if (source?.workspaceState) {
            const activeSource = source;
            await syncTargetToLocal(activeSource, undefined, (status) =>
              reportTargetProgress(
                activeSource,
                ctx,
                status.phase,
                status.message,
              ),
            );
          }
          if (!ownsConnectionIntent(ctx, intent)) return;
          await activate({ kind: "local" }, ctx);
          if (source) await cleanupTarget(source, ctx);
          clearConnectionIntent(ctx, intent);
          return;
        }
        if (source?.name === intent.destination.name) {
          clearConnectionIntent(ctx, intent);
          return;
        }
        const prepared = await materializeTarget(intent.destination, ctx);
        intendedTarget = prepared;
        if (!ownsConnectionIntent(ctx, intent)) return;
        await activate(prepared, ctx);
        clearConnectionIntent(ctx, intent);
        return;
      }
      const current = loadSessionTarget(ctx);
      if (current) {
        intendedTarget = current;
        const resumed = await resumeTarget(current, ctx);
        intendedTarget = resumed;
        if (resumed !== current) saveTarget(resumed);
        await activate(resumed, ctx, { persist: false });
        return;
      }
      const inherited = shouldHandoffExecutionTarget(event.reason)
        ? loadHandoffTarget(event.previousSessionFile)
        : undefined;
      if (inherited) {
        const prepared = await resumeTarget(inherited, ctx);
        intendedTarget = prepared;
        saveTarget(prepared);
        await activate(prepared, ctx, { persist: false });
        return;
      }
      await activate({ kind: "local" }, ctx);
    } catch (error) {
      if (runtimeClosed) return;
      clearConnectionIntent(ctx, intent);
      placementError =
        error instanceof Error ? error : new Error(String(error));
      if (intendedTarget?.kind === "sandbox") {
        ctx.ui.setStatus(
          "cua-session",
          `${intendedTarget.name} (failed to connect)`,
        );
        pi.events.emit("cua:execution-target-changed", {
          ...intendedTarget,
          state: "failed",
          phase: "connect.failed",
          message: "failed to connect",
          error: placementError.message,
        });
      }
      ctx.ui.notify(
        `execution placement blocked: ${placementError.message}; choose a target with /sandbox`,
        "error",
      );
    }
  });

  pi.on("agent_settled", () => {
    void refreshWorkspaceDiff();
  });

  pi.on("tool_call", (event) => {
    if (
      target.kind === "sandbox" &&
      !localTools.has(event.toolName) &&
      !executionRoutes().tools.includes(event.toolName)
    )
      return {
        block: true,
        reason: `${event.toolName} was registered after sandbox activation; run /reload to rebuild the sandbox tool set`,
      };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (placementError) throw placementError;
    if (target.kind !== "sandbox" || !bridge) return;
    const localCwd = `Current working directory: ${target.localCwd}`;
    const logicalCwd = target.workspaceState
      ? "workspace root"
      : "execution root";
    const environment = `Execution environment: ${target.os}. All tools and user shell commands run in ${target.os}; use paths relative to the current directory and answer environment questions for ${target.os}.`;
    return {
      systemPrompt: `${event.systemPrompt.replace(localCwd, `Current working directory: ${logicalCwd}`)}\n\n${environment}`,
    };
  });

  pi.on("user_bash", (_event, ctx) => {
    if (placementError) throw placementError;
    if (target.kind !== "sandbox" || !bridge) return;
    const operations: BashOperations = {
      exec: async (command, _cwd, options) =>
        (await connectedBridge(ctx)).bash(
          `bash-${crypto.randomUUID()}`,
          command,
          {
            onData: options.onData,
            signal: options.signal,
            timeout: options.timeout,
          },
        ),
    };
    return { operations };
  });

  pi.on("session_shutdown", async (event, ctx) => {
    runtimeClosed = true;
    workspaceDiffGeneration += 1;
    const source = target.kind === "sandbox" ? target : undefined;
    let disposeBridge = false;
    try {
      if (source && shouldHandoffExecutionTarget(event.reason)) {
        pi.appendEntry(executionTargetHandoffEntry, storedTarget(source));
        const local: ExecutionTarget = { kind: "local" };
        saveTarget(local);
        target = local;
      } else if (source && event.reason !== "reload") {
        if (source.workspaceState) {
          reportTargetProgress(
            source,
            ctx,
            "workspace.local.sync",
            "syncing workspace before exit",
          );
        }
        await syncTargetToLocal(source, undefined, (status) =>
          reportTargetProgress(source, ctx, status.phase, status.message),
        );
        const local: ExecutionTarget = { kind: "local" };
        saveTarget(local);
        target = local;
        if (source.workspaceState) {
          reportTargetProgress(
            source,
            ctx,
            "workspace.local.cleanup",
            "removing synced sandbox workspace",
          );
        }
        await cleanupTarget(source, ctx);
        disposeBridge = true;
      }
    } catch (error) {
      ctx.ui.notify(
        `sandbox shutdown retained ${source?.name ?? "workspace"}: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    } finally {
      bridge?.close(disposeBridge);
      bridge = undefined;
    }
  });
}
