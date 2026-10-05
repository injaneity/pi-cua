import {
  type BashOperations,
  createEditTool,
  createReadTool,
  createWriteTool,
  type EditToolInput,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  getPackageDir,
  type ReadToolInput,
  SessionManager,
  VERSION,
  type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Editor, Key, matchesKey, SelectList, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRuntime, type Runtime } from "./config.ts";
import type { Remote } from "./remote.ts";
import { ensurePi, ensureRuntime, hostFiles, probe, RemoteHost } from "./setup.ts";
import { isSpaceOS, type SpaceItem, type SpaceOS, type SpacesClient, WorkerSpacesClient } from "./spaces.ts";
import {
  cleanupWorkspace,
  diffStatus,
  executionDigest,
  executionDirectory,
  inspectWorkspace,
  parseWorkspaceState,
  prepareWorkspace,
  type SpaceWorkspace,
  syncToLocal,
  type Timings,
  type WorkspaceState,
  workspaceExists,
} from "./workspace.ts";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const placementEntry = "cua-space-placement";
const localTools = new Set(["enter_space", "report_papercut", "web_search"]);

type SpacePlace = {
  kind: "space";
  spaceId: string;
  name: string;
  os: SpaceOS;
  machineId: string;
  executionId: string;
  localCwd: string;
  remoteCwd: string;
  workspaceRoot?: string;
  workspaceState?: WorkspaceState;
};
type Place = { kind: "local" } | SpacePlace;
type Attachment = {
  place: SpacePlace;
  remote: Remote;
  host: RemoteHost;
  runtime: Runtime;
  runtimeRoot: string;
};
type UIContext = ExtensionContext | ExtensionCommandContext;
type ToolWithSource = ReturnType<ExtensionAPI["getAllTools"]>[number];
type Routes = Readonly<{
  tools: readonly string[];
  unavailable: ReadonlyMap<string, string>;
  packages: readonly string[];
  files: readonly string[];
  skills: readonly string[];
  definitions: readonly ToolWithSource[];
}>;
type Mode = "enter" | "resume" | "inherit";

function latestEntryData(entries: Array<{ type: string; customType?: string; data?: unknown }>, customType: string): unknown {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type === "custom" && entry.customType === customType) return entry.data;
  }
  return undefined;
}

function parsePlace(value: unknown): Place | undefined {
  if (value === undefined || value === null) return undefined;
  const data = value as Record<string, unknown>;
  if (typeof value !== "object") throw new Error("saved Space placement is invalid");
  if (data.kind === "local") return { kind: "local" };
  if (
    data.kind !== "space" ||
    typeof data.spaceId !== "string" ||
    typeof data.name !== "string" ||
    !isSpaceOS(data.os) ||
    typeof data.machineId !== "string" ||
    typeof data.executionId !== "string" ||
    typeof data.localCwd !== "string" ||
    typeof data.remoteCwd !== "string" ||
    (data.workspaceRoot !== undefined && typeof data.workspaceRoot !== "string")
  )
    throw new Error("saved Space placement is invalid");
  return {
    kind: "space",
    spaceId: data.spaceId,
    name: data.name,
    os: data.os,
    machineId: data.machineId,
    executionId: data.executionId,
    localCwd: data.localCwd,
    remoteCwd: data.remoteCwd,
    workspaceRoot: data.workspaceRoot as string | undefined,
    workspaceState: parseWorkspaceState(data.workspaceState),
  };
}

function packageRoot(path: string, packageName?: string): string | undefined {
  let current = dirname(path);
  for (;;) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      if (!packageName) return current;
      try {
        if ((JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name === packageName) return current;
      } catch {}
    }
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) return undefined;
    current = parent;
  }
}

function immutablePackageSource(tool: ToolWithSource): string {
  const source = tool.sourceInfo.source;
  if (source.startsWith("npm:")) {
    const match = source.match(/^npm:(@[^/]+\/[^@]+|[^@]+)(?:@.+)?$/);
    if (!match) throw new Error(`unsupported npm tool package: ${source}`);
    const root = packageRoot(tool.sourceInfo.path, match[1]);
    if (!root) throw new Error(`cannot locate installed tool package: ${source}`);
    const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown }).version;
    if (typeof version !== "string" || !version) throw new Error(`tool package has no version: ${source}`);
    return `npm:${match[1]}@${version}`;
  }
  const root = packageRoot(tool.sourceInfo.path);
  if (!root) throw new Error(`cannot locate installed tool package: ${source}`);
  const revision = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  const commit = revision.stdout.trim();
  if (revision.status !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`cannot resolve tool package revision: ${source}`);
  const marker = source.lastIndexOf("@");
  const pathStart = Math.max(source.lastIndexOf("/"), source.lastIndexOf(":"));
  return `${marker > pathStart ? source.slice(0, marker) : source}@${commit}`;
}

const remoteSource = (source: string) => ["git:", "npm:", "https://", "http://", "ssh://"].some((prefix) => source.startsWith(prefix));

function isControllerFile(toolName: string, input: unknown): input is ReadToolInput {
  if (!["read", "edit", "write"].includes(toolName) || input === null || typeof input !== "object") return false;
  const path = (input as { path?: unknown }).path;
  if (typeof path !== "string") return false;
  if (
    toolName === "read" &&
    /^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T\/pi-clipboard-[^/]+\.(?:png|jpe?g|gif|webp|bmp)$/i.test(path)
  )
    return true;
  const normalized = posix.normalize((path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path).replaceAll("\\", "/"));
  const papercuts = `${posix.normalize(getAgentDir().replaceAll("\\", "/"))}/papercuts/`;
  if (normalized.startsWith(papercuts) && /^[a-z0-9._-]+-[a-f0-9]{12}\/papercuts\.md$/.test(normalized.slice(papercuts.length)))
    return true;
  if (toolName !== "read") return false;
  const temporary = `${posix.normalize(tmpdir().replaceAll("\\", "/"))}/`;
  return normalized.startsWith(temporary) && /^pi-exa-search-[a-zA-Z0-9]+\/results\.txt$/.test(normalized.slice(temporary.length));
}

function mapConfigInput(name: string, input: unknown, paths: Record<string, string>, agentRoot: string): { input: unknown; path?: string } {
  if (!input || typeof input !== "object" || !("path" in input) || typeof input.path !== "string") return { input };
  const raw = input.path.startsWith("~/") ? `${homedir()}/${input.path.slice(2)}` : input.path;
  const path = posix.normalize(raw.replaceAll("\\", "/"));
  for (const [source, destination] of Object.entries(paths).sort(([a], [b]) => b.length - a.length)) {
    if (path !== source && !path.startsWith(`${source}/`)) continue;
    if (["write", "edit"].includes(name))
      throw new Error("Pi configuration snapshots are read-only; edit configuration locally and re-enter the Space");
    if (!["read", "find", "grep", "fffind", "ffgrep"].includes(name)) return { input };
    if (destination.startsWith("/") || destination.split("/").includes("..")) throw new Error("invalid remote configuration mapping");
    const mapped = `${agentRoot}/${destination}${path.slice(source.length)}`;
    return { input: { ...input, path: mapped }, path: mapped };
  }
  return { input };
}

function label(place: Place): string {
  return place.kind === "space"
    ? `${place.name} (${place.os})`
    : `local (${process.platform === "darwin" ? "macos" : process.platform})`;
}

export default function cuaSpaces(pi: ExtensionAPI): void {
  let client: SpacesClient | undefined;
  let target: Place = { kind: "local" };
  let attachment: Attachment | undefined;
  let placementError: Error | undefined;
  let routeCatalog: Routes | undefined;
  let runtimeCache: { key: string; runtime: Runtime } | undefined;
  let entering = false;
  let mixedBatch = false;
  let closed = false;
  let diffGeneration = 0;

  const spaces = () => (client ??= new WorkerSpacesClient());

  function emitTarget(value: Record<string, unknown>): void {
    if (!closed) pi.events.emit("cua:execution-target-changed", value);
  }

  function emitPlace(place: Place): void {
    emitTarget(place.kind === "space" ? { kind: "sandbox", name: place.name, os: place.os } : { kind: "local" });
  }

  function progress(ctx: UIContext, name: string, phase?: string, message?: string): void {
    if (closed) return;
    const activity = phase?.startsWith("workspace.") ? "syncing workspace" : phase?.startsWith("setup.") ? "setting up" : "connecting";
    const detail = message && !["started", "completed"].includes(message) ? ` • ${message}` : "";
    ctx.ui.setStatus("cua-session", `${name} (${activity})${detail}`);
    emitTarget({ kind: "sandbox", name, state: "connecting", phase, message });
  }

  async function listSpaces(signal?: AbortSignal): Promise<SpaceItem[]> {
    const items = await spaces().list(signal);
    pi.events.emit("cua:sandboxes-changed", {
      sandboxes: items.map((item) => ({ name: item.name, os: item.os, online: item.online })),
    });
    return items;
  }

  pi.events.on("cua:sandboxes-requested", () => {
    void listSpaces().catch(() => undefined);
  });

  function routes(): Routes {
    if (routeCatalog) return routeCatalog;
    const packages = new Set<string>();
    const files = new Set<string>();
    const unavailable = new Map<string, string>();
    const definitions: ToolWithSource[] = [];
    for (const tool of pi.getAllTools()) {
      if (localTools.has(tool.name)) continue;
      const info = tool.sourceInfo;
      if (info.origin === "package" && info.scope === "user") {
        if (!remoteSource(info.source)) {
          unavailable.set(tool.name, `${tool.name} comes from the local package ${info.source}, which pi-cua cannot install on a Space`);
          continue;
        }
        if (!info.source.toLowerCase().includes("pi-cua")) packages.add(immutablePackageSource(tool));
      }
      if (info.origin === "top-level" && info.scope === "user") files.add(info.path);
      definitions.push(tool);
    }
    routeCatalog = Object.freeze({
      tools: Object.freeze(definitions.map((tool) => tool.name)),
      unavailable,
      packages: Object.freeze([...packages]),
      files: Object.freeze([...files]),
      skills: Object.freeze(pi.getCommands().filter((command) => command.source === "skill").map((command) => command.sourceInfo.path)),
      definitions: Object.freeze(definitions),
    });
    return routeCatalog;
  }

  function runtimeFor(ctx: UIContext, localCwd: string): Runtime {
    const catalog = routes();
    const projectDir = ctx.isProjectTrusted?.() === true ? localCwd : undefined;
    const key = JSON.stringify([catalog.packages, catalog.files, catalog.skills, projectDir]);
    if (runtimeCache?.key !== key)
      runtimeCache = {
        key,
        runtime: buildRuntime({
          agentDir: getAgentDir(),
          piVersion: VERSION,
          packages: catalog.packages,
          toolFiles: catalog.files,
          skillFiles: catalog.skills,
          hostFiles: hostFiles(),
          documentationRoot: getPackageDir(),
          projectDir,
        }),
      };
    return runtimeCache.runtime;
  }

  function savePlace(place: Place): void {
    pi.appendEntry(placementEntry, place);
  }

  function workspaceOf(active: Attachment): SpaceWorkspace | undefined {
    const { place } = active;
    return place.workspaceRoot && place.workspaceState
      ? { remote: active.remote, root: place.workspaceRoot, state: place.workspaceState }
      : undefined;
  }

  async function resolveSpace(spaceId: string, signal?: AbortSignal): Promise<SpaceItem> {
    const item = (await listSpaces(signal)).find((candidate) => candidate.id === spaceId);
    if (!item) throw new Error(`Space ${spaceId} is no longer registered; choose another Space with /space`);
    if (!item.online)
      throw new Error(`${item.name} is offline${item.reason ? ` (${item.reason})` : ""}; bring it back online or choose another Space with /space`);
    return item;
  }

  async function attach(
    space: SpaceItem,
    ctx: UIContext,
    mode: Mode,
    options: { saved?: SpacePlace; source?: Attachment; parent?: SpacePlace } = {},
  ): Promise<Attachment> {
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(ctx.signal ? [ctx.signal] : [])]);
    const timings: Timings = {};
    const report = (phase: string, message: string) => progress(ctx, space.name, phase, message);
    report("connect", "checking the Space");
    const { remote, probe: probed } = await probe(spaces(), space, signal);
    const saved = options.saved ?? options.parent;
    if (saved && saved.machineId !== probed.machineId)
      throw new Error(
        `${space.name} is a different machine than the one this session used; pi-cua will not substitute it. Choose a Space with /space`,
      );
    const localCwd = options.saved?.localCwd ?? options.parent?.localCwd ?? options.source?.place.localCwd ?? ctx.cwd;
    const executionId =
      mode === "inherit"
        ? ctx.sessionManager.getSessionId()
        : (options.saved?.executionId ?? options.source?.place.executionId ?? ctx.sessionManager.getSessionId());
    const runtime = runtimeFor(ctx, localCwd);
    report("setup.pi", `pi ${VERSION}`);
    const piRoot = await ensurePi(remote, VERSION, signal);
    report("setup.runtime", runtime.hash);
    const runtimeRoot = await ensureRuntime(remote, runtime, piRoot, signal);

    let place: SpacePlace = {
      kind: "space",
      spaceId: space.id,
      name: space.name,
      os: remote.os,
      machineId: probed.machineId,
      executionId,
      localCwd,
      remoteCwd: "",
    };
    const sameMachine = options.source?.place.machineId === probed.machineId;
    if (mode === "resume" && options.saved) {
      const kept = options.saved;
      const present = kept.workspaceRoot ? await workspaceExists(remote, kept.workspaceRoot, kept.remoteCwd, signal) : true;
      if (present) place = { ...place, remoteCwd: kept.remoteCwd, workspaceRoot: kept.workspaceRoot, workspaceState: kept.workspaceState };
    } else if (sameMachine && options.source) {
      const kept = options.source.place;
      place = { ...place, remoteCwd: kept.remoteCwd, workspaceRoot: kept.workspaceRoot, workspaceState: kept.workspaceState };
    }
    if (!place.remoteCwd) {
      const repository = inspectWorkspace(localCwd);
      const parent = options.parent;
      const parentWorkspace =
        parent?.workspaceRoot &&
        parent.workspaceState &&
        (await workspaceExists(remote, parent.workspaceRoot, parent.remoteCwd, signal))
          ? { remote, root: parent.workspaceRoot, state: parent.workspaceState }
          : undefined;
      const source = mode === "inherit" ? parentWorkspace : options.source && workspaceOf(options.source);
      if (repository) {
        const prepared = await prepareWorkspace(remote, executionId, repository, source, timings, report, signal);
        place = { ...place, remoteCwd: prepared.cwd, workspaceRoot: prepared.root, workspaceState: prepared.state };
      } else if (source || options.saved?.workspaceState || parent?.workspaceState) {
        throw new Error("this session's Git workspace is no longer available locally");
      } else place = { ...place, remoteCwd: await executionDirectory(remote, executionId, signal) };
    }
    report("connect.tools", "starting the tool host");
    const host = new RemoteHost(
      remote,
      executionDigest(place.executionId).slice(0, 16),
      runtime.hash,
      runtimeRoot,
      piRoot,
      place.remoteCwd,
      routes().tools,
    );
    await host.ensure(signal);
    if (Object.keys(timings).length) pi.appendEntry("cua-entry-timing", { name: space.name, timings });
    return { place, remote, host, runtime, runtimeRoot };
  }

  function installProxies(next: Attachment): void {
    const active = pi.getActiveTools();
    const definitions = routes().definitions.map((info) => {
      const remote = next.host.definition(info.name);
      if (!remote) throw new Error(`remote tool metadata missing: ${info.name}`);
      if (
        remote.sourceInfo?.origin !== info.sourceInfo.origin ||
        (info.sourceInfo.origin === "package" && remote.sourceInfo?.source !== immutablePackageSource(info))
      )
        throw new Error(
          `remote tool provider mismatch for ${info.name}; expected ${info.sourceInfo.source}, got ${remote.sourceInfo?.source ?? "unknown"}`,
        );
      return { info, remote };
    });
    for (const { info, remote } of definitions) {
      pi.registerTool({
        ...(remote as any),
        async execute(id: string, input: unknown, signal: AbortSignal | undefined, onUpdate: any, toolCtx: ExtensionContext) {
          if (isControllerFile(info.name, input)) {
            const result =
              info.name === "edit"
                ? await createEditTool(toolCtx.cwd).execute(id, input as EditToolInput, signal, onUpdate)
                : info.name === "write"
                  ? await createWriteTool(toolCtx.cwd).execute(id, input as WriteToolInput, signal, onUpdate)
                  : await createReadTool(toolCtx.cwd).execute(id, input, signal, onUpdate);
            result.content.unshift({
              type: "text",
              text: input.path.endsWith("papercuts.md")
                ? `live controller papercut ledger: ${input.path}. This is shared across Space switches, not a Space file.`
                : `controller file: ${input.path}. This is not a Space file.`,
            });
            return result;
          }
          const current = attachment;
          if (!current || target.kind !== "space") throw new Error("Space placement changed before dispatch");
          const mapped = mapConfigInput(info.name, input, current.runtime.paths, `${current.runtimeRoot}/agent`);
          const result = await current.host.execute(info.name, id, mapped.input, signal, onUpdate);
          if (mapped.path) result.content.unshift({ type: "text", text: `resource path in this environment: ${mapped.path}` });
          return result;
        },
      });
    }
    for (const { info } of definitions) {
      const effective = pi.getAllTools().find((tool) => tool.name === info.name);
      if (effective?.sourceInfo.path !== join(extensionDir, "index.ts")) {
        placementError = new Error(`another extension overrides ${info.name}; load pi-cua after other tool packages, then run /reload`);
        throw placementError;
      }
    }
    pi.setActiveTools(active);
  }

  function route(next: Attachment | undefined, ctx: UIContext, options: { announce?: boolean } = {}): void {
    if (closed) throw new Error("extension runtime was replaced while entering the Space");
    if (next) installProxies(next);
    placementError = undefined;
    const previous = target;
    target = next ? next.place : { kind: "local" };
    attachment = next;
    savePlace(target);
    ctx.ui.setStatus("cua-session", undefined);
    emitPlace(target);
    if (options.announce !== false && label(previous) !== label(target))
      pi.sendMessage(
        {
          customType: "cua-execution-switch",
          content: `execution switched: ${label(previous)} → ${label(target)}. subsequent workspace tools use the destination environment.`,
          display: true,
          details: { from: label(previous), to: label(target) },
        },
        { triggerTurn: false },
      );
    void refreshDiff();
  }

  async function retire(previous: Attachment | undefined, next: Attachment | undefined, ctx: UIContext): Promise<void> {
    if (!previous) return;
    const sameExecution =
      next?.place.machineId === previous.place.machineId && next.place.workspaceRoot === previous.place.workspaceRoot;
    if (sameExecution) return;
    await previous.host.shutdown().catch(() => undefined);
    const workspace = workspaceOf(previous);
    if (!workspace) return;
    try {
      await cleanupWorkspace(workspace);
    } catch (error) {
      ctx.ui.notify(`workspace cleanup failed on ${previous.place.name}: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }

  async function enter(space: SpaceItem, ctx: UIContext): Promise<void> {
    if (entering) throw new Error("another Space entry is in progress");
    entering = true;
    try {
      let previous = attachment;
      const current = previous?.place ?? (target.kind === "space" ? target : undefined);
      if (current?.spaceId === space.id) {
        const next = await attach(space, ctx, "resume", { saved: current });
        route(next, ctx);
        return;
      }
      if (current && !previous) {
        try {
          previous = await attach(await resolveSpace(current.spaceId, ctx.signal), ctx, "resume", { saved: current });
        } catch (error) {
          throw new Error(
            `cannot reach ${current.name} to move this session's workspace from it (${error instanceof Error ? error.message : String(error)}); reconnect with /space ${current.name} or leave it with /space local`,
          );
        }
      }
      const next = await attach(space, ctx, "enter", { source: previous });
      route(next, ctx);
      await retire(previous, next, ctx);
    } catch (error) {
      if (!closed) {
        ctx.ui.setStatus("cua-session", undefined);
        emitPlace(target);
      }
      throw error;
    } finally {
      entering = false;
    }
  }

  async function enterLocal(ctx: ExtensionCommandContext): Promise<void> {
    if (entering) throw new Error("another Space entry is in progress");
    entering = true;
    try {
      let previous = attachment;
      if (!previous && target.kind === "space") {
        const stranded = target;
        try {
          previous = await attach(await resolveSpace(stranded.spaceId, ctx.signal), ctx, "resume", { saved: stranded });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const abandon =
            ctx.hasUI &&
            (await ctx.ui.confirm(
              `leave ${stranded.name} without syncing?`,
              `${reason}\nIts workspace stays on the Space and is not copied to your local checkout.`,
            ));
          if (!abandon) throw error;
        }
      }
      const workspace = previous && workspaceOf(previous);
      if (previous && workspace) {
        progress(ctx, previous.place.name, "workspace.local", "syncing Space changes to local");
        await syncToLocal(workspace, previous.place.localCwd, (phase, message) => progress(ctx, previous.place.name, phase, message), ctx.signal);
      }
      route(undefined, ctx);
      await retire(previous, undefined, ctx);
    } finally {
      entering = false;
      if (!closed) ctx.ui.setStatus("cua-session", undefined);
    }
    await ctx.reload();
  }

  async function createSpace(args: string, ctx: UIContext): Promise<SpaceItem | undefined> {
    const match = args.match(/^(local|cloud)(?:\s+([a-z0-9][a-z0-9-]*))?(?:\s+([1-9]\d*)\s+([1-9]\d*))?$/);
    if (!match) throw new Error("usage: /space create <local|cloud> [name] [cpus memory_mb]");
    const [, on, name, cpus, memory] = match;
    if (!ctx.hasUI) throw new Error("creating a Space needs an interactive session");
    const confirmed = await ctx.ui.confirm(
      `create a ${on} Space${name ? ` named ${name}` : ""}?`,
      [
        cpus ? `${cpus} CPUs and ${memory} MiB of memory.` : "default resources.",
        on === "cloud" ? "this incurs cost." : "this runs on this machine.",
      ].join("\n"),
    );
    if (!confirmed) return undefined;
    progress(ctx, name ?? `${on} Space`, "create", "creating");
    try {
      return await spaces().create(
        { on: on as "local" | "cloud", name, cpus: cpus ? Number(cpus) : undefined, memoryMb: memory ? Number(memory) : undefined },
        ctx.signal,
      );
    } finally {
      ctx.ui.setStatus("cua-session", undefined);
      void listSpaces().catch(() => undefined);
    }
  }

  async function deleteSpace(name: string, ctx: UIContext): Promise<void> {
    const item = (await listSpaces(ctx.signal)).find((candidate) => candidate.name === name || candidate.id === name);
    if (!item) throw new Error(`unknown Space: ${name}`);
    if (target.kind === "space" && target.spaceId === item.id)
      throw new Error(`move this session off ${item.name} with /space local before deleting it`);
    if (!ctx.hasUI || !(await ctx.ui.confirm(`delete ${item.name}?`, "this permanently removes the Space and its files.")))
      return;
    await spaces().remove(item.id, ctx.signal);
    void listSpaces().catch(() => undefined);
    ctx.ui.notify(`deleted ${item.name}`, "info");
  }

  async function search(ctx: UIContext, options: Array<{ value: string; label: string; description?: string; create?: boolean }>): Promise<string | undefined> {
    const input =
      ctx.mode === "tui"
        ? await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
            const createLabels = options.filter((option) => option.create).map((option) => option.label);
            const row = (text: string, colour: "accent" | "mdHeading") => {
              const columns = text.match(/^(.*\S)(\s{2,})(\S.*)$/);
              return columns ? theme.fg(colour, columns[1]!) + theme.fg("muted", columns[2]! + columns[3]!) : theme.fg(colour, text);
            };
            const listTheme = {
              selectedPrefix: (text: string) => theme.fg("accent", text),
              selectedText: (text: string) => row(text, createLabels.some((value) => text.includes(value)) ? "mdHeading" : "accent"),
              description: (text: string) => theme.fg("muted", text),
              scrollInfo: (text: string) => theme.fg("muted", text),
              noMatch: (text: string) => theme.fg("muted", text),
            };
            const editor = new Editor(tui, { borderColor: (text) => theme.fg("borderMuted", text), selectList: listTheme });
            editor.disableSubmit = true;
            let list: SelectList;
            const rebuild = (query: string) => {
              const normalized = query.trim().toLowerCase();
              const filtered = options.filter((option) => `${option.label} ${option.description ?? ""}`.toLowerCase().includes(normalized));
              const width = Math.max(1, ...filtered.map((option) => visibleWidth(option.label))) + 4;
              list = new SelectList(
                filtered.map(({ value, label, description }) => ({ value, label, description })),
                Math.max(1, Math.min(filtered.length, 5)),
                listTheme,
                { minPrimaryColumnWidth: width, maxPrimaryColumnWidth: width },
              );
              list.onSelect = (item) => done(item.value);
            };
            rebuild("");
            editor.onChange = rebuild;
            return {
              get focused() {
                return editor.focused;
              },
              set focused(value: boolean) {
                editor.focused = value;
              },
              invalidate() {
                editor.invalidate();
                list.invalidate();
              },
              render: (width: number) => [...editor.render(width), ...list.render(width)],
              handleInput(data: string) {
                if (matchesKey(data, Key.escape)) return done(null);
                if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.enter)) list.handleInput(data);
                else editor.handleInput(data);
                tui.requestRender();
              },
            };
          })
        : await ctx.ui.input("Session execution", options.map((option) => option.label).join(" • "));
    return input === undefined || input === null ? undefined : input.trim();
  }

  async function pick(ctx: UIContext): Promise<SpaceItem | "local" | undefined> {
    if (!ctx.hasUI) return undefined;
    const items = await listSpaces(ctx.signal);
    const options = [
      ...(target.kind === "space"
        ? [{ value: "local", label: target.workspaceState ? "sync back to local directory" : "return to local execution" }]
        : []),
      ...items.map((item) => ({
        value: item.id,
        label: item.name,
        description: `${item.os || "unknown"} • ${item.provider} • ${
          !item.online
            ? `offline${item.reason ? `: ${item.reason.slice(0, 80)}` : ""}`
            : target.kind === "space" && target.spaceId === item.id
              ? "current; reconnect"
              : "online"
        }`,
      })),
    ];
    if (!options.length) throw new Error("no Spaces are registered; add one with the cua CLI or /space create");
    const value = await search(ctx, options);
    if (!value) return undefined;
    if (value === "local") return "local";
    const item = items.find((candidate) => candidate.id === value || candidate.name === value);
    if (!item) throw new Error(`unknown Space: ${value}`);
    if (!item.online) throw new Error(`${item.name} is offline`);
    return item;
  }

  async function refreshDiff(): Promise<void> {
    if (closed) return;
    const generation = ++diffGeneration;
    const active = attachment;
    if (!active) {
      pi.events.emit("cua:workspace-diff-changed", { kind: "local" });
      return;
    }
    const workspace = workspaceOf(active);
    try {
      const status = workspace ? await diffStatus(workspace) : { additions: 0, deletions: 0, pendingSync: false };
      if (closed || generation !== diffGeneration || attachment !== active) return;
      pi.events.emit("cua:workspace-diff-changed", { kind: "sandbox", name: active.place.name, ...status });
    } catch {
      // A status refresh must not interrupt the session.
    }
  }

  pi.registerTool({
    name: "enter_space",
    label: "Enter Space",
    description:
      "Move this session's tool execution to an existing Cua Space, by name or OS. Call with no arguments to list Spaces. Never creates Spaces or returns to local execution.",
    promptGuidelines: [
      "Call enter_space alone in its tool batch. Creating or deleting Spaces and returning to local execution are user actions (/space).",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Space name, such as mac-studio" })),
      os: Type.Optional(StringEnum(["linux", "macos"] as const)),
    }),
    executionMode: "sequential",
    async execute(_id, input, signal, _onUpdate, ctx) {
      const context = Object.create(ctx, { signal: { value: signal ?? ctx.signal } }) as UIContext;
      const items = await listSpaces(context.signal);
      if (!input.name && !input.os)
        return {
          content: [
            {
              type: "text" as const,
              text: items.length
                ? items.map((item) => `${item.name}\t${item.os || "unknown"}\t${item.online ? "online" : "offline"}${target.kind === "space" && target.spaceId === item.id ? "\tcurrent" : ""}`).join("\n")
                : "no Spaces are registered; ask the user to add or create one",
            },
          ],
          details: { spaces: items },
        };
      const candidates = items
        .filter((item) => item.online && (!input.name || item.name === input.name) && (!input.os || item.os === input.os))
        .sort((a, b) => a.name.localeCompare(b.name));
      const selected = candidates.find((item) => target.kind === "space" && item.id === target.spaceId) ?? candidates[0];
      if (!selected)
        throw new Error(`no online Space matches${input.name ? ` name=${input.name}` : ""}${input.os ? ` os=${input.os}` : ""}; no Space was created`);
      if (!(target.kind === "space" && target.spaceId === selected.id && attachment)) await enter(selected, context);
      const warnings = attachment?.runtime.warnings ?? [];
      return {
        content: [
          {
            type: "text" as const,
            text: `execution environment: ${selected.name} (${selected.os}). Subsequent tools run there. The user returns to local execution with /space local.${warnings.length ? `\nPi configuration transfer notes:\n${warnings.join("\n")}` : ""}`,
          },
        ],
        details: { name: selected.name, os: selected.os },
      };
    },
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const calls = event.message.content.filter((item) => item.type === "toolCall");
    mixedBatch = calls.length > 1 && calls.some((item) => item.type === "toolCall" && item.name === "enter_space");
  });

  pi.registerCommand("space", {
    description: "Choose, create or delete the Cua Space this session executes in",
    handler: async (args, ctx) => {
      try {
        await ctx.waitForIdle();
        const value = args.trim();
        if (value.startsWith("create")) {
          const created = await createSpace(value.slice("create".length).trim(), ctx);
          if (created) await enter(created, ctx);
          return;
        }
        if (value.startsWith("delete")) {
          const name = value.slice("delete".length).trim();
          if (!name) throw new Error("usage: /space delete <name>");
          await deleteSpace(name, ctx);
          return;
        }
        let choice: SpaceItem | "local" | undefined;
        if (!value) choice = await pick(ctx);
        else if (value === "local") choice = "local";
        else {
          const item = (await listSpaces(ctx.signal)).find((candidate) => candidate.name === value || candidate.id === value);
          if (!item) throw new Error(`unknown Space: ${value}`);
          if (!item.online) throw new Error(`${item.name} is offline`);
          choice = item;
        }
        if (!choice) return;
        if (choice === "local") await enterLocal(ctx);
        else await enter(choice, ctx);
      } catch (error) {
        if (!closed) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  let pendingStart: { reason: "startup" | "reload" | "new" | "resume" | "fork"; previousSessionFile?: string } | undefined;

  pi.on("session_start", (event) => {
    pendingStart = event;
  });

  pi.on("resources_discover", async (_event, ctx) => {
    const event = pendingStart;
    pendingStart = undefined;
    if (!event) return;
    let attempted: SpacePlace | undefined;
    const creates = event.reason === "new" || event.reason === "fork";
    try {
      const saved = creates
        ? event.previousSessionFile
          ? parsePlace(latestEntryData(SessionManager.open(event.previousSessionFile).getEntries(), placementEntry))
          : undefined
        : parsePlace(latestEntryData(ctx.sessionManager.getEntries(), placementEntry));
      if (creates) savePlace({ kind: "local" });
      if (saved?.kind !== "space") return;
      attempted = saved;
      entering = true;
      try {
        const space = await resolveSpace(saved.spaceId, ctx.signal);
        const next = await attach(space, ctx, creates ? "inherit" : "resume", creates ? { parent: saved } : { saved });
        route(next, ctx, { announce: false });
      } finally {
        entering = false;
      }
    } catch (error) {
      if (closed) return;
      placementError = error instanceof Error ? error : new Error(String(error));
      if (attempted && !creates) target = attempted;
      if (attempted) {
        ctx.ui.setStatus("cua-session", `${attempted.name} (failed to connect)`);
        emitTarget({
          kind: "sandbox",
          name: attempted.name,
          os: attempted.os,
          state: "failed",
          phase: "connect.failed",
          message: "failed to connect",
          error: placementError.message,
        });
      }
      ctx.ui.notify(`execution placement blocked: ${placementError.message}; choose a target with /space`, "error");
    }
  });

  pi.on("agent_settled", () => {
    void refreshDiff();
  });

  pi.on("tool_call", (event) => {
    if (mixedBatch)
      return { block: true, reason: "enter_space must be the only tool call in its batch; no tools dispatched" };
    if (entering) return { block: true, reason: "a Space entry is in progress; no tool dispatched" };
    if (target.kind !== "space" || localTools.has(event.toolName)) return;
    const reason = routes().unavailable.get(event.toolName);
    if (reason) return { block: true, reason: `${reason}; it is unavailable while this session runs on ${target.name}` };
    if (!routes().tools.includes(event.toolName))
      return { block: true, reason: `${event.toolName} was registered after entering the Space; run /reload to rebuild the Space tool set` };
  });

  pi.on("before_agent_start", async (event) => {
    if (placementError) throw placementError;
    const active = attachment;
    if (!active) return;
    const { place, runtime, runtimeRoot } = active;
    const resources = Object.entries(runtime.paths)
      .sort(([a], [b]) => b.length - a.length)
      .map(([source, destination]) => `${source} → ${runtimeRoot}/agent/${destination}`)
      .join("\n");
    const environment = `Execution environment: ${place.name} (${place.os}), a Cua Space. Workspace tools and user shell commands run there; use workspace-relative paths. Web search and reads of its full-output files remain on the controller; API credentials are not copied to Spaces. Papercut reports and read/edit/write operations on their absolute ledger paths remain on the controller; do not use Space shell commands to access them. Pi resources have been copied to this Space; use these paths for their supporting scripts:\n${resources}\nConfiguration transfer notes: ${runtime.warnings.join("; ") || "none"}`;
    return {
      systemPrompt: `${event.systemPrompt.replace(`Current working directory: ${place.localCwd}`, `Current working directory: ${place.workspaceState ? "workspace root" : "execution root"}`)}\n\n${environment}`,
    };
  });

  pi.on("user_bash", () => {
    if (entering) throw new Error("a Space entry is in progress; run the command when it finishes");
    if (placementError) throw placementError;
    const active = attachment;
    if (!active) return;
    const operations: BashOperations = {
      exec: (command, _cwd, options) =>
        active.host.bash(`bash-${crypto.randomUUID()}`, command, {
          onData: options.onData,
          signal: options.signal,
          timeout: options.timeout,
        }),
    };
    return { operations };
  });

  pi.on("session_shutdown", () => {
    closed = true;
    diffGeneration += 1;
    attachment = undefined;
    client?.close();
    client = undefined;
  });
}
