#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const agentDir = dirname(fileURLToPath(import.meta.url));
const homeDir = dirname(dirname(agentDir));
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;
process.env.PI_CODING_AGENT_DIR = agentDir;

const toolHostUrl = pathToFileURL(join(agentDir, "cua-tool-host.mjs"));
const port = Number(process.env.CUA_PI_TOOL_BROKER_PORT || "43121");
const hostFactories = new Map();
const hosts = new Map();

function diagnostic(socket, text) {
  if (!socket.destroyed) {
    socket.write(`${JSON.stringify({ type: "diagnostic", data: text })}\n`);
  }
}

function hostFactory(manifest) {
  let factory = hostFactories.get(manifest);
  if (factory) return factory;
  const generation = createHash("sha256").update(manifest).digest("hex");
  factory = import(`${toolHostUrl.href}?generation=${generation}`).then(
    (module) => module.createToolHost,
  );
  hostFactories.set(manifest, factory);
  return factory;
}

function hostEntry(cwd, manifest) {
  const current = hosts.get(cwd);
  if (current?.manifest === manifest) return current;

  const entry = {
    manifest,
    host: (async () => {
      if (current) await (await current.host).dispose();
      const createToolHost = await hostFactory(manifest);
      return createToolHost({ cwd, encodedManifest: manifest });
    })(),
  };
  hosts.set(cwd, entry);
  entry.host.catch(() => {
    if (hosts.get(cwd) === entry) hosts.delete(cwd);
  });
  return entry;
}

async function attach(socket, request, remainder) {
  if (
    !request ||
    request.type !== "open" ||
    typeof request.cwd !== "string" ||
    typeof request.manifest !== "string"
  ) {
    diagnostic(socket, "invalid desktop broker handshake");
    socket.end();
    return;
  }

  socket.pause();
  let disconnected = false;
  socket.once("close", () => {
    disconnected = true;
  });
  const entry = hostEntry(request.cwd, request.manifest);
  try {
    const host = await entry.host;
    if (disconnected) return;
    const result = await host.attach({
      input: socket,
      output: socket,
      initialInput: remainder,
    });
    if (result.disposeRequested && hosts.get(request.cwd) === entry) {
      hosts.delete(request.cwd);
      await host.dispose();
    }
  } catch (error) {
    diagnostic(socket, error instanceof Error ? error.message : String(error));
  } finally {
    socket.end();
  }
}

const server = createServer((socket) => {
  socket.setNoDelay(true);
  socket.on("error", (error) => {
    process.stderr.write(
      `desktop tool broker connection failed: ${error.message}\n`,
    );
  });
  let buffer = Buffer.alloc(0);
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) {
      if (buffer.length > 1024 * 1024) socket.destroy();
      return;
    }
    socket.removeListener("data", onData);
    const line = buffer
      .subarray(0, newline)
      .toString("utf8")
      .replace(/\r$/, "");
    const remainder = buffer.subarray(newline + 1);
    try {
      const request = JSON.parse(line);
      if (request?.type === "health") {
        socket.end(`${JSON.stringify({ type: "broker_ready" })}\n`);
        return;
      }
      void attach(socket, request, remainder);
    } catch (error) {
      diagnostic(
        socket,
        error instanceof Error ? error.message : String(error),
      );
      socket.end();
    }
  };
  socket.on("data", onData);
});

server.on("error", (error) => {
  process.stderr.write(`desktop tool broker failed: ${error.message}\n`);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  process.stderr.write(`desktop tool broker listening on 127.0.0.1:${port}\n`);
});
