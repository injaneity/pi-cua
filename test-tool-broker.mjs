#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

const source = new URL(".", import.meta.url).pathname;
const directory = await mkdtemp(join(tmpdir(), "pi-cua-broker-"));
let broker;

const digests = {
  first: "1".repeat(20),
  second: "2".repeat(20),
  missing: "3".repeat(20),
};
const encodedManifest = (digest, tools = ["read"]) =>
  Buffer.from(JSON.stringify({ tools, runtimeDigest: digest })).toString(
    "base64",
  );
const agentDir = (digest) =>
  join(directory, ".cua-pi", "runtimes", digest, "agent");

async function prepareRuntime(digest, moduleGeneration) {
  const agent = agentDir(digest);
  await mkdir(agent, { recursive: true });
  await Promise.all([
    writeFile(
      join(agent, "cua-tool-host.mjs"),
      `import { readFile } from "node:fs/promises";
      const moduleGeneration = Number(await readFile(new URL("./generation", import.meta.url), "utf8"));
      globalThis.cuaTestNextHost ||= 0;
      export async function createToolHost({ encodedManifest }) {
        const host = ++globalThis.cuaTestNextHost;
        const manifest = JSON.parse(Buffer.from(encodedManifest, "base64").toString("utf8"));
        if (manifest.tools.includes("missing")) {
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
    writeFile(join(agent, "generation"), String(moduleGeneration)),
  ]);
}

try {
  await Promise.all([
    prepareRuntime(digests.first, 1),
    prepareRuntime(digests.second, 2),
    prepareRuntime(digests.missing, 3),
  ]);

  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  reservation.close();
  await once(reservation, "close");

  broker = spawn(process.execPath, [join(source, "tool-broker.mjs")], {
    env: {
      ...process.env,
      CUA_PI_HOME: directory,
      CUA_PI_TOOL_BROKER_PORT: String(port),
    },
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

  function openRequest(digest, tools) {
    return `${JSON.stringify({
      type: "open",
      cwd: directory,
      agentDir: agentDir(digest),
      manifest: encodedManifest(digest, tools),
    })}\n`;
  }

  async function connectError(digest, tools) {
    const socket = createConnection({ host: "127.0.0.1", port });
    await once(socket, "connect");
    socket.write(openRequest(digest, tools));
    const [chunk] = await once(socket, "data", {
      signal: AbortSignal.timeout(5_000),
    });
    socket.end();
    await once(socket, "close");
    return JSON.parse(chunk.toString());
  }

  async function connectOnce(
    message = "hello\n",
    digest = digests.first,
    tools = ["read"],
  ) {
    const socket = createConnection({ host: "127.0.0.1", port });
    await once(socket, "connect");
    let output = "";
    socket.on("data", (chunk) => (output += chunk));
    socket.write(openRequest(digest, tools));
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
  const reconfigured = await connectOnce("hello\n", digests.second);
  const failure = await connectError(digests.missing, ["missing"]);
  const recovered = await connectOnce("hello\n", digests.second);
  const retired = await connectOnce('{"type":"shutdown"}\n', digests.second);
  const replacement = await connectOnce("hello\n", digests.second);

  assert.equal(first.pid, broker.pid);
  assert.equal(second.pid, broker.pid);
  assert.equal(first.host, 1);
  assert.equal(first.moduleGeneration, 1);
  assert.equal(second.host, 1);
  assert.equal(reconfigured.host, 2);
  assert.equal(reconfigured.moduleGeneration, 2);
  assert.deepEqual(failure, {
    type: "open_error",
    owner: "runtime",
    code: "ERR_CUA_MISSING_TOOLS",
    error: "remote tool host is missing: find_roots",
  });
  assert.equal(recovered.host, 2);
  assert.equal(retired.host, 2);
  assert.equal(replacement.host, 4);
  console.log("desktop tool broker test passed");
} finally {
  if (broker?.exitCode === null) {
    broker.kill();
    await once(broker, "close");
  }
  await rm(directory, { recursive: true, force: true });
}
