#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const cwd = process.argv[2];
const encodedManifest = process.argv[3];
if (!cwd || !encodedManifest) {
  throw new Error("usage: cua-pi-tool-host <cwd> <required-tools-base64>");
}
const requiredTools = new Set(
  JSON.parse(Buffer.from(encodedManifest, "base64").toString("utf8")),
);

const protocolVersion = 2;
process.chdir(cwd);
if (process.platform === "win32") {
  const nodeDirectory = process.execPath.slice(
    0,
    Math.max(process.execPath.lastIndexOf("\\"), 0),
  );
  process.env.Path = `${nodeDirectory};${process.env.Path || ""}`;
} else {
  process.env.PATH = `/home/cua/.cargo/bin:${process.env.PATH || ""}`;
}

const npmRoot =
  process.platform === "win32"
    ? join(process.env.ProgramData || "C:\\ProgramData", "npm", "node_modules")
    : execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const pi = await import(
  pathToFileURL(
    join(npmRoot, "@earendil-works", "pi-coding-agent", "dist", "index.js"),
  ).href
);

// stdout is the protocol. Diagnostics belong on stderr.
console.log = (...values) => console.error(...values);
console.info = (...values) => console.error(...values);
console.warn = (...values) => console.error(...values);

const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await pi.createAgentSessionServices({
    cwd,
    resourceLoaderOptions: {
      extensionsOverride: (base) => ({
        ...base,
        extensions: base.extensions.filter((extension) =>
          [...extension.tools.keys()].some((name) => requiredTools.has(name)),
        ),
      }),
    },
  });
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
  agentDir: pi.getAgentDir(),
  sessionManager: pi.SessionManager.inMemory(cwd),
});
const session = runtime.session;
await session.bindExtensions({ mode: "rpc" });
session.setActiveToolsByName(session.getAllTools().map((tool) => tool.name));

const controllers = new Map();
const children = new Map();
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const tool = (name) =>
  session.agent.state.tools.find((candidate) => candidate.name === name);

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
    const input = selected.prepareArguments
      ? selected.prepareArguments(request.input)
      : request.input;
    const result = await selected.execute(
      request.id,
      input,
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
  });
  children.set(request.id, child);
  let timedOut = false;
  const timer = request.timeout
    ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
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
  controller.signal.addEventListener("abort", () => child.kill("SIGKILL"), {
    once: true,
  });
}

function handle(request) {
  if (
    !request ||
    typeof request !== "object" ||
    typeof request.type !== "string"
  )
    return;
  if (request.type === "execute") {
    void execute(request);
    return;
  }
  if (request.type === "bash") {
    bash(request);
    return;
  }
  if (request.type === "cancel" && typeof request.id === "string") {
    controllers.get(request.id)?.abort();
    children.get(request.id)?.kill("SIGKILL");
    return;
  }
  if (request.type === "shutdown") void shutdown();
}

const decoder = new StringDecoder("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      write({
        type: "protocol_error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
});
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const controller of controllers.values()) controller.abort();
  await runtime.dispose();
  process.exit(0);
}

process.stdin.on("end", () => void shutdown());

write({
  type: "ready",
  protocol: protocolVersion,
  tools: session.getAllTools().map((item) => {
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
  }),
});
