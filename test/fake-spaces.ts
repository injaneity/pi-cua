import { spawn, type ChildProcess } from "node:child_process";
import type { CreateOptions, Exit, ProcessHandle, ProcessSpec, SpaceItem, SpacesClient } from "../spaces.ts";

export type FakeSpace = SpaceItem & { home: string };

const machineIdCommand = `ioreg -rd1 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/ { print $4 }'`;

export class FakeSpacesClient implements SpacesClient {
  private readonly tagged = new Map<string, ChildProcess>();

  constructor(readonly spaces: FakeSpace[]) {}

  private find(spaceId: string): FakeSpace {
    const space = this.spaces.find((item) => item.id === spaceId);
    if (!space) throw new Error(`unknown fake Space ${spaceId}`);
    return space;
  }

  async list(): Promise<SpaceItem[]> {
    return this.spaces.map(({ home: _home, ...item }) => item);
  }

  async spawn(
    spaceId: string,
    spec: ProcessSpec,
    onOutput: (stream: "stdout" | "stderr", data: Buffer) => void,
  ): Promise<ProcessHandle> {
    const space = this.find(spaceId);
    const args = spec.args.map((arg) => arg.replace(machineIdCommand, `echo fake-${space.id}`));
    const child = spawn(spec.program, args, {
      cwd: spec.cwd ?? space.home,
      env: { ...process.env, ...spec.env, HOME: space.home },
      stdio: [spec.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      detached: true,
    });
    if (spec.tag) this.tagged.set(`${spaceId}:${spec.tag}`, child);
    child.stdout!.on("data", (data: Buffer) => onOutput("stdout", data));
    child.stderr!.on("data", (data: Buffer) => onOutput("stderr", data));
    let timedOut = false;
    const timer = spec.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, spec.timeoutMs)
      : undefined;
    const kill = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    };
    const exited = new Promise<Exit>((resolve) => {
      child.on("error", (error) => resolve({ code: null, signal: null, error: error.message }));
      child.on("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        resolve({ code, signal, timedOut, error: null });
      });
    });
    return {
      write: (data) =>
        new Promise<void>((resolve, reject) => child.stdin!.write(data, (error) => (error ? reject(error) : resolve()))),
      closeStdin: async () => void child.stdin?.end(),
      kill: async () => kill(),
      exited,
    };
  }

  async killTag(spaceId: string, tag: string): Promise<void> {
    const child = this.tagged.get(`${spaceId}:${tag}`);
    this.tagged.delete(`${spaceId}:${tag}`);
    if (child?.pid && child.exitCode === null)
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
  }

  async create(_options: CreateOptions): Promise<SpaceItem> {
    throw new Error("fake Spaces cannot be created");
  }

  async remove(): Promise<void> {
    throw new Error("fake Spaces cannot be deleted");
  }

  close(): void {}
}
