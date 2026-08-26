#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

const source = new URL(".", import.meta.url).pathname;
const directory = await mkdtemp(join(tmpdir(), "pi-cua-broker-"));
let broker;

try {
  await Promise.all([
    copyFile(
      join(source, "tool-broker.mjs"),
      join(directory, "cua-tool-broker.mjs"),
    ),
    writeFile(
      join(directory, "cua-tool-host.mjs"),
      `import { readFile } from "node:fs/promises";
      const moduleGeneration = Number(await readFile(new URL("./generation", import.meta.url), "utf8"));
      globalThis.cuaTestNextHost ||= 0;
      export async function createToolHost({ encodedManifest }) {
        const host = ++globalThis.cuaTestNextHost;
        if (encodedManifest === "missing-tools") {
          const error = new Error("remote tool host is missing: find_roots");
          error.code = "ERR_CUA_MISSING_TOOLS";
          throw error;
        }
        return {
          async attach({ input, output, initialInput }) {
            output.write(JSON.stringify({ type: "ready", pid: process.pid, host, moduleGeneration }) + "\\n");
            let disposeRequested = initialInput.includes('"shutdown"');
            if (initialInput.length > 0) output.write(initialInput);
            input.on("data", (chunk) => {
              disposeRequested ||= chunk.includes('"shutdown"');
              output.write(chunk);
            });
            input.resume();
            await new Promise((resolve) => input.once("end", resolve));
            return { disposeRequested };
          },
          async dispose() {},
        };
      }`,
    ),
    writeFile(join(directory, "generation"), "1"),
  ]);

  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  reservation.close();
  await once(reservation, "close");

  broker = spawn(process.execPath, [join(directory, "cua-tool-broker.mjs")], {
    env: { ...process.env, CUA_PI_TOOL_BROKER_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await once(broker.stderr, "data");

  async function checkHealth() {
    const socket = createConnection({ host: "127.0.0.1", port });
    await once(socket, "connect");
    socket.write('{"type":"health"}\n');
    const [chunk] = await once(socket, "data", {
      signal: AbortSignal.timeout(5_000),
    });
    socket.end();
    await once(socket, "close");
    return JSON.parse(chunk.toString());
  }

  async function connectError(manifest) {
    const socket = createConnection({ host: "127.0.0.1", port });
    await once(socket, "connect");
    socket.write(
      `${JSON.stringify({ type: "open", cwd: directory, manifest })}\n`,
    );
    const [chunk] = await once(socket, "data", {
      signal: AbortSignal.timeout(5_000),
    });
    socket.end();
    await once(socket, "close");
    return JSON.parse(chunk.toString());
  }

  async function connectOnce(message = "hello\n", manifest = "generation-1") {
    const socket = createConnection({ host: "127.0.0.1", port });
    await once(socket, "connect");
    let output = "";
    socket.on("data", (chunk) => (output += chunk));
    socket.write(
      `${JSON.stringify({ type: "open", cwd: directory, manifest })}\n`,
    );
    socket.write(message);
    const signal = AbortSignal.timeout(5_000);
    while (!output.includes(message.trim())) {
      await once(socket, "data", { signal });
    }
    socket.end();
    await once(socket, "close");
    assert.ok(output.includes(message.trim()), output);
    return JSON.parse(output.split("\n", 1)[0]);
  }

  const abandonedProbe = createConnection({ host: "127.0.0.1", port });
  await once(abandonedProbe, "connect");
  abandonedProbe.destroy();
  await once(abandonedProbe, "close");
  assert.deepEqual(await checkHealth(), { type: "broker_ready" });
  const first = await connectOnce();
  const second = await connectOnce();
  await writeFile(join(directory, "generation"), "2");
  const reconfigured = await connectOnce("hello\n", "generation-2");
  const failure = await connectError("missing-tools");
  const recovered = await connectOnce("hello\n", "generation-2");
  const retired = await connectOnce('{"type":"shutdown"}\n', "generation-2");
  const replacement = await connectOnce("hello\n", "generation-2");
  assert.equal(first.pid, broker.pid);
  assert.equal(second.pid, broker.pid);
  assert.equal(first.host, 1);
  assert.equal(first.moduleGeneration, 1);
  assert.equal(second.host, 1);
  assert.equal(second.moduleGeneration, 1);
  assert.equal(reconfigured.host, 2);
  assert.equal(reconfigured.moduleGeneration, 2);
  assert.deepEqual(failure, {
    type: "open_error",
    owner: "runtime",
    code: "ERR_CUA_MISSING_TOOLS",
    error: "remote tool host is missing: find_roots",
  });
  assert.equal(recovered.host, 4);
  assert.equal(retired.host, 4);
  assert.equal(replacement.host, 5);
  console.log("desktop tool broker test passed");
} finally {
  if (broker?.exitCode === null) {
    broker.kill();
    await once(broker, "close");
  }
  await rm(directory, { recursive: true, force: true });
}
