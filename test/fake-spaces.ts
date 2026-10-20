import { spawn } from "node:child_process";
import type { Exit, ProcessHandle, ProcessSpec, SpaceCheck, SpaceItem, SpacesClient, SpaceTool, ToolResult } from "../spaces.ts";

export type FakeSpace = SpaceItem & { home: string };

const machineIdCommand = `ioreg -rd1 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/ { print $4 }'`;

export class FakeSpacesClient implements SpacesClient {
  constructor(readonly spaces: FakeSpace[]) {}

  private find(spaceId: string): FakeSpace {
    const space = this.spaces.find((item) => item.id === spaceId);
    if (!space) throw new Error(`unknown fake Space ${spaceId}`);
    return space;
  }

  async list(): Promise<SpaceItem[]> {
    return this.spaces.map(({ home: _home, online: _online, ...item }) => item);
  }

  async check(item: SpaceItem): Promise<SpaceCheck> {
    const space = this.find(item.id);
    return { online: space.online !== false, os: space.os };
  }

  async spawn(
    spaceId: string,
    spec: ProcessSpec,
    onOutput: (stream: "stdout" | "stderr", data: Buffer) => void,
  ): Promise<ProcessHandle> {
    const space = this.find(spaceId);
    const args = spec.args.map((arg) => arg.replace(machineIdCommand, `echo fake-${space.id}`));
    const child = spawn(spec.program, args, {
      cwd: space.home,
      env: { ...process.env, HOME: space.home },
      stdio: [spec.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      detached: true,
    });
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

  readonly calls: Array<{ name: string; input: unknown }> = [];

  async tools(): Promise<SpaceTool[]> {
    return [
      { name: "list_spaces", description: "List Spaces.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
      {
        name: "delete_space",
        description: "Delete a Space.",
        inputSchema: { type: "object", properties: { space: { type: "string" } }, required: ["space"] },
        annotations: { destructiveHint: true },
      },
    ];
  }

  async call(name: string, input: unknown): Promise<ToolResult> {
    this.calls.push({ name, input });
    return { content: [{ type: "text", text: `${name} ok` }], isError: false };
  }

  close(): void {}
}
