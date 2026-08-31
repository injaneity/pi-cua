#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const agentDir = dirname(fileURLToPath(import.meta.url));
const homeDir = process.env.CUA_PI_HOME || dirname(dirname(agentDir));
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;
process.env.PI_CODING_AGENT_DIR = agentDir;

const port = Number(process.env.CUA_PI_TOOL_BROKER_PORT || "43121");
const hostFactories = new Map();
const hosts = new Map();

function openError(socket, owner, code, error) {
  if (!socket.destroyed) {
    socket.write(
      `${JSON.stringify({ type: "open_error", owner, code, error })}\n`,
    );
  }
}

function executionManifest(encodedManifest) {
  const manifest = JSON.parse(
    Buffer.from(encodedManifest, "base64").toString("utf8"),
  );
  if (
    typeof manifest?.runtimeDigest !== "string" ||
    !/^[0-9a-f]{20}$/.test(manifest.runtimeDigest)
  ) {
    throw new Error("invalid execution manifest generation");
  }
  return manifest;
}

function expectedAgentDir(encodedManifest) {
  const manifest = executionManifest(encodedManifest);
  return join(homeDir, ".cua-pi", "runtimes", manifest.runtimeDigest, "agent");
}

function hostFactory(agentDir, manifest) {
  const key = `${agentDir}\0${manifest}`;
  let factory = hostFactories.get(key);
  if (factory) return factory;
  const generation = createHash("sha256").update(key).digest("hex");
  const toolHostUrl = pathToFileURL(join(agentDir, "cua-tool-host.mjs"));
  factory = import(`${toolHostUrl.href}?generation=${generation}`).then(
    (module) => module.createToolHost,
  );
  hostFactories.set(key, factory);
  return factory;
}

function hostEntry(cwd, agentDir, manifest) {
  const key = `${cwd}\0${manifest}`;
  const current = hosts.get(key);
  if (current) return current;

  const entry = {
    host: (async () => {
      const createToolHost = await hostFactory(agentDir, manifest);
      return createToolHost({ cwd, agentDir, encodedManifest: manifest });
    })(),
  };
  hosts.set(key, entry);
  entry.host.catch(() => {
    if (hosts.get(key) === entry) hosts.delete(key);
  });
  return entry;
}

async function attach(socket, request, remainder) {
  if (
    !request ||
    request.type !== "open" ||
    typeof request.cwd !== "string" ||
    typeof request.agentDir !== "string" ||
    typeof request.manifest !== "string"
  ) {
    openError(
      socket,
      "broker",
      "invalid_handshake",
      "invalid desktop broker handshake",
    );
    socket.end();
    return;
  }

  socket.pause();
  let disconnected = false;
  socket.once("close", () => {
    disconnected = true;
  });
  let expected;
  try {
    expected = expectedAgentDir(request.manifest);
  } catch (error) {
    openError(
      socket,
      "broker",
      "invalid_handshake",
      error instanceof Error ? error.message : String(error),
    );
    socket.end();
    return;
  }
  if (request.agentDir !== expected) {
    openError(
      socket,
      "broker",
      "invalid_handshake",
      "execution manifest does not match its runtime directory",
    );
    socket.end();
    return;
  }
  const key = `${request.cwd}\0${request.manifest}`;
  const entry = hostEntry(request.cwd, request.agentDir, request.manifest);
  try {
    const host = await entry.host;
    if (disconnected) return;
    const result = await host.attach({
      input: socket,
      output: socket,
      initialInput: remainder,
    });
    if (result.disposeRequested && hosts.get(key) === entry) {
      hosts.delete(key);
      await host.dispose();
    }
  } catch (error) {
    openError(
      socket,
      "runtime",
      error?.code ?? "host_start_failed",
      error instanceof Error ? error.message : String(error),
    );
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
      openError(
        socket,
        "broker",
        "invalid_handshake",
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
