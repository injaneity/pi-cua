#!/usr/bin/env node

import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = dirname(fileURLToPath(import.meta.url));
const homeDir = dirname(dirname(agentDir));
const hostScript = join(agentDir, "cua-tool-host.mjs");
const token = readFileSync(
  join(agentDir, "cua-tool-broker.token"),
  "utf8",
).trim();
const port = Number(process.env.CUA_PI_TOOL_BROKER_PORT || "43121");

function validToken(candidate) {
  if (typeof candidate !== "string") return false;
  const actual = Buffer.from(token);
  const supplied = Buffer.from(candidate);
  return actual.length === supplied.length && timingSafeEqual(actual, supplied);
}

function diagnostic(socket, text) {
  if (!socket.destroyed) {
    socket.write(`${JSON.stringify({ type: "diagnostic", data: text })}\n`);
  }
}

function attach(socket, request, remainder) {
  if (
    !request ||
    request.type !== "open" ||
    !validToken(request.token) ||
    typeof request.cwd !== "string" ||
    typeof request.manifest !== "string"
  ) {
    diagnostic(socket, "invalid desktop broker handshake");
    socket.end();
    return;
  }
  const child = spawn(
    process.execPath,
    [hostScript, request.cwd, request.manifest],
    {
      cwd: request.cwd,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        PI_CODING_AGENT_DIR: agentDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  if (remainder.length > 0) child.stdin.write(remainder);
  socket.pipe(child.stdin);
  child.stdout.pipe(socket, { end: false });
  child.stderr.on("data", (chunk) => diagnostic(socket, chunk.toString()));
  child.on("error", (error) => diagnostic(socket, error.message));
  child.on("close", () => socket.end());
  socket.on("close", () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    timer.unref();
  });
}

const server = createServer((socket) => {
  socket.setNoDelay(true);
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
      attach(socket, JSON.parse(line), remainder);
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
