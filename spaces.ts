import { fork, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type SpaceOS = "linux" | "macos";

export type SpaceItem = {
  id: string;
  name: string;
  os: string;
  provider: string;
  online: boolean;
  reason?: string;
};

export type ProcessSpec = {
  program: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  tag?: string;
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

export type CreateOptions = {
  on: "local" | "cloud";
  name?: string;
  cpus?: number;
  memoryMb?: number;
};

export interface SpacesClient {
  list(signal?: AbortSignal): Promise<SpaceItem[]>;
  spawn(
    spaceId: string,
    spec: ProcessSpec,
    onOutput: (stream: "stdout" | "stderr", data: Buffer) => void,
    signal?: AbortSignal,
  ): Promise<ProcessHandle>;
  killTag(spaceId: string, tag: string, signal?: AbortSignal): Promise<void>;
  create(options: CreateOptions, signal?: AbortSignal): Promise<SpaceItem>;
  remove(spaceId: string, signal?: AbortSignal): Promise<void>;
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
): Promise<RunResult> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const handle = await client.spawn(
    spaceId,
    { ...spec, stdin: input !== undefined },
    (stream, data) => (stream === "stdout" ? stdout : stderr).push(data),
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

const workerPath = join(dirname(fileURLToPath(import.meta.url)), "space-worker.mjs");

type Running = {
  onOutput: (stream: "stdout" | "stderr", data: Buffer) => void;
  resolve: (exit: Exit) => void;
};

export class WorkerSpacesClient implements SpacesClient {
  private worker: ChildProcess | undefined;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private readonly running = new Map<number, Running>();
  private sequence = 0;
  private diagnostics = "";
  private closed = false;

  private start(): ChildProcess {
    if (this.closed) throw new Error("the Spaces client is closed");
    if (this.worker?.connected) return this.worker;
    const worker = fork(workerPath, [], { stdio: ["ignore", "pipe", "pipe", "ipc"], execArgv: [] });
    for (const stream of [worker.stdout, worker.stderr])
      stream?.on("data", (chunk: Buffer) => {
        this.diagnostics = `${this.diagnostics}${chunk}`.slice(-4096);
      });
    worker.on("message", (message: any) => {
      if (message.type === "output") {
        this.running.get(message.process)?.onOutput(message.stream, Buffer.from(message.data, "base64"));
        return;
      }
      if (message.type === "exit") {
        const process = this.running.get(message.process);
        this.running.delete(message.process);
        process?.resolve({ code: message.code, signal: message.signal, timedOut: message.timedOut, error: message.error });
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.result);
    });
    const fail = () => {
      if (this.worker === worker) this.worker = undefined;
      const detail = this.diagnostics.trim();
      const error = new Error(`Spaces SDK worker exited${detail ? `: ${detail.slice(-500)}` : ""}`);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      for (const process of this.running.values()) process.resolve({ code: null, signal: null, error: error.message });
      this.running.clear();
    };
    worker.on("exit", fail);
    worker.on("error", fail);
    this.worker = worker;
    return worker;
  }

  private call<T>(method: string, args: unknown[], signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error("aborted"));
    let worker: ChildProcess;
    try {
      worker = this.start();
    } catch (error) {
      return Promise.reject(error);
    }
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.delete(id)) return;
        if (worker.connected) worker.send({ method: "cancel", id });
        reject(new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const done =
        <V>(callback: (value: V) => void) =>
        (value: V) => {
          signal?.removeEventListener("abort", onAbort);
          callback(value);
        };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      worker.send({ id, method, args }, (error) => {
        if (error && this.pending.delete(id)) done(reject)(error);
      });
    });
  }

  list(signal?: AbortSignal): Promise<SpaceItem[]> {
    return this.call("list", [], signal);
  }

  async spawn(
    spaceId: string,
    spec: ProcessSpec,
    onOutput: (stream: "stdout" | "stderr", data: Buffer) => void,
    signal?: AbortSignal,
  ): Promise<ProcessHandle> {
    const id = ++this.sequence;
    let resolve!: (exit: Exit) => void;
    const exited = new Promise<Exit>((done) => (resolve = done));
    this.running.set(id, { onOutput, resolve });
    try {
      await this.call("spawn", [spaceId, spec, id], signal);
    } catch (error) {
      this.running.delete(id);
      throw error;
    }
    return {
      write: async (data) => void (await this.call("write", [id, data.toString("base64")])),
      closeStdin: async () => void (await this.call("closeStdin", [id])),
      kill: async () => void (await this.call("kill", [id])),
      exited,
    };
  }

  async killTag(spaceId: string, tag: string, signal?: AbortSignal): Promise<void> {
    await this.call("killTag", [spaceId, tag], signal);
  }

  create(options: CreateOptions, signal?: AbortSignal): Promise<SpaceItem> {
    return this.call("create", [options], signal);
  }

  async remove(spaceId: string, signal?: AbortSignal): Promise<void> {
    await this.call("delete", [spaceId], signal);
  }

  close(): void {
    this.closed = true;
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;
    if (worker.connected) worker.disconnect();
    const timer = setTimeout(() => worker.kill(), 2000);
    timer.unref();
    worker.once("exit", () => clearTimeout(timer));
  }
}
