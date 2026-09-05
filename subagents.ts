import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type Task = {
  id: string;
  sandbox: string;
  state: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  sessionFile?: string;
  workspace?: string;
  message?: string;
};

type Runner = (
  signal: AbortSignal,
  update: (value: Partial<Task>) => void,
) => Promise<string>;

export class Subagents {
  private readonly running = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private closed = false;

  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  private save(task: Task): void {
    const path = join(this.directory, `${task.id}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(task), { mode: 0o600 });
    renameSync(temporary, path);
  }

  get(id: string): Task {
    if (!/^[0-9a-f-]{36}$/.test(id))
      throw new Error("invalid subagent task id");
    const task = JSON.parse(
      readFileSync(join(this.directory, `${id}.json`), "utf8"),
    ) as Task;
    if (task.state === "running" && !this.running.has(id))
      return {
        ...task,
        state: "interrupted",
        message: "controller runtime ended; task was not replayed",
      };
    return task;
  }

  list(): Task[] {
    return readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.get(name.slice(0, -5)));
  }

  spawn(sandbox: string, run: Runner): Task {
    if (this.closed) throw new Error("subagent manager is closed");
    if (this.running.size >= 4)
      throw new Error("four subagents are already running");
    if (
      this.list().some(
        (task) => task.sandbox === sandbox && task.state === "running",
      )
    )
      throw new Error(`a subagent is already running on ${sandbox}`);
    const task: Task = { id: randomUUID(), sandbox, state: "running" };
    const controller = new AbortController();
    this.save(task);
    const update = (value: Partial<Task>) => {
      Object.assign(task, value, { id: task.id, sandbox, state: "running" });
      this.save(task);
    };
    const done = Promise.resolve().then(async () => {
      try {
        controller.signal.throwIfAborted();
        task.message = (await run(controller.signal, update)).slice(-16000);
        task.state = controller.signal.aborted ? "cancelled" : "completed";
      } catch (error) {
        task.state = controller.signal.aborted ? "cancelled" : "failed";
        task.message = String(error).slice(-16000);
      } finally {
        this.running.delete(task.id);
        this.save(task);
      }
    });
    this.running.set(task.id, { controller, done });
    return { ...task };
  }

  cancel(id: string): Task {
    this.get(id);
    this.running.get(id)?.controller.abort();
    return this.get(id);
  }

  async wait(id: string, signal?: AbortSignal): Promise<Task> {
    this.get(id);
    const done = this.running.get(id)?.done;
    if (!done) return this.get(id);
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const aborted = () =>
        reject(new Error("wait cancelled; subagent continues running"));
      signal?.addEventListener("abort", aborted, { once: true });
      done
        .then(resolve, reject)
        .finally(() => signal?.removeEventListener("abort", aborted));
    });
    return this.get(id);
  }

  async close(): Promise<void> {
    this.closed = true;
    const active = [...this.running.values()];
    for (const task of active) task.controller.abort();
    await Promise.all(active.map((task) => task.done));
  }
}
