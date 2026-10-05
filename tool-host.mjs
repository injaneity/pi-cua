#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { constants } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";

const protocolVersion = 5;
const maxLine = 64 * 1024 * 1024;

const home = process.env.HOME || "/tmp";
process.env.PATH = `${join(home, ".cargo", "bin")}:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || ""}`;
process.env.npm_config_cache = join(home, ".cua-pi", "npm-cache");

const protocolOut = process.stdout;
console.log = (...values) => console.error(...values);
console.info = (...values) => console.error(...values);
console.warn = (...values) => console.error(...values);

export async function createToolHost({ cwd, agentDir, piRoot, encodedManifest }) {
  if (!cwd || !agentDir || !piRoot || !encodedManifest)
    throw new Error("tool host requires cwd, agent directory, Pi root, and manifest");
  const pi = await import(
    pathToFileURL(join(piRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const manifest = JSON.parse(Buffer.from(encodedManifest, "base64").toString("utf8"));
  if (
    !Array.isArray(manifest?.tools) ||
    manifest.tools.some((name) => typeof name !== "string") ||
    typeof manifest.runtimeDigest !== "string" ||
    !/^[0-9a-f]{20}$/.test(manifest.runtimeDigest)
  )
    throw new Error("tool host received an invalid execution manifest");
  const runtime = await pi.createAgentSessionRuntime(
    async ({ cwd, sessionManager, sessionStartEvent }) => {
      const services = await pi.createAgentSessionServices({ cwd, agentDir });
      return {
        ...(await pi.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
        services,
        diagnostics: services.diagnostics,
      };
    },
    { cwd, agentDir, sessionManager: pi.SessionManager.inMemory(cwd) },
  );
  const session = runtime.session;
  try {
    await session.bindExtensions({ mode: "rpc" });
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
  session.setActiveToolsByName(session.getAllTools().map((tool) => tool.name));
  const available = new Set(session.getAllTools().map((tool) => tool.name));
  const missing = manifest.tools.filter((name) => !available.has(name));
  if (missing.length > 0) {
    await runtime.dispose();
    const diagnostics = runtime.diagnostics.map((item) => item.message).filter(Boolean).join("; ");
    throw new Error(`remote tool host is missing: ${missing.join(", ")}${diagnostics ? `; diagnostics: ${diagnostics}` : ""}`);
  }

  const tool = (name) => session.agent.state.tools.find((candidate) => candidate.name === name);
  const describe = () => ({
    type: "ready",
    protocol: protocolVersion,
    runtimeDigest: manifest.runtimeDigest,
    tools: session.getAllTools().map((item) => {
      const definition = session.getToolDefinition(item.name);
      return {
        name: item.name,
        sourceInfo: item.sourceInfo,
        label: tool(item.name)?.label ?? item.name,
        description: definition?.description ?? item.description,
        promptSnippet: definition?.promptSnippet,
        promptGuidelines: definition?.promptGuidelines,
        parameters: definition?.parameters ?? item.parameters,
        constrainedSampling: definition?.constrainedSampling,
        renderShell: definition?.renderShell,
        executionMode: definition?.executionMode,
      };
    }),
  });

  const controllers = new Map();

  async function execute(request, write) {
    const selected = tool(request.tool);
    if (!selected) return write({ type: "error", id: request.id, error: `remote tool not found: ${request.tool}` });
    const controller = new AbortController();
    controllers.set(request.id, controller);
    try {
      const prepared = selected.prepareArguments ? selected.prepareArguments(request.input) : request.input;
      const result = await selected.execute(request.id, prepared, controller.signal, (update) =>
        write({ type: "update", id: request.id, update }),
      );
      write({ type: "result", id: request.id, result });
    } catch (error) {
      write({ type: "error", id: request.id, error: error instanceof Error ? error.message : String(error) });
    } finally {
      controllers.delete(request.id);
    }
  }

  function bash(request, write) {
    const controller = new AbortController();
    controllers.set(request.id, controller);
    const child = spawn("/bin/bash", ["-lc", request.command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    controller.signal.addEventListener("abort", kill, { once: true });
    let timedOut = false;
    const timer = request.timeout
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, request.timeout * 1000)
      : undefined;
    const update = (data) => write({ type: "bash_update", id: request.id, data: Buffer.from(data).toString("base64") });
    child.stdout.on("data", update);
    child.stderr.on("data", update);
    return new Promise((resolve) => {
      let spawnError;
      child.on("error", (error) => {
        spawnError = error;
      });
      child.on("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        controllers.delete(request.id);
        if (spawnError) write({ type: "error", id: request.id, error: spawnError.message });
        else
          write({
            type: "bash_result",
            id: request.id,
            exitCode: code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1),
            timedOut,
            aborted: controller.signal.aborted,
          });
        resolve();
      });
    });
  }

  return {
    describe,
    execute,
    bash,
    cancel: (id) => controllers.get(id)?.abort(),
    dispose: async () => {
      for (const controller of controllers.values()) controller.abort();
      await runtime.dispose();
    },
  };
}

export async function serve(options, input = process.stdin, output = protocolOut) {
  const write = (message) => {
    if (output.writable) output.write(`${JSON.stringify(message)}\n`);
  };
  let host;
  try {
    host = await createToolHost(options);
  } catch (error) {
    write({ type: "open_error", error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const inflight = new Set();
  const track = (operation) => {
    inflight.add(operation);
    void operation.finally(() => inflight.delete(operation));
  };
  write(host.describe());
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  await new Promise((done) => {
    input.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      if (buffer.length > maxLine && !buffer.includes("\n")) {
        write({ type: "protocol_error", error: "protocol line limit exceeded" });
        done();
        return;
      }
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let request;
        try {
          request = JSON.parse(line);
        } catch (error) {
          write({ type: "protocol_error", error: error instanceof Error ? error.message : String(error) });
          continue;
        }
        if (request?.type === "execute" && typeof request.id === "string" && typeof request.tool === "string")
          track(host.execute(request, write));
        else if (
          request?.type === "bash" &&
          typeof request.id === "string" &&
          typeof request.command === "string" &&
          (request.timeout === undefined || (typeof request.timeout === "number" && request.timeout > 0))
        )
          track(host.bash(request, write));
        else if (request?.type === "cancel" && typeof request.id === "string") host.cancel(request.id);
        else write({ type: "protocol_error", error: "invalid protocol request" });
      }
    });
    input.once("end", done);
    input.once("close", done);
  });
  await host.dispose();
  await Promise.allSettled([...inflight]);
}

const invokedDirectly =
  process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const [, , cwd, agentDir, piRoot, encodedManifest] = process.argv;
  if (!cwd || !agentDir || !piRoot || !encodedManifest)
    throw new Error("usage: cua-tool-host <cwd> <agent-dir> <pi-root> <manifest-base64>");
  await serve({ cwd, agentDir, piRoot, encodedManifest });
  process.exit(0);
}
