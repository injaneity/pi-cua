#!/usr/bin/env node

import { fork } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = dirname(fileURLToPath(import.meta.url));
const homeDir = process.env.CUA_PI_HOME || dirname(dirname(agentDir));
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;
process.env.PI_CODING_AGENT_DIR = agentDir;

const port = Number(process.env.CUA_PI_TOOL_BROKER_PORT || "43121");
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

function hostEntry(cwd, agentDir, manifest) {
  const key = `${cwd}\0${manifest}`;
  const current = hosts.get(key);
  if (current) return current;
  const child = fork(
    join(agentDir, "cua-tool-host.mjs"),
    [cwd, agentDir, manifest],
    {
      cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let diagnostics = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-16384);
    });
  let attached = false;
  const host = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("tool host initialization timed out"));
    }, 120000);
    const fail = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    child.once("error", fail);
    child.once("exit", (code) =>
      fail(new Error(`tool host exited ${code}: ${diagnostics}`)),
    );
    const initialized = (message) => {
      if (message.type === "failure") {
        fail(Object.assign(new Error(message.error), { code: message.code }));
        return;
      }
      if (message.type !== "initialized") return;
      clearTimeout(timer);
      child.off("message", initialized);
      resolve({
        attach({ input, output, initialInput }) {
          if (attached)
            return Promise.reject(
              new Error("remote tool host is already attached"),
            );
          attached = true;
          return new Promise((resolve, reject) => {
            let ended = false;
            let settled = false;
            const finish = (error, result) => {
              if (settled) return;
              settled = true;
              attached = false;
              input.off("data", data);
              input.off("end", end);
              input.off("close", end);
              child.off("message", message);
              child.off("exit", exit);
              if (error) reject(error);
              else resolve(result);
            };
            const send = (message) =>
              child.send(message, (error) => {
                if (error) finish(error);
              });
            const data = (chunk) =>
              send({ type: "input", data: chunk.toString("base64") });
            const end = () => {
              if (!ended) {
                ended = true;
                send({ type: "end" });
              }
            };
            const exit = (code) =>
              finish(new Error(`tool host exited ${code}: ${diagnostics}`));
            const message = (value) => {
              if (value.type === "data" && !output.destroyed)
                output.write(Buffer.from(value.data, "base64"));
              else if (value.type === "detached")
                finish(undefined, value.result);
              else if (value.type === "failure")
                finish(
                  Object.assign(new Error(value.error), { code: value.code }),
                );
            };
            child.on("message", message);
            child.once("exit", exit);
            input.on("data", data);
            input.once("end", end);
            input.once("close", end);
            send({
              type: "attach",
              initialInput: initialInput.toString("base64"),
            });
            input.resume();
            if (input.destroyed || input.readableEnded) end();
          });
        },
        dispose() {
          return new Promise((resolve) => {
            if (!child.connected) {
              resolve();
              return;
            }
            const timer = setTimeout(() => child.kill(), 5000);
            child.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
            child.send({ type: "dispose" }, (error) => {
              if (error) child.kill();
            });
          });
        },
      });
    };
    child.on("message", initialized);
  });
  const entry = { host };
  hosts.set(key, entry);
  const remove = () => {
    if (hosts.get(key) === entry) hosts.delete(key);
  };
  child.once("exit", remove);
  host.catch(remove);
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
