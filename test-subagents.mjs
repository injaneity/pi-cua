import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./subagents.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;
const { Subagents } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

function manager(t) {
  const directory = mkdtempSync(join(tmpdir(), "pi-subagents-"));
  const tasks = new Subagents(directory);
  t.after(async () => {
    await tasks.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { tasks, directory };
}

const untilCancelled = (signal) =>
  new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve("cancelled"), {
      once: true,
    });
  });

test("independent sandboxes run concurrently and results persist", async (t) => {
  const { tasks, directory } = manager(t);
  const linux = tasks.spawn("linux", untilCancelled);
  const windows = tasks.spawn("windows", async (_signal, update) => {
    update({ workspace: "/child", sessionFile: "/session.jsonl" });
    return "done";
  });
  const result = await tasks.wait(windows.id);
  assert.equal(result.state, "completed");
  assert.equal(tasks.get(linux.id).state, "running");
  assert.equal(new Subagents(directory).get(windows.id).workspace, "/child");
});

test("cancelling one child leaves its sibling running", async (t) => {
  const { tasks } = manager(t);
  const a = tasks.spawn("macos", untilCancelled);
  const b = tasks.spawn("windows", untilCancelled);
  await Promise.resolve();
  tasks.cancel(a.id);
  assert.equal((await tasks.wait(a.id)).state, "cancelled");
  assert.equal(tasks.get(b.id).state, "running");
});

test("limits prevent duplicate target work and excessive concurrency", async (t) => {
  const { tasks } = manager(t);
  tasks.spawn("macos", untilCancelled);
  assert.throws(() => tasks.spawn("macos", untilCancelled), /already running/);
  for (const name of ["a", "b", "c"]) tasks.spawn(name, untilCancelled);
  assert.throws(() => tasks.spawn("d", untilCancelled), /four subagents/);
});

test("cancelling wait does not cancel the task", async (t) => {
  const { tasks } = manager(t);
  const task = tasks.spawn("linux", untilCancelled);
  const controller = new AbortController();
  const pending = tasks.wait(task.id, controller.signal);
  controller.abort();
  await assert.rejects(pending, /subagent continues/);
  assert.equal(tasks.get(task.id).state, "running");
});

test("shutdown cancels tasks and rejects new work", async (t) => {
  const { tasks } = manager(t);
  const task = tasks.spawn("linux", untilCancelled);
  await tasks.close();
  assert.equal(tasks.get(task.id).state, "cancelled");
  assert.throws(() => tasks.spawn("windows", untilCancelled), /closed/);
});

test("failures are durable and do not replay", async (t) => {
  const { tasks, directory } = manager(t);
  const task = tasks.spawn("linux", async () => {
    throw new Error("setup failed");
  });
  assert.equal((await tasks.wait(task.id)).state, "failed");
  const path = join(directory, `${task.id}.json`);
  writeFileSync(path, JSON.stringify({ ...task, state: "running" }));
  const restored = new Subagents(directory).get(task.id);
  assert.equal(restored.state, "interrupted");
});

test("task ids cannot escape parent storage", (t) => {
  const { tasks } = manager(t);
  assert.throws(() => tasks.get("../../other-session"), /invalid/);
});
