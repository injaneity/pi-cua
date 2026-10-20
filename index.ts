import {
  type BashOperations,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DEFAULT_MAX_BYTES,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  SessionManager,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Editor, Key, matchesKey, SelectList, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { probe, type Remote } from "./remote.ts";
import { isSpaceOS, type SpaceItem, type SpaceOS, type SpacesClient, type SpaceTool, WorkerSpacesClient } from "./spaces.ts";
import { type SpaceOperations, spaceOperations } from "./tools.ts";
import {
  cleanupWorkspace,
  diffStatus,
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

const extensionPath = fileURLToPath(import.meta.url);
const placementEntry = "cua-space-placement";
const noSpaces = "no Spaces are available; create one with /space create, or sign in and add machines with the cua CLI (see the pi-cua README)";
const workspaceTools = ["read", "write", "edit", "bash", "find", "grep"];

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
type Attachment = { place: SpacePlace; remote: Remote; ops: SpaceOperations };
type UIContext = ExtensionContext | ExtensionCommandContext;
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
  let entering = false;
  let mixedBatch = false;
  let closed = false;
  let diffGeneration = 0;
  let catalogue: Promise<void> | undefined;

  const spaces = () => (client ??= new WorkerSpacesClient());

  function emitTarget(value: Record<string, unknown>): void {
    if (!closed) pi.events.emit("cua:execution-target-changed", value);
  }

  function emitPlace(place: Place): void {
    emitTarget(place.kind === "space" ? { kind: "sandbox", name: place.name, os: place.os } : { kind: "local" });
  }

  function progress(ctx: UIContext, name: string, phase?: string, message?: string): void {
    if (closed) return;
    const activity = phase?.startsWith("workspace.") ? "syncing workspace" : "connecting";
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
    if (Object.keys(timings).length) pi.appendEntry("cua-entry-timing", { name: space.name, timings });
    return { place, remote, ops: spaceOperations(remote, localCwd, place.remoteCwd) };
  }

  function route(next: Attachment | undefined, ctx: UIContext, options: { announce?: boolean } = {}): void {
    if (closed) throw new Error("extension runtime was replaced while entering the Space");
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

  async function callSpaces(tool: SpaceTool | string, input: Record<string, unknown>, ctx: UIContext, signal?: AbortSignal) {
    const name = typeof tool === "string" ? tool : tool.name;
    const destructive = typeof tool === "string" || tool.annotations?.destructiveHint === true;
    if (destructive) {
      if (!ctx.hasUI) throw new Error(`${name} changes your Spaces and needs an interactive session to confirm`);
      if (!(await ctx.ui.confirm(`allow ${name}?`, JSON.stringify(input, null, 2))))
        throw new Error(`${name} was declined by the user`);
    }
    const result = await spaces().call(name, input, signal);
    const content = result.content.map((block) =>
      block.type === "image" && block.data && block.mimeType
        ? { type: "image" as const, data: block.data, mimeType: block.mimeType }
        : { type: "text" as const, text: truncateHead(block.text ?? JSON.stringify(block), { maxBytes: DEFAULT_MAX_BYTES }).content },
    );
    if (result.isError) throw new Error(content.map((block) => ("text" in block ? block.text : "")).join("\n") || `${name} failed`);
    return content;
  }

  async function createSpace(args: string, ctx: UIContext): Promise<SpaceItem | undefined> {
    if (args && !/^[a-z0-9][a-z0-9-]*$/.test(args)) throw new Error("usage: /space create [name]");
    const name = args || `pi-${randomBytes(3).toString("hex")}`;
    const input = { name, on: "local", wait: true };
    progress(ctx, name, "create", "creating");
    try {
      await callSpaces("create_space", input, ctx, ctx.signal);
    } catch (error) {
      if (error instanceof Error && error.message.endsWith("declined by the user")) return undefined;
      throw error;
    } finally {
      ctx.ui.setStatus("cua-session", undefined);
    }
    return (await listSpaces(ctx.signal)).find((item) => item.name === name);
  }

  async function deleteSpace(name: string, ctx: UIContext): Promise<string> {
    const item = (await listSpaces(ctx.signal)).find((candidate) => candidate.name === name || candidate.id === name);
    if (!item) throw new Error(`unknown Space: ${name}`);
    if (target.kind === "space" && target.spaceId === item.id)
      throw new Error(`move this session off ${item.name} with /space local before deleting it`);
    await callSpaces("delete_space", { space: item.id }, ctx, ctx.signal);
    void listSpaces().catch(() => undefined);
    return `deleted ${item.name}`;
  }

  async function search(ctx: UIContext, options: Array<{ value: string; label: string; description?: string }>): Promise<string | undefined> {
    const input =
      ctx.mode === "tui"
        ? await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
            const row = (text: string) => {
              const columns = text.match(/^(.*\S)(\s{2,})(\S.*)$/);
              return columns ? theme.fg("accent", columns[1]!) + theme.fg("muted", columns[2]! + columns[3]!) : theme.fg("accent", text);
            };
            const listTheme = {
              selectedPrefix: (text: string) => theme.fg("accent", text),
              selectedText: row,
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

  function describe(item: SpaceItem): string {
    const status = !item.online
      ? `offline${item.reason ? `: ${item.reason.slice(0, 80)}` : ""}`
      : target.kind === "space" && target.spaceId === item.id
        ? "current"
        : "online";
    return `${item.os || "unknown"} • ${item.provider} • ${status}`;
  }

  async function pick(ctx: UIContext): Promise<string | undefined> {
    const items = await listSpaces(ctx.signal);
    const options = [
      ...(target.kind === "space" ? [{ value: "local", label: target.workspaceState ? "sync back to local directory" : "return to local execution" }] : []),
      ...items.map((item) => ({ value: item.id, label: item.name, description: describe(item) })),
    ];
    if (!options.length) throw new Error(noSpaces);
    return search(ctx, options);
  }

  async function space(argument: string, ctx: UIContext): Promise<string | undefined> {
    const value = argument.trim();
    if (!value) {
      const items = await listSpaces(ctx.signal);
      return items.length ? items.map((item) => `${item.name}\t${describe(item)}`).join("\n") : noSpaces;
    }
    if (value === "local") {
      if (target.kind !== "space") return "already running locally";
      if (!("reload" in ctx)) {
        pi.sendUserMessage("/space local", { expandPromptTemplates: true, deliverAs: "followUp" });
        return "returning to local execution once this turn ends";
      }
      await enterLocal(ctx);
      return undefined;
    }
    if (value === "create" || value.startsWith("create ")) {
      const created = await createSpace(value.slice("create".length).trim(), ctx);
      if (!created) return "creation was declined";
      await enter(created, ctx);
      return entered(created);
    }
    if (value === "delete" || value.startsWith("delete ")) {
      const name = value.slice("delete".length).trim();
      if (!name) throw new Error("usage: /space delete <name>");
      return deleteSpace(name, ctx);
    }
    const item = (await listSpaces(ctx.signal)).find((candidate) => candidate.name === value || candidate.id === value);
    if (!item) throw new Error(`unknown Space: ${value}`);
    if (!item.online) throw new Error(`${item.name} is offline`);
    if (!(target.kind === "space" && target.spaceId === item.id && attachment)) await enter(item, ctx);
    return entered(item);
  }

  function entered(item: SpaceItem): string {
    return `execution environment: ${item.name} (${attachment?.place.os ?? item.os}). read, write, edit, bash, find, grep and ! commands now run there.`;
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

  function onSpace(): SpaceOperations | undefined {
    if (entering) throw new Error("a Space entry is in progress; no tool dispatched");
    if (placementError) throw placementError;
    return target.kind === "space" ? attachment?.ops : undefined;
  }

  pi.registerTool({
    ...createReadToolDefinition(process.cwd()),
    execute: (id, input, signal, onUpdate, ctx) => {
      const ops = onSpace();
      return createReadToolDefinition(ctx.cwd, ops ? { operations: ops.read } : {}).execute(id, input, signal, onUpdate, ctx);
    },
  });
  pi.registerTool({
    ...createWriteToolDefinition(process.cwd()),
    execute: (id, input, signal, onUpdate, ctx) => {
      const ops = onSpace();
      return createWriteToolDefinition(ctx.cwd, ops ? { operations: ops.write } : {}).execute(id, input, signal, onUpdate, ctx);
    },
  });
  pi.registerTool({
    ...createEditToolDefinition(process.cwd()),
    execute: (id, input, signal, onUpdate, ctx) => {
      const ops = onSpace();
      return createEditToolDefinition(ctx.cwd, ops ? { operations: ops.edit } : {}).execute(id, input, signal, onUpdate, ctx);
    },
  });
  pi.registerTool({
    ...createBashToolDefinition(process.cwd()),
    execute: (id, input, signal, onUpdate, ctx) => {
      const ops = onSpace();
      return createBashToolDefinition(ctx.cwd, ops ? { operations: ops.bash } : {}).execute(id, input, signal, onUpdate, ctx);
    },
  });
  pi.registerTool({
    ...createFindToolDefinition(process.cwd()),
    defaultActive: false,
    execute: (id, input, signal, onUpdate, ctx) => {
      const ops = onSpace();
      return createFindToolDefinition(ctx.cwd, ops ? { operations: ops.find } : {}).execute(id, input, signal, onUpdate, ctx);
    },
  });
  pi.registerTool({
    ...createGrepToolDefinition(process.cwd()),
    defaultActive: false,
    async execute(id, input, signal, onUpdate, ctx) {
      const ops = onSpace();
      if (!ops) return createGrepToolDefinition(ctx.cwd).execute(id, input, signal, onUpdate, ctx);
      const args = ["git", "grep", "--no-index", "--exclude-standard", "-n", "-I"];
      if (input.ignoreCase) args.push("-i");
      if (input.literal) args.push("-F");
      if (input.context) args.push(`-C${Math.max(0, Math.floor(input.context))}`);
      const base = input.path ? ops.remotePath(input.path) : ".";
      const glob = input.glob && (input.glob.includes("/") ? input.glob : `**/${input.glob}`);
      args.push("-e", input.pattern, "--", glob ? `:(glob)${base === "." ? "" : `${base}/`}${glob}` : base);
      const output = await ops.grep(args, ctx.cwd, signal);
      const limit = input.limit ?? 100;
      let matches = 0;
      const kept: string[] = [];
      for (const line of output.split("\n").filter(Boolean)) {
        if (/^[^:]+:\d+:/.test(line) && ++matches > limit) break;
        kept.push(line);
      }
      const text = truncateHead(kept.join("\n"), { maxBytes: DEFAULT_MAX_BYTES }).content;
      return {
        content: [{ type: "text", text: text ? `${text}${matches > limit ? `\n\n[${limit} matches limit reached]` : ""}` : "No matches found" }],
        details: undefined,
      };
    },
  });

  function loadCatalogue(ctx: UIContext): Promise<void> {
    catalogue ??= spaces()
      .tools()
      .then((tools) => {
        for (const tool of tools)
          pi.registerTool({
            name: `cua_${tool.name}`,
            label: `cua/${tool.name}`,
            description: tool.description ?? tool.name,
            parameters: { type: "object", properties: {}, ...tool.inputSchema } as never,
            exposure: "deferred",
            namespace: { name: "cua", aliases: ["spaces"], description: "Cua Spaces: machines, sandboxes, agents, Volume, sharing" },
            annotations: tool.annotations as never,
            async execute(_id, input, signal, _onUpdate, toolCtx) {
              return { content: await callSpaces(tool, input, toolCtx, signal), details: { tool: tool.name } };
            },
          });
        if (pi.getAllTools().some((tool) => tool.name === "tool_search") && !pi.getActiveTools().includes("tool_search"))
          pi.setActiveTools([...pi.getActiveTools(), "tool_search"]);
      })
      .catch((error) => {
        catalogue = undefined;
        if (!closed) ctx.ui.notify(`Cua Spaces tools unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
      });
    return catalogue;
  }

  const usage = "<name> enters a Space · local returns · create [name] · delete <name> · nothing lists Spaces";

  pi.registerTool({
    name: "space",
    label: "Space",
    description: `Choose where this session's tools run, with the same arguments as /space: ${usage}. Creating and deleting ask the user to confirm.`,
    promptGuidelines: ["Call space alone in its tool batch."],
    parameters: Type.Object({ argument: Type.Optional(Type.String({ description: usage })) }),
    executionMode: "sequential",
    async execute(_id, input, signal, _onUpdate, ctx) {
      const context = Object.create(ctx, { signal: { value: signal ?? ctx.signal } }) as UIContext;
      const text = (await space(input.argument ?? "", context)) ?? "done";
      return { content: [{ type: "text" as const, text }], details: { argument: input.argument ?? "" } };
    },
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const calls = event.message.content.filter((item) => item.type === "toolCall");
    mixedBatch = calls.length > 1 && calls.some((item) => item.type === "toolCall" && item.name === "space");
  });

  pi.registerCommand("space", {
    description: `Choose where this session's tools run: ${usage}`,
    handler: async (args, ctx) => {
      try {
        await ctx.waitForIdle();
        const value = args.trim() || (ctx.hasUI ? await pick(ctx) : "");
        if (value === undefined) return;
        const text = await space(value, ctx);
        if (text && !closed) ctx.ui.notify(text, "info");
      } catch (error) {
        if (!closed) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  let pendingStart: { reason: "startup" | "reload" | "new" | "resume" | "fork"; previousSessionFile?: string } | undefined;

  pi.on("session_start", (event, ctx) => {
    pendingStart = event;
    void loadCatalogue(ctx);
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
      ctx.ui.notify(`execution placement blocked: ${placementError.message}`, "error");
    }
  });

  pi.on("agent_settled", () => {
    void refreshDiff();
  });

  pi.on("tool_call", (event) => {
    if (mixedBatch)
      return { block: true, reason: "space must be the only tool call in its batch; no tools dispatched" };
    if (entering) return { block: true, reason: "a Space entry is in progress; no tool dispatched" };
    if (target.kind !== "space" || !workspaceTools.includes(event.toolName)) return;
    const effective = pi.getAllTools().find((tool) => tool.name === event.toolName);
    if (effective?.sourceInfo.path !== extensionPath)
      return {
        block: true,
        reason: `${event.toolName} comes from ${effective?.sourceInfo.source ?? "another extension"}, which would act on your local files while this session runs on ${target.name}; load pi-cua before it or disable it`,
      };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await loadCatalogue(ctx);
    if (placementError) throw placementError;
    const active = attachment;
    if (!active) return;
    const { place } = active;
    const environment = `Execution environment: ${place.name} (${place.os}), a Cua Space. read, write, edit, bash, find, grep and user ! commands run there, in ${place.remoteCwd}; use workspace-relative paths. Other tools run on the user's machine. Cua Spaces tools (namespace cua) are available through tool_search.`;
    return {
      systemPrompt: `${event.systemPrompt.replace(`Current working directory: ${place.localCwd}`, `Current working directory: ${place.workspaceState ? "workspace root" : "execution root"}`)}\n\n${environment}`,
    };
  });

  pi.on("user_bash", () => {
    const ops = onSpace();
    if (!ops) return;
    const operations: BashOperations = ops.bash;
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
