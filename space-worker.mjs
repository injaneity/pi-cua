import { Cua, CuaConfig, ProcessEventKind, ReplayMode, SpacesdCommand } from "@trycua/cua";
import { SpaceCreateOptions } from "@trycua/cua/spaces";

const cua = Cua.auto(CuaConfig.create({ fleetFromSession: true }));
const spaces = cua.spaces();
const clients = new Map();
const processes = new Map();
const requests = new Map();

const summary = (info, online, reason, os = info.os) => ({
  id: info.id,
  name: info.name,
  os,
  provider: info.provider,
  online,
  ...(reason ? { reason } : {}),
});

async function spacesd(id, signal) {
  if (!clients.has(id)) clients.set(id, spaces.space(id, { signal }).then((space) => space.spacesd()));
  try {
    return await clients.get(id);
  } catch (error) {
    clients.delete(id);
    throw error;
  }
}

const bytes = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);

function send(message) {
  if (process.connected) process.send(message);
}

async function pump(id, child) {
  try {
    for (;;) {
      const event = await child.nextEvent();
      if (!event) break;
      if (event.kind === ProcessEventKind.Exit) {
        send({
          type: "exit",
          process: id,
          code: event.exit?.code ?? null,
          signal: event.exit?.signal ?? null,
          timedOut: event.exit?.timedOut === true,
          error: event.exit?.error ?? null,
        });
        return;
      }
      send({
        type: "output",
        process: id,
        stream: event.kind === ProcessEventKind.Stderr ? "stderr" : "stdout",
        data: Buffer.from(event.data).toString("base64"),
      });
    }
    send({ type: "exit", process: id, code: null, signal: null, error: "process stream ended without an exit" });
  } catch (error) {
    send({ type: "exit", process: id, code: null, signal: null, error: error instanceof Error ? error.message : String(error) });
  } finally {
    processes.delete(id);
  }
}

async function dispatch({ method, args }, signal) {
  if (method === "list") {
    const listed = await spaces.list({ signal });
    return Promise.all(
      listed.map(async (info) => {
        try {
          const probe = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
          const capabilities = await (await spacesd(info.id, probe)).capabilities({ signal: probe });
          return summary(info, true, undefined, info.os || capabilities.osFamily);
        } catch (error) {
          return summary(info, false, error instanceof Error ? error.message : String(error));
        }
      }),
    );
  }
  if (method === "spawn") {
    const [space, spec, id] = args;
    const env = await spacesd(space, signal);
    const child = await env.spawn(
      SpacesdCommand.create({
        program: spec.program,
        args: spec.args,
        env: new Map(Object.entries(spec.env ?? {})),
        cwd: spec.cwd,
        tag: spec.tag,
        timeoutMs: spec.timeoutMs,
        stdin: spec.stdin === true,
      }),
      { signal },
    );
    processes.set(id, child);
    void pump(id, child);
    return id;
  }
  if (method === "write") {
    const [id, encoded] = args;
    await processes.get(id)?.writeStdin(bytes(Buffer.from(encoded, "base64")));
    return true;
  }
  if (method === "closeStdin") {
    await processes.get(args[0])?.closeStdin();
    return true;
  }
  if (method === "kill") {
    await processes.get(args[0])?.kill().catch(() => undefined);
    return true;
  }
  if (method === "killTag") {
    const [space, tag] = args;
    const env = await spacesd(space, signal);
    try {
      await (await env.attach(undefined, tag, ReplayMode.None.new())).kill();
    } catch {}
    return true;
  }
  if (method === "create") {
    const [options] = args;
    const result = await spaces.create(
      SpaceCreateOptions.create({
        on: options.on,
        name: options.name,
        cpus: options.cpus,
        memoryMb: options.memoryMb === undefined ? undefined : BigInt(options.memoryMb),
        wait: true,
        reuse: false,
        env: new Map(),
        services: new Map(),
      }),
      { signal },
    );
    if (!result.space) throw new Error("Space creation did not finish; check `cua spaces list`");
    return summary(result.space, true);
  }
  if (method === "delete") {
    await spaces.delete_(args[0], { signal });
    clients.delete(args[0]);
    return true;
  }
  throw new Error(`unknown Spaces operation: ${method}`);
}

process.on("message", async (message) => {
  if (message.method === "cancel") {
    requests.get(message.id)?.abort();
    return;
  }
  const controller = new AbortController();
  requests.set(message.id, controller);
  try {
    send({ id: message.id, result: await dispatch(message, controller.signal) });
  } catch (error) {
    send({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    requests.delete(message.id);
  }
});

process.once("disconnect", async () => {
  for (const request of requests.values()) request.abort();
  await Promise.allSettled([...processes.values()].map((child) => child.kill()));
  process.exit(0);
});
