import {
  type BashOperations,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DEFAULT_MAX_BYTES,
  DynamicBorder,
  getSelectListTheme,
  keyHint,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  SessionManager,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Input, SelectList, Text, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { probe, run, type Remote } from "./remote.ts";
import { isSpaceOS, orderedSpaces, type SpaceItem, type SpaceOS, type SpacesClient, type SpaceTool, NativeSpacesClient } from "./spaces.ts";
import { type SpaceOperations, spaceOperations, localClipboard } from "./tools.ts";
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
  let ui: UIContext["ui"] | undefined;
  let online = 0;
  let diff = "";
  let activity: string | undefined;
  let known: SpaceItem[] | undefined;
  let listing: Promise<SpaceItem[]> | undefined;
  let checks = new Map<string, Promise<SpaceItem>>();
  let redraw: (() => void) | undefined;

  const spaces = () => (client ??= new NativeSpacesClient());

  function show(next?: string): void {
    activity = next;
    if (closed || !ui) return;
    const here = target.kind === "space" ? `${target.name} • connected${diff}` : `local${online ? ` • ${online} space${online === 1 ? "" : "s"} available` : ""}`;
    ui.setStatus("cua-session", activity ?? here);
  }

  const steps: Array<[string, string]> = [
    ["create", "creating the Space"],
    ["connect", "checking the Space"],
    ["workspace.preflight", "checking the repository"],
    ["workspace.capture", "capturing local changes"],
    ["workspace.objects", "sending files"],
    ["workspace.snapshot", "sending a snapshot"],
    ["workspace.local", "bringing changes back"],
    ["workspace", "preparing the workspace"],
  ];

  function progress(name: string, phase = "", message?: string): void {
    const step = steps.find(([prefix]) => phase.startsWith(prefix))?.[1] ?? "connecting";
    const detail = message && /\d/.test(message) ? ` (${message})` : "";
    show(`${name} • ${step}${detail}…`);
  }

  function checked(item: SpaceItem): Promise<SpaceItem> {
    let check = checks.get(item.id);
    if (!check) {
      check = spaces()
        .check(item)
        .then((result) => {
          Object.assign(item, result);
          online = (known ?? []).filter((each) => each.online).length;
          show(activity);
          redraw?.();
          return item;
        });
      checks.set(item.id, check);
    }
    return check;
  }

  function listSpaces(signal?: AbortSignal): Promise<SpaceItem[]> {
    if (listing) return listing;
    const before = activity;
    if (!known) show("listing Spaces…");
    listing = spaces()
      .list(signal)
      .then((items) => {
        const previous = new Map((known ?? []).map((item) => [item.id, item]));
        for (const item of items) {
          const seen = previous.get(item.id);
          if (seen) Object.assign(item, { online: seen.online, reason: seen.reason, os: item.os || seen.os });
        }
        known = items;
        checks = new Map();
        for (const item of items) void checked(item);
        redraw?.();
        return items;
      })
      .finally(() => {
        listing = undefined;
        show(before);
      });
    return listing;
  }

  async function findSpace(value: string, signal?: AbortSignal): Promise<SpaceItem | undefined> {
    const match = (items: SpaceItem[]) => items.find((item) => item.name === value || item.id === value);
    const item = (known && match(known)) ?? match(await listSpaces(signal));
    return item && checked(item);
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
    const item = await findSpace(spaceId, signal);
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
    const report = (phase: string, message: string) => progress(space.name, phase, message);
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
    diff = "";
    show();
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
      show();
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
        progress(previous.place.name, "workspace.local", "syncing Space changes to local");
        await syncToLocal(workspace, previous.place.localCwd, (phase, message) => progress(previous.place.name, phase, message), ctx.signal);
      }
      route(undefined, ctx);
      await retire(previous, undefined, ctx);
    } finally {
      entering = false;
      show();
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
    progress(name, "create", "creating");
    try {
      await callSpaces("create_space", input, ctx, ctx.signal);
    } catch (error) {
      if (error instanceof Error && error.message.endsWith("declined by the user")) return undefined;
      throw error;
    } finally {
      show();
    }
    return (await listSpaces(ctx.signal)).find((item) => item.name === name);
  }

  async function deleteSpace(name: string, ctx: UIContext): Promise<string> {
    const item = await findSpace(name, ctx.signal);
    if (!item) throw new Error(`unknown Space: ${name}`);
    if (target.kind === "space" && target.spaceId === item.id)
      throw new Error(`move this session off ${item.name} with /space local before deleting it`);
    await callSpaces("delete_space", { space: item.id }, ctx, ctx.signal);
    void listSpaces().catch(() => undefined);
    return `deleted ${item.name}`;
  }

  async function search(ctx: UIContext, choices: () => Array<{ value: string; label: string; description?: string }>): Promise<string | undefined> {
    const options = choices();
    const input =
      ctx.mode === "tui"
        ? await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
            const listTheme = getSelectListTheme();
            const editor = new Input();
            const border = new DynamicBorder();
            const hint = new Text(`${keyHint("tui.select.confirm", "select")} · ${keyHint("tui.select.cancel", "cancel")}`, 0, 0);
            const title = new Text(theme.fg("muted", "Choose execution environment"), 0, 0);
            let list: SelectList;
            let query = "";
            const rebuild = (text: string) => {
              query = text;
              const normalized = query.trim().toLowerCase();
              const selected = list?.getSelectedItem()?.value;
              const filtered = choices().filter((option) => `${option.label} ${option.description ?? ""}`.toLowerCase().includes(normalized));
              const width = Math.max(1, ...filtered.map((option) => visibleWidth(option.label))) + 4;
              list = new SelectList(
                filtered.map(({ value, label, description }) => ({ value, label, description })),
                Math.max(1, Math.min(filtered.length, 10)),
                listTheme,
                { minPrimaryColumnWidth: width, maxPrimaryColumnWidth: width },
              );
              list.onSelect = (item) => done(item.value);
              const index = filtered.findIndex((option) => option.value === selected);
              if (index > 0) list.setSelectedIndex(index);
            };
            rebuild("");
            redraw = () => {
              rebuild(query);
              tui.requestRender();
            };
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
              render: (width: number) => [...border.render(width), "", ...title.render(width), "", ...editor.render(width), "", ...list.render(width), "", ...hint.render(width), ...border.render(width)],
              handleInput(data: string) {
                if (keybindings.matches(data, "tui.select.cancel")) return done(null);
                if ((["tui.select.up", "tui.select.down", "tui.select.confirm"] as const).some((key) => keybindings.matches(data, key))) list.handleInput(data);
                else {
                  editor.handleInput(data);
                  if (editor.getValue() !== query) rebuild(editor.getValue());
                }
                tui.requestRender();
              },
            };
          })
        : await ctx.ui.input("Session execution", options.map((option) => option.label).join(" • "));
    return input === undefined || input === null ? undefined : input.trim();
  }

  function describe(item: SpaceItem): string {
    const status = item.online === undefined
      ? "checking…"
      : !item.online
      ? `offline${item.reason ? `: ${item.reason.slice(0, 80)}` : ""}`
      : target.kind === "space" && target.spaceId === item.id
        ? "current"
        : "online";
    return `${item.os || "unknown"} • ${item.provider} • ${status}`;
  }

  async function pick(ctx: UIContext): Promise<string | undefined> {
    if (known) void listSpaces().catch(() => undefined);
    else await listSpaces(ctx.signal);
    const choices = () => [
      ...(target.kind === "space" ? [{ value: "local", label: target.workspaceState ? "sync back to local directory" : "return to local execution" }] : []),
      ...orderedSpaces(known ?? [])
        .map((item) => ({ value: item.id, label: item.name, description: describe(item) })),
    ];
    if (!choices().length) throw new Error(noSpaces);
    try {
      return await search(ctx, choices);
    } finally {
      redraw = undefined;
    }
  }

  async function space(argument: string, ctx: UIContext): Promise<string | undefined> {
    const value = argument.trim();
    if (!value) {
      const items = await Promise.all((await listSpaces(ctx.signal)).map(checked));
      return items.length ? items.map((item) => `${item.name}\t${describe(item)}`).join("\n") : noSpaces;
    }
    if (value === "auth") {
      const active = onSpace();
      if (!active || !attachment) return "credentials stay on this machine. enter a Space, then use /space auth to check its sign-ins.";
      const result = await run(attachment.remote, `
if ! command -v gh >/dev/null 2>&1; then
  echo 'GitHub: install the gh CLI on this Space'
elif gh auth status --active >/dev/null 2>&1; then
  echo 'GitHub: authenticated'
else
  echo 'GitHub: authentication unavailable; run gh auth login in a terminal on this Space'
fi
`, { signal: ctx.signal, timeoutMs: 30_000 });
      return `${attachment.place.name} sign-ins (credentials are not copied):\n${result.stdout.toString("utf8").trim()}\nchecks can fail because of connectivity or expired credentials. use gh auth setup-git on this Space for HTTPS Git access.`;
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
    const item = await findSpace(value, ctx.signal);
    if (!item) throw new Error(`unknown Space: ${value}`);
    if (!item.online) throw new Error(`${item.name} is offline`);
    if (target.kind === "space" && target.spaceId === item.id && attachment) return entered(item);
    const started = performance.now();
    await enter(item, ctx);
    return `${entered(item)} (${((performance.now() - started) / 1000).toFixed(1)}s)`;
  }

  function entered(item: SpaceItem): string {
    return `execution environment: ${item.name} (${attachment?.place.os ?? item.os}). read, write, edit, bash, find, grep and ! commands now run there.`;
  }

  async function refreshDiff(): Promise<void> {
    if (closed) return;
    const generation = ++diffGeneration;
    const active = attachment;
    const workspace = active && workspaceOf(active);
    if (!workspace) return;
    const status = await diffStatus(workspace).catch(() => undefined);
    if (!status || closed || generation !== diffGeneration || attachment !== active) return;
    diff = status.additions || status.deletions ? ` • +${status.additions} -${status.deletions}` : "";
    show(activity);
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
      return createReadToolDefinition(ctx.cwd, ops && !localClipboard(input.path) ? { operations: ops.read } : {}).execute(id, input, signal, onUpdate, ctx);
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

  const usage = "<name> enters a Space · local returns · create [name] · delete <name> · auth checks GitHub sign-in · nothing lists Spaces";

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
        const previous = label(target);
        const text = await space(value, ctx);
        if (text && !closed && previous === label(target)) ctx.ui.notify(text, "info");
      } catch (error) {
        if (!closed) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  let pendingStart: { reason: "startup" | "reload" | "new" | "resume" | "fork"; previousSessionFile?: string } | undefined;

  pi.on("session_start", (event, ctx) => {
    pendingStart = event;
    ui = ctx.ui;
    show();
    void loadCatalogue(ctx);
    void listSpaces().catch(() => undefined);
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
      if (attempted) show(`${attempted.name} • failed to connect`);
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
