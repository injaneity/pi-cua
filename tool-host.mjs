#!/usr/bin/env node

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

const protocolVersion = 3;
const maxProtocolLine = 1024 * 1024;

if (process.platform === "win32") {
  const nodeDirectory = process.execPath.slice(
    0,
    Math.max(process.execPath.lastIndexOf("\\"), 0),
  );
  process.env.Path = `${nodeDirectory};${process.env.Path || ""}`;
} else {
  process.env.PATH = `/home/cua/.cargo/bin:${process.env.PATH || ""}`;
}

const piRoot =
  process.platform === "win32"
    ? join(process.env.ProgramData || "C:\\ProgramData", "npm", "node_modules")
    : "/usr/local/lib/node_modules";
const pi = await import(
  pathToFileURL(
    join(piRoot, "@earendil-works", "pi-coding-agent", "dist", "index.js"),
  ).href
);

// stdout is the protocol. Diagnostics belong on stderr.
console.log = (...values) => console.error(...values);
console.info = (...values) => console.error(...values);
console.warn = (...values) => console.error(...values);

export async function createToolHost({ cwd, agentDir, encodedManifest }) {
  if (!cwd || !agentDir || !encodedManifest) {
    throw new Error("tool host requires cwd, agent directory, and manifest");
  }
  const decodedManifest = JSON.parse(
    Buffer.from(encodedManifest, "base64").toString("utf8"),
  );
  const tools = decodedManifest?.tools;
  const runtimeDigest = decodedManifest?.runtimeDigest;
  if (
    !Array.isArray(tools) ||
    tools.some((name) => typeof name !== "string") ||
    typeof runtimeDigest !== "string" ||
    !/^[0-9a-f]{20}$/.test(runtimeDigest)
  ) {
    throw new Error("tool host received an invalid execution manifest");
  }
  const requiredTools = new Set(tools);
  const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await pi.createAgentSessionServices({ cwd, agentDir });
    return {
      ...(await pi.createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const runtime = await pi.createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager: pi.SessionManager.inMemory(cwd),
  });
  const session = runtime.session;
  try {
    await session.bindExtensions({ mode: "rpc" });
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
  session.setActiveToolsByName(session.getAllTools().map((tool) => tool.name));
  const availableTools = new Set(
    session.getAllTools().map((tool) => tool.name),
  );
  const missingTools = [...requiredTools].filter(
    (name) => !availableTools.has(name),
  );
  if (missingTools.length > 0) {
    await runtime.dispose();
    const diagnostics = runtime.diagnostics
      .map((item) => item.message)
      .filter(Boolean)
      .join("; ");
    const error = new Error(
      `remote tool host is missing: ${missingTools.join(", ")}${diagnostics ? `; diagnostics: ${diagnostics}` : ""}`,
    );
    error.code = "ERR_CUA_MISSING_TOOLS";
    throw error;
  }

  const tool = (name) =>
    session.agent.state.tools.find((candidate) => candidate.name === name);
  const manifest = () =>
    session.getAllTools().map((item) => {
      const definition = session.getToolDefinition(item.name);
      const active = tool(item.name);
      return {
        name: item.name,
        label: active?.label ?? item.name,
        description: definition?.description ?? item.description,
        promptSnippet: definition?.promptSnippet,
        promptGuidelines: definition?.promptGuidelines,
        parameters: definition?.parameters ?? item.parameters,
        constrainedSampling: definition?.constrainedSampling,
        renderShell: definition?.renderShell,
        executionMode: definition?.executionMode,
      };
    });

  let activeDetach;
  let disposed = false;

  async function attach({ input, output, initialInput = Buffer.alloc(0) }) {
    if (disposed) throw new Error("remote tool host is disposed");
    if (activeDetach) throw new Error("remote tool host is already attached");

    const controllers = new Map();
    const children = new Map();
    const write = (message) => {
      if (output.writable) output.write(`${JSON.stringify(message)}\n`);
    };

    async function execute(request) {
      const selected = tool(request.tool);
      if (!selected) {
        write({
          type: "error",
          id: request.id,
          error: `remote tool not found: ${request.tool}`,
        });
        return;
      }
      const controller = new AbortController();
      controllers.set(request.id, controller);
      try {
        const prepared = selected.prepareArguments
          ? selected.prepareArguments(request.input)
          : request.input;
        const result = await selected.execute(
          request.id,
          prepared,
          controller.signal,
          (update) => write({ type: "update", id: request.id, update }),
        );
        write({ type: "result", id: request.id, result });
      } catch (error) {
        write({
          type: "error",
          id: request.id,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        controllers.delete(request.id);
      }
    }

    function killChildTree(child) {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn(
          "taskkill.exe",
          ["/PID", String(child.pid), "/T", "/F"],
          { stdio: "ignore", windowsHide: true },
        );
        killer.unref();
        return;
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }

    function bash(request) {
      const controller = new AbortController();
      controllers.set(request.id, controller);
      const windows = process.platform === "win32";
      const command = windows
        ? ["powershell.exe", ["-NoProfile", "-Command", request.command]]
        : ["/bin/bash", ["-lc", request.command]];
      const child = spawn(command[0], command[1], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: !windows,
      });
      children.set(request.id, child);
      let timedOut = false;
      const timer = request.timeout
        ? setTimeout(() => {
            timedOut = true;
            killChildTree(child);
          }, request.timeout * 1000)
        : undefined;
      const update = (data) =>
        write({
          type: "bash_update",
          id: request.id,
          data: Buffer.from(data).toString("base64"),
        });
      child.stdout.on("data", update);
      child.stderr.on("data", update);
      child.on("error", (error) => {
        if (timer) clearTimeout(timer);
        controllers.delete(request.id);
        children.delete(request.id);
        write({ type: "error", id: request.id, error: error.message });
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        controllers.delete(request.id);
        children.delete(request.id);
        write({
          type: "bash_result",
          id: request.id,
          exitCode: code,
          timedOut,
          aborted: controller.signal.aborted,
        });
      });
      controller.signal.addEventListener("abort", () => killChildTree(child), {
        once: true,
      });
    }

    let detached = false;
    let disposeRequested = false;
    let resolveDetached;
    const closed = new Promise((resolve) => {
      resolveDetached = resolve;
    });
    const detach = () => {
      if (detached) return;
      detached = true;
      input.off("data", onData);
      for (const controller of controllers.values()) controller.abort();
      resolveDetached();
    };
    activeDetach = detach;

    function handle(request) {
      if (
        !request ||
        typeof request !== "object" ||
        typeof request.type !== "string"
      )
        return;
      if (
        request.type === "execute" &&
        typeof request.id === "string" &&
        typeof request.tool === "string"
      ) {
        void execute(request);
        return;
      }
      if (
        request.type === "bash" &&
        typeof request.id === "string" &&
        typeof request.command === "string" &&
        (request.timeout === undefined ||
          (typeof request.timeout === "number" && request.timeout > 0))
      ) {
        bash(request);
        return;
      }
      if (request.type === "cancel" && typeof request.id === "string") {
        controllers.get(request.id)?.abort();
        const child = children.get(request.id);
        if (child) killChildTree(child);
        return;
      }
      if (request.type === "detach" || request.type === "shutdown") {
        disposeRequested = request.type === "shutdown";
        detach();
        return;
      }
      write({ type: "protocol_error", error: "invalid protocol request" });
    }

    const decoder = new StringDecoder("utf8");
    let buffer = Buffer.from(initialInput).toString("utf8");
    const onData = (chunk) => {
      buffer += decoder.write(chunk);
      if (buffer.length > maxProtocolLine && !buffer.includes("\n")) {
        write({
          type: "protocol_error",
          error: "protocol line limit exceeded",
        });
        detach();
        return;
      }
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        if (line.length > maxProtocolLine) {
          write({
            type: "protocol_error",
            error: "protocol line limit exceeded",
          });
          detach();
          return;
        }
        try {
          handle(JSON.parse(line));
        } catch (error) {
          write({
            type: "protocol_error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    input.on("data", onData);
    input.once("end", detach);
    input.once("close", detach);
    input.once("error", detach);
    write({
      type: "ready",
      protocol: protocolVersion,
      runtimeDigest,
      tools: manifest(),
    });
    onData(Buffer.alloc(0));
    input.resume?.();
    await closed;
    if (activeDetach === detach) activeDetach = undefined;
    return { disposeRequested };
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    activeDetach?.();
    await runtime.dispose();
  }

  return { attach, dispose };
}

const invokedDirectly =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const cwd = process.argv[2];
  const agentDir = process.argv[3];
  const encodedManifest = process.argv[4];
  if (!cwd || !agentDir || !encodedManifest) {
    throw new Error(
      "usage: cua-pi-tool-host <cwd> <agent-dir> <execution-manifest-base64>",
    );
  }
  const host = await createToolHost({ cwd, agentDir, encodedManifest });
  await host.attach({ input: process.stdin, output: process.stdout });
  await host.dispose();
}
