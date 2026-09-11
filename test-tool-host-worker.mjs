import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(
  new URL("./tool-host.mjs", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile(
  "tool-host.mjs",
  source,
  ts.ScriptTarget.Latest,
  true,
);
let block;
function visit(node) {
  if (ts.isIfStatement(node) && node.expression.getText(ast) === "process.send")
    block = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(block);
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function worker(failure) {
  const messages = [];
  const exits = [];
  const inputs = [];
  let disposed = 0;
  let attachments = 0;
  const process = Object.assign(new EventEmitter(), {
    send(message, callback) {
      messages.push(message);
      callback?.();
    },
    exit(code) {
      exits.push(code);
    },
  });
  const host = {
    async attach({ input, output, initialInput }) {
      attachments++;
      const chunks = [initialInput];
      output.write(`attachment-${attachments}`);
      input.on("data", (chunk) => chunks.push(chunk));
      await new Promise((resolve) => input.once("end", resolve));
      inputs.push(Buffer.concat(chunks).toString());
      return { disposeRequested: false };
    },
    async dispose() {
      disposed++;
    },
  };
  await vm.runInNewContext(`(async () => { ${block} })()`, {
    process,
    Buffer,
    PassThrough,
    Writable,
    cwd: "/workspace",
    agentDir: "/runtime/agent",
    encodedManifest: "manifest",
    createToolHost: async () => {
      if (failure) throw failure;
      return host;
    },
  });
  return {
    process,
    messages,
    exits,
    inputs,
    get disposed() {
      return disposed;
    },
  };
}

test("production worker preserves host state across detach and reattach", async () => {
  const w = await worker();
  assert.equal(w.messages[0].type, "initialized");
  for (const count of [1, 2]) {
    w.process.emit("message", {
      type: "attach",
      initialInput: Buffer.from("first-").toString("base64"),
    });
    w.process.emit("message", {
      type: "input",
      data: Buffer.from("second").toString("base64"),
    });
    w.process.emit("message", { type: "end" });
    await settle();
    assert.equal(w.inputs[count - 1], "first-second");
    assert.equal(
      Buffer.from(
        w.messages.findLast((m) => m.type === "data").data,
        "base64",
      ).toString(),
      `attachment-${count}`,
    );
    assert.equal(w.messages.at(-1).type, "detached");
  }
  w.process.emit("message", { type: "dispose" });
  await settle();
  assert.equal(w.disposed, 1);
  assert.deepEqual(w.exits, [0]);
});

test("production worker rejects overlapping attachments", async () => {
  const w = await worker();
  w.process.emit("message", { type: "attach", initialInput: "" });
  w.process.emit("message", { type: "attach", initialInput: "" });
  assert.equal(w.messages.at(-1).type, "failure");
  assert.match(w.messages.at(-1).error, /already attached/);
  w.process.emit("message", { type: "end" });
  await settle();
});

test("production worker disposes its runtime when its broker disconnects", async () => {
  const w = await worker();
  w.process.emit("disconnect");
  await settle();
  assert.equal(w.disposed, 1);
  assert.deepEqual(w.exits, [0]);
});

test("production worker preserves initialization failure codes", async () => {
  const w = await worker(
    Object.assign(new Error("missing implementation"), {
      code: "ERR_CUA_MISSING_TOOLS",
    }),
  );
  assert.equal(w.messages[0].code, "ERR_CUA_MISSING_TOOLS");
  assert.deepEqual(w.exits, [1]);
});
