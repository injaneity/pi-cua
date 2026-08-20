import {
  DynamicBorder,
  type AgentToolResult,
  type BashOperations,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  Container,
  SelectList,
  type SelectItem,
  Text,
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
const localTools = new Set(["cua_sandbox", "report_papercut"]);

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
  online: boolean;
};
type WorkspaceState = {
  version: 1;
  localRoot: string;
  // immutable objects captured when this thread first enters a sandbox
  commit: string;
  commitTree: string;
  baselineTree: string;
};
type BackendResult = {
  ok: boolean;
  error?: string;
  operation_id?: string;
  operation_log?: string;
  console_log?: string;
  phase?: string;
  message?: string;
  result?: BackendResult;
  sandboxes?: SandboxItem[];
  name?: string;
  os?: SandboxOS;
  address?: string;
  changed?: boolean;
  state?: string;
  remote_cwd?: string;
  workspace_state?: WorkspaceState;
  target?: unknown;
};
type Destination =
  { kind: "local" } | { kind: "sandbox"; name: string; os: SandboxOS };
type ExecutionTarget =
  | { kind: "local" }
  | {
      kind: "sandbox";
      name: string;
      os: SandboxOS;
      address: string;
      localCwd: string;
      remoteCwd: string;
      workspaceState: WorkspaceState;
    };
type UIContext = ExtensionContext | ExtensionCommandContext;
type PickerItem = SelectItem & { value: string };
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
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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
    "ControlMaster=auto",
    "-o",
    "ControlPersist=10m",
    "-o",
    `ControlPath=${homedir()}/.ssh/cua-%C`,
    "-T",
    `cua@${target.address}`,
  ];
}

function hostCommand(
  target: Extract<ExecutionTarget, { kind: "sandbox" }>,
  expectedTools: string[],
): string {
  const manifest = Buffer.from(JSON.stringify(expectedTools)).toString(
    "base64",
  );
  if (target.os === "windows") {
    return [
      `Set-Location ${powershellQuote(target.remoteCwd)}`,
      `& 'C:\\cua\\node-v22.20.0-win-x64\\node.exe' $HOME/.pi/agent/cua-tool-host.mjs ${powershellQuote(target.remoteCwd)} ${powershellQuote(manifest)}`,
    ].join("; ");
  }
  return `cd ${shellQuote(target.remoteCwd)} && exec node /home/cua/.pi/agent/cua-tool-host.mjs ${shellQuote(target.remoteCwd)} ${shellQuote(manifest)}`;
}

class ToolBridge {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private startPromise: Promise<void> | undefined;
  private stderr = "";
  private ready = false;
  private readonly remoteTools = new Map<string, RemoteToolInfo>();
  private sequence = 0;

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
    if (message.type === "manifest" && message.tools) {
      this.pending.delete(message.id);
      pending.resolve(message.tools);
      return;
    }
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
      const child = spawn(
        "ssh",
        [...sshArgs(this.target), hostCommand(this.target, this.expectedTools)],
        {
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      this.child = child;
      const decoder = new StringDecoder("utf8");
      let stdout = "";
      const timeout = setTimeout(() => {
        child.kill();
        reject(
          new Error(`remote tool host did not start on ${this.target.name}`),
        );
      }, 300_000);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += decoder.write(chunk);
        for (;;) {
          const index = stdout.indexOf("\n");
          if (index < 0) break;
          const line = stdout.slice(0, index).replace(/\r$/, "");
          stdout = stdout.slice(index + 1);
          if (!line) continue;
          try {
            const message = JSON.parse(line) as HostMessage;
            if (message.type === "ready") {
              const tools = Array.isArray(message.tools) ? message.tools : [];
              const names = new Set(tools.map((item) => item.name));
              const missing = this.expectedTools.filter(
                (name) => !names.has(name),
              );
              if (message.protocol !== protocolVersion || missing.length > 0) {
                child.kill();
                reject(
                  new Error(
                    message.protocol !== protocolVersion
                      ? `remote tool protocol mismatch: expected ${protocolVersion}, got ${message.protocol ?? "none"}`
                      : `remote tool host is missing: ${missing.join(", ")}`,
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
        const error = new Error(
          `remote tool host on ${this.target.name} exited (${code ?? "signal"})${detail ? `: ${detail}` : ""}`,
        );
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
      const finish = (callback: () => void) => {
        options.signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => this.send({ type: "cancel", id });
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

  async refresh(expectedTools: string[]): Promise<void> {
    const id = `manifest-${++this.sequence}`;
    const tools = await this.request<RemoteToolInfo[]>(id, {
      type: "manifest",
      id,
    });
    const names = new Set(tools.map((item) => item.name));
    const missing = expectedTools.filter((name) => !names.has(name));
    if (missing.length > 0) {
      throw new Error(`remote tool host is missing: ${missing.join(", ")}`);
    }
    this.remoteTools.clear();
    for (const item of tools) this.remoteTools.set(item.name, item);
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

  close(): void {
    const child = this.child;
    if (!child) return;
    if (child.stdin.writable) {
      this.send({ type: "shutdown" });
      child.stdin.end();
    }
    const killTimer = setTimeout(() => child.kill(), 1_000);
    killTimer.unref();
    this.child = undefined;
    this.ready = false;
  }
}

async function themedSelect(
  ctx: UIContext,
  title: string,
  items: PickerItem[],
): Promise<string | undefined> {
  if (ctx.mode !== "tui") {
    const selected = await ctx.ui.select(
      title,
      items.map((item) => item.label),
    );
    return items.find((item) => item.label === selected)?.value;
  }
  const selected = await ctx.ui.custom<string | null>(
    (tui, theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(
        new DynamicBorder((text: string) => theme.fg("accent", text)),
      );
      container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
      const list = new SelectList(items, Math.min(items.length, 12), {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) =>
          theme.fg(
            text.includes("create new sandbox") ? "mdHeading" : "accent",
            text,
          ),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(null);
      container.addChild(list);
      container.addChild(
        new Text(
          theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel"),
          1,
          0,
        ),
      );
      container.addChild(
        new DynamicBorder((text: string) => theme.fg("accent", text)),
      );
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    },
  );
  return selected ?? undefined;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("operation cancelled"));
      },
      { once: true },
    );
  });
}

function lastJson(stdout: string): BackendResult {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      return JSON.parse(lines[index]) as BackendResult;
    } catch {}
  }
  throw new Error(stdout.trim() || "cua backend returned no result");
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
  const sync = data.workspaceState as Record<string, unknown> | undefined;
  if (
    !sync ||
    sync.version !== 1 ||
    typeof sync.localRoot !== "string" ||
    typeof sync.commit !== "string" ||
    typeof sync.commitTree !== "string" ||
    typeof sync.baselineTree !== "string"
  )
    throw new Error("saved sandbox workspace state is unsupported");
  return {
    kind: "sandbox",
    name: data.name,
    os: data.os,
    address: data.address,
    localCwd: data.localCwd,
    remoteCwd: data.remoteCwd,
    workspaceState: sync as WorkspaceState,
  };
}

export default function cuaSandbox(pi: ExtensionAPI): void {
  let target: ExecutionTarget = { kind: "local" };
  let placementError: Error | undefined;
  let bridge: ToolBridge | undefined;
  const proxiedTools = new Set<string>();
  const toolPackages = new Set<string>();

  async function executeBackend(
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<BackendResult> {
    const result = await pi.exec(
      "python3",
      [backend, JSON.stringify(request)],
      {
        signal,
        timeout: 15_000,
      },
    );
    const parsed = lastJson(result.stdout);
    if (result.code === 0 && parsed.ok) return parsed;
    const context = [parsed.operation_id, parsed.phase]
      .filter((value) => typeof value === "string")
      .join("/");
    const log = parsed.operation_log ? `; log: ${parsed.operation_log}` : "";
    throw new Error(
      `${context ? `[${context}] ` : ""}${parsed.error || result.stderr.trim() || "cua operation failed"}${log}`,
    );
  }

  async function runBackend(
    request: Record<string, unknown>,
    signal?: AbortSignal,
    onStatus?: (status: BackendResult) => void,
  ): Promise<BackendResult> {
    let status = await executeBackend(request, signal);
    const operationId = status.operation_id;
    if (
      typeof operationId !== "string" ||
      !["queued", "running", "cancel_requested"].includes(status.state ?? "")
    ) {
      return status;
    }
    try {
      while (
        ["queued", "running", "cancel_requested"].includes(status.state ?? "")
      ) {
        await delay(500, signal);
        status = await executeBackend({
          action: "operation_status",
          operation_id: operationId,
        });
        onStatus?.(status);
      }
    } catch (error) {
      if (signal?.aborted) {
        await executeBackend({
          action: "operation_cancel",
          operation_id: operationId,
        }).catch(() => undefined);
      }
      throw error;
    }
    if (status.state === "succeeded" && status.result) return status.result;
    const log = status.console_log ?? status.operation_log;
    throw new Error(
      `[${operationId}/${status.phase ?? status.state}] ${status.error ?? status.message ?? "cua operation failed"}${log ? `; log: ${log}` : ""}`,
    );
  }

  async function loadTarget(
    ctx: UIContext,
    previousSessionFile?: string,
  ): Promise<ExecutionTarget | undefined> {
    const current = await runBackend({
      action: "get_execution_target",
      session_id: ctx.sessionManager.getSessionId(),
      session_file:
        ctx.sessionManager.getSessionFile() ?? previousSessionFile ?? "",
    });
    const saved = parseTarget(current.target);
    if (saved || !previousSessionFile) return saved;
    const inherited = await runBackend({
      action: "get_execution_target",
      session_file: previousSessionFile,
    });
    return parseTarget(inherited.target);
  }

  async function saveTarget(
    next: ExecutionTarget,
    ctx: UIContext,
  ): Promise<void> {
    await runBackend({
      action: "set_execution_target",
      session_id: ctx.sessionManager.getSessionId(),
      session_file: ctx.sessionManager.getSessionFile() ?? "",
      target: next,
    });
  }

  async function createSandbox(
    os: SandboxOS,
    ctx: UIContext,
    resources?: SandboxResources,
  ): Promise<Destination | undefined> {
    if (!ctx.hasUI) return undefined;
    const confirmed = await ctx.ui.confirm(
      `create ${os} sandbox?`,
      resources
        ? `this provisions ${resources.cpu} CPUs and ${resources.memory_mb} MiB of memory and incurs cost.`
        : "this provisions the configured default resources and incurs cost.",
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

  async function pickDestination(
    ctx: UIContext,
  ): Promise<Destination | undefined> {
    if (!ctx.hasUI) return undefined;
    const listed = await runBackend({ action: "list" }, ctx.signal);
    const online = (listed.sandboxes ?? []).filter((sandbox) => sandbox.online);
    const choice = await themedSelect(ctx, "Session execution", [
      { value: "local", label: "local", description: "run tools on this Mac" },
      ...online.map((sandbox) => ({
        value: sandbox.name,
        label: sandbox.name,
        description: `${sandbox.os} • reachable over Tailscale`,
      })),
      {
        value: "create",
        label: "create new sandbox",
        description: "provision a persistent CUA sandbox",
      },
    ]);
    if (!choice) return undefined;
    if (choice === "local") return { kind: "local" };
    if (choice === "create") {
      const os = await themedSelect(ctx, "Sandbox operating system", [
        { value: "linux", label: "linux", description: "Ubuntu" },
        { value: "windows", label: "windows", description: "Windows Server" },
      ]);
      if (os !== "linux" && os !== "windows") return undefined;
      return createSandbox(os, ctx);
    }
    const item = online.find((sandbox) => sandbox.name === choice);
    return item ? { kind: "sandbox", name: item.name, os: item.os } : undefined;
  }

  async function destinationFromArgument(
    args: string,
    ctx: UIContext,
  ): Promise<Destination | undefined> {
    const value = args.trim().toLowerCase();
    if (!value) return pickDestination(ctx);
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

  async function prepareTarget(
    destination: Extract<Destination, { kind: "sandbox" }>,
    ctx: UIContext,
    options: { inheritWorkspace?: boolean } = {},
  ): Promise<Extract<ExecutionTarget, { kind: "sandbox" }>> {
    const { inheritWorkspace = true } = options;
    captureToolProviders();
    pi.events.emit("cua:execution-target-changed", {
      ...destination,
      state: "connecting",
    });
    try {
      const result = await runBackend(
        {
          action: "prepare_execution",
          name: destination.name,
          source_cwd: ctx.cwd,
          workspace_id: ctx.sessionManager.getSessionId(),
          tool_packages: [...toolPackages],
          source:
            inheritWorkspace && target.kind === "sandbox"
              ? {
                  address: target.address,
                  os: target.os,
                  remoteCwd: target.remoteCwd,
                  state: target.workspaceState,
                }
              : undefined,
        },
        ctx.signal,
        (status) => {
          pi.events.emit("cua:execution-target-changed", {
            ...destination,
            state: "connecting",
            phase: status.phase,
            message: status.message,
          });
        },
      );
      if (
        typeof result.remote_cwd !== "string" ||
        typeof result.address !== "string" ||
        !result.workspace_state
      ) {
        throw new Error("cua backend returned an invalid execution target");
      }
      pi.events.emit("cua:sandboxes-changed", result);
      return {
        ...destination,
        address: result.address,
        localCwd: ctx.cwd,
        remoteCwd: result.remote_cwd,
        workspaceState: result.workspace_state,
      };
    } catch (error) {
      pi.events.emit("cua:execution-target-changed", target);
      throw error;
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
        async execute(id, input, signal, onUpdate) {
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
  ): Promise<void> {
    const expectedTools = captureToolProviders();
    const nextBridge =
      next.kind === "sandbox" ? new ToolBridge(next, expectedTools) : undefined;
    if (next.kind === "sandbox") {
      pi.events.emit("cua:execution-target-changed", {
        ...next,
        state: "connecting",
      });
    }
    try {
      await nextBridge?.connect();
      await saveTarget(next, ctx);
    } catch (error) {
      nextBridge?.close();
      pi.events.emit("cua:execution-target-changed", target);
      throw error;
    }
    bridge?.close();
    target = next;
    placementError = undefined;
    bridge = nextBridge;
    if (next.kind === "sandbox") installProxies();
    ctx.ui.setStatus("cua-session", undefined);
    pi.events.emit("cua:execution-target-changed", next);
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
                ? createResources
                  ? `this provisions ${createResources.cpu} CPUs and ${createResources.memory_mb} MiB of memory and incurs cost.`
                  : "this provisions the configured default resources and incurs cost."
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
          if (target.kind === "sandbox") {
            pi.events.emit("cua:execution-target-changed", {
              ...target,
              state: "connecting",
              phase: "workspace.local.sync",
              message: "syncing sandbox changes to local",
            });
            await runBackend(
              {
                action: "sync_workspace_to_local",
                source: {
                  address: target.address,
                  os: target.os,
                  remoteCwd: target.remoteCwd,
                  state: target.workspaceState,
                },
                local_cwd: target.localCwd,
              },
              ctx.signal,
              (status) => {
                pi.events.emit("cua:execution-target-changed", {
                  ...target,
                  state: "connecting",
                  phase: status.phase,
                  message: status.message,
                });
              },
            );
          }
          const local: ExecutionTarget = { kind: "local" };
          await activate(local, ctx);
          await ctx.reload();
          return;
        }
        if (target.kind === "sandbox" && target.name === destination.name)
          return;
        const prepared = await prepareTarget(destination, ctx);
        await activate(prepared, ctx);
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });

  pi.on("session_start", async (event, ctx) => {
    try {
      const saved = await loadTarget(
        ctx,
        event.reason === "fork" ? event.previousSessionFile : undefined,
      );
      if (saved) {
        if (event.reason === "fork" && saved.kind === "sandbox") {
          const prepared = await prepareTarget(
            { kind: "sandbox", name: saved.name, os: saved.os },
            ctx,
            { inheritWorkspace: false },
          );
          await activate(prepared, ctx);
        } else {
          await activate(saved, ctx);
        }
        return;
      }
      const needsTarget =
        event.reason === "new" ||
        event.reason === "fork" ||
        (event.reason === "startup" &&
          ctx.sessionManager.getEntries().length === 0);
      if (!needsTarget) return;
      const destination = await pickDestination(ctx);
      if (!destination || destination.kind === "local") {
        await activate({ kind: "local" }, ctx);
        return;
      }
      const prepared = await prepareTarget(destination, ctx);
      await activate(prepared, ctx);
    } catch (error) {
      placementError =
        error instanceof Error ? error : new Error(String(error));
      ctx.ui.notify(
        `execution placement blocked: ${placementError.message}; choose a target with /sandbox`,
        "error",
      );
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (placementError) throw placementError;
    if (target.kind !== "sandbox" || !bridge) return;
    const expectedTools = captureToolProviders();
    await bridge.refresh(expectedTools);
    installProxies();
    const localCwd = `Current working directory: ${target.localCwd}`;
    const environment = `Execution environment: ${target.os}. All tools and user shell commands run in ${target.os}; use relative workspace paths and answer environment questions for ${target.os}.`;
    return {
      systemPrompt: `${event.systemPrompt.replace(localCwd, "Current working directory: workspace root")}\n\n${environment}`,
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

  pi.on("session_shutdown", () => {
    bridge?.close();
    bridge = undefined;
  });
}
