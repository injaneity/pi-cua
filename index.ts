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
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const backend = join(extensionDir, "backend.py");
const windowsIdentity = join(homedir(), ".ssh", "cua_windows_ed25519");
const sandboxKnownHosts = join(homedir(), ".ssh", "cua_known_hosts");
const protocolVersion = 2;
const maxProtocolLine = 1024 * 1024;
const windowsBrokerTask = "CuaPiDesktopToolBroker";
const executionTargetEntry = "cua-execution-target";
const executionTargetHandoffEntry = "cua-execution-target-handoff";
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
type SandboxOS = "linux" | "windows";
type SandboxResources = { cpu: number; memory_mb: number };
type SandboxItem = {
  name: string;
  os: SandboxOS;
  pool: string;
  address?: string;
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
type ExecutionTarget =
  | { kind: "local" }
  | {
      kind: "sandbox";
      name: string;
      os: SandboxOS;
      address: string;
      executionId?: string;
      localCwd: string;
      remoteCwd: string;
      workspaceState?: WorkspaceState;
      runtimeDigest?: string;
    };
type UIContext = ExtensionContext | ExtensionCommandContext;

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
    ...(target.os === "windows" ? ["-i", windowsIdentity] : []),
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${sandboxKnownHosts}`,
    "-o",
    "ConnectTimeout=10",
    "-o",
    "LogLevel=ERROR",
    "-T",
    ...(target.os === "windows" ? ["-W", "127.0.0.1:43121"] : []),
    `cua@${target.address}`,
  ];
}

function encodedToolManifest(
  expectedTools: string[],
  runtimeDigest?: string,
): string {
  return Buffer.from(
    JSON.stringify({
      tools: expectedTools,
      runtimeDigest: runtimeDigest ?? null,
    }),
  ).toString("base64");
}

function hostCommand(
  target: Extract<ExecutionTarget, { kind: "sandbox" }>,
  manifest: string,
): string {
  return `cd ${shellQuote(target.remoteCwd)} && exec node /home/cua/.pi/agent/cua-tool-host.mjs ${shellQuote(target.remoteCwd)} ${shellQuote(manifest)}`;
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

  private async start(): Promise<void> {
    if (this.ready) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.stderr = "";
      const manifest = encodedToolManifest(
        this.expectedTools,
        this.target.runtimeDigest,
      );
      const child = spawn(
        "ssh",
        [
          ...sshArgs(this.target),
          ...(this.target.os === "linux"
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
                  `remote ${message.owner ?? "runtime"} ${message.code ?? "open_failed"}: ${message.error ?? "tool host failed"}`,
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
    }).finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  connect(): Promise<void> {
    return this.start();
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
    await this.start();
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
    const child = this.child;
    if (!child) return;
    if (child.stdin.writable) {
      this.send({ type: dispose ? "shutdown" : "detach" });
      child.stdin.end();
    }
    const killTimer = setTimeout(() => child.kill(), 1_000);
    killTimer.unref();
    this.child = undefined;
    this.ready = false;
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
  if (
    typeof result.name !== "string" ||
    (result.os !== "linux" && result.os !== "windows")
  ) {
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

function parseTarget(value: unknown): ExecutionTarget | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object")
    throw new Error("saved execution target is invalid");
  const data = value as Record<string, unknown>;
  if (data.kind === "local") return { kind: "local" };
  if (
    data.kind !== "sandbox" ||
    typeof data.name !== "string" ||
    (data.os !== "linux" && data.os !== "windows") ||
    typeof data.address !== "string" ||
    typeof data.localCwd !== "string" ||
    typeof data.remoteCwd !== "string"
  )
    throw new Error("saved execution target is invalid");
  const workspaceState = parseWorkspaceState(data.workspaceState);
  return {
    kind: "sandbox",
    name: data.name,
    os: data.os,
    address: data.address,
    executionId:
      typeof data.executionId === "string" && data.executionId
        ? data.executionId
        : undefined,
    localCwd: data.localCwd,
    remoteCwd: data.remoteCwd,
    workspaceState,
    runtimeDigest:
      typeof data.runtimeDigest === "string" ? data.runtimeDigest : undefined,
  };
}

export default function cuaSandbox(pi: ExtensionAPI): void {
  let target: ExecutionTarget = { kind: "local" };
  let placementError: Error | undefined;
  let bridge: ToolBridge | undefined;
  let workspaceDiffGeneration = 0;
  const proxiedTools = new Set<string>();
  const toolPackages = new Set<string>();

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

  function loadSessionTarget(ctx: UIContext): ExecutionTarget | undefined {
    return parseTarget(
      latestCustomEntryData(
        ctx.sessionManager.getEntries(),
        executionTargetEntry,
      ),
    );
  }

  function loadHandoffTarget(
    previousSessionFile?: string,
  ): ExecutionTarget | undefined {
    if (!previousSessionFile) return undefined;
    const previous = SessionManager.open(previousSessionFile);
    return parseTarget(
      latestCustomEntryData(previous.getEntries(), executionTargetHandoffEntry),
    );
  }

  function saveTarget(next: ExecutionTarget): void {
    pi.appendEntry(executionTargetEntry, next);
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
          pi.events.emit("cua:execution-target-changed", {
            kind: "progress",
            state: "creating",
            os,
            phase: status.phase,
            message: status.message,
          });
        },
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
    const online = (listed.sandboxes ?? []).filter(
      (sandbox) =>
        sandbox.online &&
        !(active?.kind === "sandbox" && sandbox.name === active.name),
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
      ...(online.length > 0
        ? [
            {
              value: "connect",
              label: `connect to ${active?.kind === "sandbox" ? "another" : "an existing"} sandbox (${online.length} available)`,
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
        online.map((sandbox) => ({
          value: sandbox.name,
          label: sandbox.name,
          description: `${sandbox.os} • reachable over Tailscale`,
        })),
      );
      if (!name) continue;
      const item = online.find((sandbox) => sandbox.name === name);
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

  function captureToolProviders(): string[] {
    const names: string[] = [];
    for (const tool of pi.getAllTools()) {
      if (localTools.has(tool.name)) continue;
      names.push(tool.name);
      if (
        tool.sourceInfo.origin === "package" &&
        tool.sourceInfo.scope === "user" &&
        ["git:", "npm:", "https://", "http://", "ssh://"].some((prefix) =>
          tool.sourceInfo.source.startsWith(prefix),
        ) &&
        !tool.sourceInfo.source.toLowerCase().includes("pi-cua")
      ) {
        toolPackages.add(tool.sourceInfo.source);
      }
    }
    return names;
  }

  function reportTargetProgress(
    active: { kind: "sandbox"; name: string; os: SandboxOS },
    ctx: UIContext,
    phase?: string,
    message?: string,
  ): void {
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

  async function prepareTarget(
    destination: Extract<Destination, { kind: "sandbox" }>,
    ctx: UIContext,
    options: {
      inheritExecution?: boolean;
      resume?: Extract<ExecutionTarget, { kind: "sandbox" }>;
      refresh?: Extract<ExecutionTarget, { kind: "sandbox" }>;
    } = {},
  ): Promise<Extract<ExecutionTarget, { kind: "sandbox" }>> {
    const { inheritExecution = true, resume, refresh } = options;
    if (
      inheritExecution &&
      bridge &&
      target.kind === "sandbox" &&
      target.name === destination.name
    ) {
      return target;
    }
    captureToolProviders();
    const executionId =
      refresh?.executionId ??
      resume?.executionId ??
      (inheritExecution && target.kind === "sandbox"
        ? target.executionId
        : undefined) ??
      ctx.sessionManager.getSessionId();
    reportTargetProgress(destination, ctx);
    const request = {
      action: refresh ? "refresh_execution" : "prepare_execution",
      name: destination.name,
      source_cwd: resume?.localCwd ?? ctx.cwd,
      execution_id: executionId,
      tool_packages: [...toolPackages],
      source: refresh
        ? executionSource(refresh)
        : !resume && inheritExecution && target.kind === "sandbox"
          ? workspaceSource(target)
          : undefined,
      resume: resume ? executionSource(resume) : undefined,
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
        typeof result.runtime_digest !== "string"
      ) {
        throw new Error("cua backend returned an invalid execution target");
      }
      pi.events.emit("cua:sandboxes-changed", result);
      return {
        ...destination,
        address: result.address,
        executionId,
        localCwd: refresh?.localCwd ?? resume?.localCwd ?? ctx.cwd,
        remoteCwd: result.remote_cwd,
        workspaceState: parseWorkspaceState(result.workspace_state),
        runtimeDigest: result.runtime_digest,
      };
    } catch (error) {
      ctx.ui.setStatus("cua-session", undefined);
      pi.events.emit("cua:execution-target-changed", target);
      throw error;
    }
  }

  async function resumeTarget(
    saved: ExecutionTarget,
    ctx: UIContext,
  ): Promise<ExecutionTarget> {
    if (saved.kind === "local") return saved;
    return prepareTarget(
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

  function installProxies(): void {
    if (target.kind !== "sandbox") return;
    const active = pi.getActiveTools();
    for (const info of pi.getAllTools()) {
      if (localTools.has(info.name)) continue;
      const owned = info.sourceInfo.path.startsWith(extensionDir);
      if (owned && proxiedTools.has(info.name)) continue;
      const remote = bridge?.definition(info.name);
      if (!remote)
        throw new Error(`remote tool metadata missing: ${info.name}`);
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
          if (target.kind !== "sandbox" || !bridge) {
            throw new Error(`${info.name} has no active sandbox`);
          }
          return bridge.execute(info.name, id, input, signal, onUpdate);
        },
      });
      proxiedTools.add(info.name);
    }
    pi.setActiveTools(active);
  }

  async function activate(
    next: ExecutionTarget,
    ctx: UIContext,
    options: { persist?: boolean } = {},
  ): Promise<void> {
    if (next === target && bridge) {
      if (options.persist !== false) saveTarget(next);
      return;
    }
    const expectedTools = captureToolProviders();
    const nextBridge =
      next.kind === "sandbox" ? new ToolBridge(next, expectedTools) : undefined;
    if (next.kind === "sandbox") {
      ctx.ui.setStatus(
        "cua-session",
        formatSandboxProgress(
          next.name,
          "connect.tools",
          "starting remote tools",
        ),
      );
      pi.events.emit("cua:execution-target-changed", {
        ...next,
        state: "connecting",
        phase: "connect.tools",
        message: "starting remote tools",
      });
    }
    try {
      await nextBridge?.connect();
      if (options.persist !== false) saveTarget(next);
    } catch (error) {
      nextBridge?.close(true);
      ctx.ui.setStatus("cua-session", undefined);
      pi.events.emit("cua:execution-target-changed", target);
      throw error;
    }
    bridge?.close(true);
    target = next;
    placementError = undefined;
    bridge = nextBridge;
    if (next.kind === "sandbox") installProxies();
    ctx.ui.setStatus("cua-session", undefined);
    pi.events.emit("cua:execution-target-changed", next);
    void refreshWorkspaceDiff();
  }

  pi.registerTool({
    name: "cua_sandbox",
    label: "CUA Sandbox",
    description:
      "List, provision, repair, or delete managed Linux and Windows CUA sandboxes.",
    promptSnippet: "Manage isolated Linux and Windows CUA sandbox resources",
    promptGuidelines: [
      "Use cua_sandbox for sandbox resources; use /sandbox to choose where the current session executes tools.",
      "For custom resources, cua_sandbox create requires both cpu and memory_mb; omit both to use the OS defaults.",
      "Use a custom image only when the user explicitly provides a digest-pinned OCI reference.",
      "Do not delete a CUA sandbox unless the user explicitly asks to delete it.",
    ],
    parameters: resourceSchema,
    async execute(_id, input: ResourceInput, signal, onUpdate, ctx) {
      if (input.action === "create" && !input.os)
        throw new Error("create requires os");
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
      try {
        await ctx.waitForIdle();
        const destination = await destinationFromArgument(args, ctx);
        if (!destination) return;
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
          await activate(local, ctx);
          if (source) await cleanupTarget(source, ctx, ctx.signal);
          await ctx.reload();
          return;
        }
        if (
          bridge &&
          target.kind === "sandbox" &&
          target.name === destination.name
        )
          return;
        const source = target.kind === "sandbox" ? target : undefined;
        const prepared = await prepareTarget(destination, ctx);
        await activate(prepared, ctx);
        if (source) await cleanupTarget(source, ctx, ctx.signal);
      } catch (error) {
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
    let intendedTarget: ExecutionTarget | undefined;
    try {
      const current = loadSessionTarget(ctx);
      if (current) {
        intendedTarget = current;
        const resumed =
          event.reason === "reload" &&
          current.kind === "sandbox" &&
          current.executionId
            ? await prepareTarget(
                { kind: "sandbox", name: current.name, os: current.os },
                ctx,
                { inheritExecution: false, refresh: current },
              )
            : await resumeTarget(current, ctx);
        intendedTarget = resumed;
        if (resumed !== current) saveTarget(resumed);
        await activate(resumed, ctx, { persist: false });
        return;
      }
      const inherited = shouldHandoffExecutionTarget(event.reason)
        ? loadHandoffTarget(event.previousSessionFile)
        : undefined;
      if (inherited) {
        const prepared =
          inherited.kind === "sandbox" && !inherited.executionId
            ? await resumeTarget(inherited, ctx)
            : inherited;
        intendedTarget = prepared;
        saveTarget(prepared);
        await activate(prepared, ctx, { persist: false });
        return;
      }
      await activate({ kind: "local" }, ctx);
    } catch (error) {
      placementError =
        error instanceof Error ? error : new Error(String(error));
      if (intendedTarget?.kind === "sandbox") {
        target = intendedTarget;
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

  pi.on("user_bash", () => {
    if (placementError) throw placementError;
    if (target.kind !== "sandbox" || !bridge) return;
    const operations: BashOperations = {
      exec: (command, _cwd, options) =>
        bridge!.bash(`bash-${crypto.randomUUID()}`, command, {
          onData: options.onData,
          signal: options.signal,
          timeout: options.timeout,
        }),
    };
    return { operations };
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const source = target.kind === "sandbox" ? target : undefined;
    let disposeBridge = false;
    try {
      if (source && shouldHandoffExecutionTarget(event.reason)) {
        pi.appendEntry(executionTargetHandoffEntry, source);
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
