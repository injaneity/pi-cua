import { Cua, CuaConfig, ProcessEventKind, SpacesdCommand, type SpacesdClientLike } from "@trycua/cua";

export type SpaceOS = "linux" | "macos";

export type SpaceItem = {
  id: string;
  name: string;
  os: string;
  provider: string;
  online?: boolean;
  reason?: string;
};

export function orderedSpaces(items: readonly SpaceItem[]): SpaceItem[] {
  const rank = (item: SpaceItem) => item.online === true ? 0 : item.online === undefined ? 1 : 2;
  return [...items].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export type SpaceCheck = { online: boolean; os: string; reason?: string };

export type ProcessSpec = {
  program: string;
  args: string[];
  timeoutMs?: number;
  stdin?: boolean;
};

export type Exit = { code: number | null; signal: string | null; timedOut?: boolean; error: string | null };

export type ProcessHandle = {
  write(data: Buffer): Promise<void>;
  closeStdin(): Promise<void>;
  kill(): Promise<void>;
  exited: Promise<Exit>;
};

export type SpaceTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

export type ToolResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError: boolean;
};

export interface SpacesClient {
  list(signal?: AbortSignal): Promise<SpaceItem[]>;
  check(item: SpaceItem, signal?: AbortSignal): Promise<SpaceCheck>;
  spawn(
    spaceId: string,
    spec: ProcessSpec,
    onOutput: (stream: "stdout" | "stderr", data: Buffer) => void,
    signal?: AbortSignal,
  ): Promise<ProcessHandle>;
  tools(signal?: AbortSignal): Promise<SpaceTool[]>;
  call(name: string, input: unknown, signal?: AbortSignal): Promise<ToolResult>;
  close(): void;
}

export function isSpaceOS(value: unknown): value is SpaceOS {
  return value === "linux" || value === "macos";
}

export type RunResult = Exit & { stdout: Buffer; stderr: string };

export async function runProcess(
  client: SpacesClient,
  spaceId: string,
  spec: Omit<ProcessSpec, "stdin">,
  input?: Buffer,
  signal?: AbortSignal,
  onOutput?: (stream: "stdout" | "stderr", data: Buffer) => void,
): Promise<RunResult> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const handle = await client.spawn(
    spaceId,
    { ...spec, stdin: input !== undefined },
    (stream, data) => (onOutput ? onOutput(stream, data) : (stream === "stdout" ? stdout : stderr).push(data)),
    signal,
  );
  const onAbort = () => void handle.kill();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (input !== undefined) {
      for (let offset = 0; offset < input.length; offset += 1024 * 1024)
        await handle.write(input.subarray(offset, offset + 1024 * 1024));
      await handle.closeStdin();
    }
    const exit = await handle.exited;
    if (signal?.aborted) throw new Error("aborted");
    return { ...exit, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

const cua = () => Cua.auto(CuaConfig.create({ fleetFromSession: true }));

export class NativeSpacesClient implements SpacesClient {
  private readonly spaces = cua().spaces();
  private readonly clients = new Map<string, Promise<SpacesdClientLike>>();

  private spacesd(id: string, signal?: AbortSignal): Promise<SpacesdClientLike> {
    let client = this.clients.get(id);
    if (!client) {
      client = this.spaces.space(id, signal ? { signal } : undefined).then((space) => space.spacesd());
      client.catch(() => this.clients.delete(id));
      this.clients.set(id, client);
    }
    return client;
  }

  async list(signal?: AbortSignal): Promise<SpaceItem[]> {
    const listed = await this.spaces.list(signal ? { signal } : undefined);
    return listed.map((info) => ({ id: info.id, name: info.name, os: info.os, provider: info.provider }));
  }

  async check(item: SpaceItem, signal?: AbortSignal): Promise<SpaceCheck> {
    try {
      const probe = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(3_000)]);
      const capabilities = await (await this.spacesd(item.id, probe)).capabilities({ signal: probe });
      return { online: true, os: item.os || capabilities.osFamily };
    } catch (error) {
      return { online: false, os: item.os, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async spawn(
    spaceId: string,
    spec: ProcessSpec,
    onOutput: (stream: "stdout" | "stderr", data: Buffer) => void,
    signal?: AbortSignal,
  ): Promise<ProcessHandle> {
    const env = await this.spacesd(spaceId, signal);
    const child = await env.spawn(
      SpacesdCommand.create({ program: spec.program, args: spec.args, env: new Map(), timeoutMs: spec.timeoutMs, stdin: spec.stdin === true }),
      signal ? { signal } : undefined,
    );
    const exited = (async (): Promise<Exit> => {
      try {
        for (;;) {
          const event = await child.nextEvent();
          if (!event) return { code: null, signal: null, error: "process stream ended without an exit" };
          if (event.kind === ProcessEventKind.Exit)
            return { code: event.exit?.code ?? null, signal: event.exit?.signal ?? null, timedOut: event.exit?.timedOut === true, error: event.exit?.error ?? null };
          onOutput(event.kind === ProcessEventKind.Stderr ? "stderr" : "stdout", Buffer.from(event.data));
        }
      } catch (error) {
        return { code: null, signal: null, error: error instanceof Error ? error.message : String(error) };
      }
    })();
    return {
      write: async (data) => child.writeStdin(data.buffer.slice(data.byteOffset, data.byteOffset + data.length) as ArrayBuffer),
      closeStdin: () => child.closeStdin(),
      kill: () => child.kill().catch(() => undefined),
      exited,
    };
  }

  async tools(signal?: AbortSignal): Promise<SpaceTool[]> {
    return JSON.parse(await this.spaces.listToolsJson(signal ? { signal } : undefined)).tools;
  }

  async call(name: string, input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const result = await this.spaces.callToolJson(name, JSON.stringify(input ?? {}), signal ? { signal } : undefined);
    if (name === "delete_space") this.clients.clear();
    return { content: JSON.parse(result.contentJson || "[]"), isError: result.isError === true };
  }

  close(): void {
    this.clients.clear();
  }
}
