import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { layout, run, sh, type Remote } from "./remote.ts";

const transferScript = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "git-transfer.cjs"),
  "utf8",
);
const limit = 200 * 1024 * 1024;
const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const filterCheck = `const { spawnSync } = require('node:child_process');
const root = process.argv[1];
const maxBuffer = 256 * 1024 * 1024;
const run = (args, input) => {
  const result = spawnSync('git', ['-C', root, ...args], { input, maxBuffer });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stderr ?? Buffer.from(result.error?.message ?? 'git failed'));
    process.exit(result.status ?? 1);
  }
  return result.stdout;
};
const paths = run(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
const fields = run(
  ['check-attr', '-z', '--stdin', 'filter', 'working-tree-encoding'],
  paths,
).toString('utf8').split('\\0');
for (let i = 0; i + 2 < fields.length; i += 3) {
  if (!['', 'unspecified', 'unset'].includes(fields[i + 2])) {
    process.stderr.write(\`unsupported Git attribute: \${fields[i + 1]}=\${fields[i + 2]} on \${fields[i]}\\n\`);
    process.exit(42);
  }
}
`;

export const freeSpaceCheck = `available=$(( $(df -Pk "$HOME" | awk 'NR == 2 { print $4 }') * 1024 ))
if [ "$available" -lt 1073741824 ]; then echo "setup needs 1 GiB free; only $(( available / 1048576 )) MiB is available" >&2; exit 1; fi`;

export type WorkspaceState = {
  version: 1;
  localRoot: string;
  commit: string;
  commitTree: string;
  baselineTree: string;
};

export type Repository = {
  root: string;
  relativeCwd: string;
  remoteUrl: string;
  commit: string;
};

export type SpaceWorkspace = {
  remote: Remote;
  root: string;
  state: WorkspaceState;
};

export type Timings = Record<string, number>;
export type Progress = (phase: string, message: string) => void;

export function executionDigest(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function parseWorkspaceState(value: unknown): WorkspaceState | undefined {
  if (value === undefined || value === null) return undefined;
  const state = value as Record<string, unknown>;
  if (
    typeof value !== "object" ||
    state.version !== 1 ||
    typeof state.localRoot !== "string" ||
    !["commit", "commitTree", "baselineTree"].every(
      (key) => typeof state[key] === "string" && oidPattern.test(state[key] as string),
    )
  )
    throw new Error("saved workspace state is unsupported");
  return state as WorkspaceState;
}

function git(root: string, args: string[], options: { input?: Buffer | string; env?: NodeJS.ProcessEnv; timeout?: number } = {}): Buffer {
  return execFileSync("git", ["-C", root, ...args], {
    input: options.input,
    env: options.env ?? process.env,
    maxBuffer: limit,
    timeout: options.timeout ?? 300_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

const gitText = (root: string, args: string[]) => git(root, args).toString("utf8").trim();

function oid(value: unknown, what: string): string {
  if (typeof value !== "string" || !oidPattern.test(value)) throw new Error(`invalid ${what}`);
  return value;
}

export function inspectWorkspace(cwd: string): Repository | undefined {
  let rootText: string;
  try {
    rootText = gitText(cwd, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    const stderr = String((error as { stderr?: Buffer }).stderr ?? "");
    if (/not a git repository/i.test(stderr)) return undefined;
    throw error;
  }
  const root = realpathSync(rootText);
  const resolvedCwd = realpathSync(cwd);
  const rel = relative(root, resolvedCwd);
  if (rel.startsWith("..")) throw new Error("session cwd is outside its Git workspace");
  const remoteUrl = gitText(root, ["remote", "get-url", "origin"]);
  if (!/^(?:https?:\/\/|ssh:\/\/|git@)/.test(remoteUrl) && process.env.PI_CUA_ALLOW_LOCAL_ORIGIN !== "1")
    throw new Error("workspace origin must be a network Git URL");
  const commit = oid(gitText(root, ["rev-parse", "HEAD"]), "workspace HEAD");
  if (gitText(root, ["ls-files", "--stage"]).split("\n").some((line) => line.startsWith("160000 ")))
    throw new Error("workspace transfer does not yet support Git submodules");
  try {
    execFileSync("node", ["-e", filterCheck, root], { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr ?? "workspace filter check failed").trim());
  }
  return { root, relativeCwd: rel.split(sep).join("/") || ".", remoteUrl, commit };
}

export function workspaceTree(root: string): string {
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!status.length) return oid(gitText(root, ["rev-parse", "HEAD^{tree}"]), "workspace tree");
  const directory = mkdtempSync(join(tmpdir(), "pi-cua-index-"));
  try {
    const index = join(directory, "index");
    const env = { ...process.env, GIT_INDEX_FILE: index };
    const original = gitText(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    if (existsSync(original)) copyFileSync(original, index);
    else git(root, ["read-tree", "HEAD"], { env });
    git(root, ["add", "-A", "--", "."], { env });
    return oid(git(root, ["write-tree"], { env }).toString("utf8").trim(), "workspace tree");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

type Side = { kind: "local" } | { kind: "space"; remote: Remote };

async function transfer(
  side: Side,
  root: string,
  action: string,
  options: Record<string, unknown> = {},
  input: Buffer = Buffer.alloc(0),
  settings: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Buffer> {
  const timeoutMs = settings.timeoutMs ?? (action === "prepare" ? 660_000 : 120_000);
  const encoded = Buffer.from(JSON.stringify({ root, ...options })).toString("base64");
  if (side.kind === "local") {
    try {
      return execFileSync("node", ["-e", transferScript, action, encoded], {
        input,
        maxBuffer: limit,
        timeout: timeoutMs,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new Error(`Git object ${action} failed: ${String((error as { stderr?: Buffer }).stderr ?? error).slice(-2000)}`);
    }
  }
  const { remote } = side;
  const result = await run(remote, `exec node -e ${sh(transferScript)} ${sh(action)} ${sh(encoded)}`, {
    timeoutMs,
    signal: settings.signal,
    check: false,
    input,
  });
  if (result.exitCode !== 0 || result.timedOut)
    throw new Error(
      `Git object ${action} on ${remote.name} ${result.timedOut ? "timed out" : "failed"}: ${(result.stderr || result.error || "").trim().slice(-2000)}`,
    );
  if (result.stdout.length > limit) throw new Error(`Git object response from ${remote.name} exceeds 200 MiB`);
  return result.stdout;
}

const json = async <T>(promise: Promise<Buffer>): Promise<T> => JSON.parse((await promise).toString("utf8"));

function measure<T>(timings: Timings, phase: string, progress: Progress | undefined, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  progress?.(phase, "started");
  return fn().finally(() => {
    timings[phase] = Math.round(performance.now() - started);
  });
}

type Capture = {
  state: WorkspaceState;
  finalTree: string;
  objects?: Array<[string, number]>;
  baselineInSource: boolean;
};

function captureLocal(repository: Repository): Capture {
  const baselineTree = workspaceTree(repository.root);
  return {
    state: {
      version: 1,
      localRoot: repository.root,
      commit: repository.commit,
      commitTree: oid(gitText(repository.root, ["rev-parse", "HEAD^{tree}"]), "commit tree"),
      baselineTree,
    },
    finalTree: baselineTree,
    baselineInSource: false,
  };
}

async function captureSpace(source: SpaceWorkspace, exclude: string | undefined, signal?: AbortSignal): Promise<Capture> {
  const snapshot = await json<{ tree: string; objects: Array<[string, number]>; baselineAvailable: boolean }>(
    transfer({ kind: "space", remote: source.remote }, source.root, "snapshot", {
      exclude,
      baseline: source.state.baselineTree,
      filterScript: filterCheck,
    }, undefined, { signal }),
  );
  return {
    state: source.state,
    finalTree: oid(snapshot.tree, "source snapshot tree"),
    objects: snapshot.objects,
    baselineInSource: snapshot.baselineAvailable === true,
  };
}

async function repositoryAvailable(remote: Remote, repository: Repository, commit: string, signal?: AbortSignal): Promise<boolean> {
  const cache = layout(remote.home).repo(repositoryKey(repository.remoteUrl));
  const result = await run(
    remote,
    `git -C ${sh(cache)} cat-file -e ${sh(`${commit}^{commit}`)} 2>/dev/null || GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code ${sh(repository.remoteUrl)} HEAD >/dev/null 2>&1`,
    { check: false, timeoutMs: 60_000, signal, label: "repository check" },
  );
  return result.exitCode === 0;
}

function repositoryKey(remoteUrl: string): string {
  return createHash("sha256").update(remoteUrl).digest("hex").slice(0, 20);
}

async function prepareSnapshot(remote: Remote, repository: Repository, commit: string, workspaceRoot: string, signal?: AbortSignal): Promise<void> {
  const archive = git(repository.root, ["archive", "--format=tar.gz", commit]);
  const root = sh(workspaceRoot);
  await run(
    remote,
    `set -eu
mkdir -p ${root}
if [ -d ${root}/.git ]; then
  git -C ${root} rm -rf --ignore-unmatch -q -- .
  git -C ${root} clean -ffdq
else
  git -C ${root} init -q
  git -C ${root} config user.name pi-cua
  git -C ${root} config user.email pi-cua@localhost
fi
tar -xzf - -C ${root}
git -C ${root} add -A
git -C ${root} -c commit.gpgsign=false commit --allow-empty -qm 'pi-cua workspace baseline'
git -C ${root} remote remove origin 2>/dev/null || true
git -C ${root} remote add origin ${sh(repository.remoteUrl)}`,
    { timeoutMs: 20 * 60_000, signal, label: "snapshot workspace setup", input: archive },
  );
}

async function transferObjects(
  remote: Remote,
  workspaceRoot: string,
  repository: Repository,
  capture: Capture,
  source: SpaceWorkspace | undefined,
  reference: string,
  timings: Timings,
  options: { exclude?: string; prepare: boolean; progress?: Progress; signal?: AbortSignal },
): Promise<void> {
  const { exclude, prepare, progress, signal } = options;
  const local: Side = { kind: "local" };
  const origins: Array<{ side: Side; root: string; tree: string; fromSource: boolean }> = [];
  origins.push(
    source
      ? { side: { kind: "space", remote: source.remote }, root: source.root, tree: capture.finalTree, fromSource: true }
      : { side: local, root: repository.root, tree: capture.finalTree, fromSource: false },
  );
  if (!capture.baselineInSource && (source || capture.finalTree !== capture.state.baselineTree))
    origins.push({ side: local, root: repository.root, tree: capture.state.baselineTree, fromSource: false });
  if (exclude === undefined && !origins.some((origin) => origin.tree === capture.state.commitTree))
    origins.push({ side: local, root: repository.root, tree: capture.state.commitTree, fromSource: false });

  const manifests = await measure(timings, "workspace.objects.inventory", progress, async () => {
    const result: Array<Map<string, number>> = [];
    for (const origin of origins) {
      const rows =
        origin.fromSource && capture.objects
          ? capture.objects
          : await json<Array<[string, number]>>(
              transfer(origin.side, origin.root, "inventory", { tree: origin.tree, exclude }, undefined, { signal }),
            );
      if (!Array.isArray(rows) || rows.length > 200_000) throw new Error("invalid Git object inventory");
      const entries = new Map<string, number>();
      for (const [id, size] of rows) {
        if (typeof id !== "string" || !oidPattern.test(id) || !Number.isSafeInteger(size) || size < 0)
          throw new Error("invalid Git object inventory entry");
        entries.set(id, size);
      }
      result.push(entries);
    }
    return result;
  });
  const combined = new Map<string, number>();
  for (const entries of manifests) for (const [id, size] of entries) combined.set(id, size);
  const destination: Side = { kind: "space", remote };
  const response = await measure(timings, "workspace.objects.missing", progress, () =>
    json<{ missing: unknown; baseCommit?: string }>(
      transfer(destination, workspaceRoot, prepare ? "prepare" : "missing", {
        cache: layout(remote.home).repo(repositoryKey(repository.remoteUrl)),
        commit: repository.commit,
        remoteUrl: repository.remoteUrl,
        exclude,
      }, Buffer.from(JSON.stringify([...combined.entries()])), { signal }),
    ),
  );
  if (response.baseCommit != null && response.baseCommit !== repository.commit)
    throw new Error("destination returned an unknown Git base commit");
  if (!Array.isArray(response.missing) || response.missing.some((id) => typeof id !== "string" || !combined.has(id)))
    throw new Error("destination requested an unknown Git object");
  const needed = new Set(response.missing as string[]);
  if ([...needed].reduce((total, id) => total + combined.get(id)!, 0) > limit)
    throw new Error("missing Git objects exceed 200 MiB");
  progress?.("workspace.objects.missing", `${needed.size} of ${combined.size} objects required`);

  const frames: Buffer[] = [];
  await measure(timings, "workspace.objects.pack", progress, async () => {
    for (const [index, origin] of origins.entries()) {
      const entries = manifests[index]!;
      const selected = [...needed].filter((id) => entries.has(id)).sort();
      if (!selected.length) continue;
      const packed = await transfer(
        origin.side,
        origin.root,
        "pack",
        {
          exclude,
          trees: origin.fromSource && capture.baselineInSource ? [origin.tree, capture.state.baselineTree] : [origin.tree],
          baseCommit: response.baseCommit,
        },
        Buffer.from(JSON.stringify({ missing: selected, have: [...entries.keys()].filter((id) => !needed.has(id)).sort() })),
        { signal },
      );
      const header = Buffer.alloc(4);
      header.writeUInt32BE(packed.length);
      frames.push(header, packed);
      for (const id of selected) needed.delete(id);
    }
  });
  const framed = Buffer.concat(frames);
  if (needed.size || framed.length > limit) throw new Error("invalid or oversized workspace object transfer");
  timings["workspace.object_bytes"] = framed.length;
  await measure(timings, "workspace.objects.apply", progress, async () => {
    const applied = await json<{ tree: string }>(
      transfer(destination, workspaceRoot, "apply", {
        tree: capture.finalTree,
        baseline: capture.state.baselineTree,
        commitTree: capture.state.commitTree,
        reference,
        filterScript: filterCheck,
      }, framed, { timeoutMs: 600_000, signal }),
    );
    if (applied.tree !== capture.finalTree) throw new Error("workspace verification failed after importing Git objects");
  });
}

export type PreparedWorkspace = { root: string; cwd: string; state: WorkspaceState };

export async function prepareWorkspace(
  remote: Remote,
  executionKey: string,
  repository: Repository,
  source: SpaceWorkspace | undefined,
  timings: Timings,
  progress?: Progress,
  signal?: AbortSignal,
): Promise<PreparedWorkspace> {
  const digest = executionDigest(executionKey);
  const workspaceRoot = layout(remote.home).work(digest.slice(0, 16));
  await run(remote, freeSpaceCheck, { signal, label: "disk check" });
  await setAsideExisting(remote, workspaceRoot, progress, signal);
  const commit = source ? source.state.commit : repository.commit;
  const available = await measure(timings, "workspace.preflight", progress, () =>
    repositoryAvailable(remote, repository, commit, signal),
  );
  let capture = await measure(timings, "workspace.capture", progress, async () =>
    source ? captureSpace(source, source.state.commitTree, signal) : captureLocal(repository),
  );
  if (source && !available) {
    const objects = await measure(timings, "workspace.full-inventory", progress, () =>
      json<Array<[string, number]>>(
        transfer({ kind: "space", remote: source.remote }, source.root, "inventory", {
          tree: capture.finalTree,
          baseline: capture.baselineInSource ? capture.state.baselineTree : undefined,
        }, undefined, { signal }),
      ),
    );
    capture = { ...capture, objects };
  }
  const effective: Repository = { ...repository, commit };
  try {
    if (!available) {
      progress?.("workspace.snapshot", "origin is unavailable on the Space; sending a commit snapshot");
      await measure(timings, "workspace.prepare", progress, () => prepareSnapshot(remote, effective, commit, workspaceRoot, signal));
    }
    await transferObjects(remote, workspaceRoot, effective, capture, source, digest.slice(0, 32), timings, {
      exclude: available ? capture.state.commitTree : undefined,
      prepare: available,
      progress,
      signal,
    });
  } catch (error) {
    await removeWorkspace(remote, workspaceRoot).catch(() => undefined);
    throw error;
  }
  const cwd = repository.relativeCwd === "." ? workspaceRoot : `${workspaceRoot}/${repository.relativeCwd}`;
  return { root: workspaceRoot, cwd, state: capture.state };
}

export async function executionDirectory(remote: Remote, executionKey: string, signal?: AbortSignal): Promise<string> {
  const root = layout(remote.home).work(executionDigest(executionKey).slice(0, 16));
  await run(remote, `mkdir -p ${sh(root)}`, { signal, label: "execution directory" });
  return root;
}

export async function workspaceExists(remote: Remote, root: string, cwd: string, signal?: AbortSignal): Promise<boolean> {
  const result = await run(remote, `test -d ${sh(`${root}/.git`)} && mkdir -p ${sh(cwd)}`, { check: false, signal });
  return result.exitCode === 0;
}

async function setAsideExisting(remote: Remote, root: string, progress?: Progress, signal?: AbortSignal): Promise<void> {
  const aside = `${root}.stranded-${Date.now()}`;
  const result = await run(
    remote,
    `if [ -e ${sh(root)} ]; then mv ${sh(root)} ${sh(aside)}; echo moved; fi`,
    { signal, label: "workspace check" },
  );
  if (result.stdout.includes("moved")) progress?.("workspace.preserve", `kept an earlier workspace at ${aside}`);
}

function assertWorkspaceRoot(remote: Remote, root: string): void {
  const prefix = `${layout(remote.home).root}/work/`;
  if (!root.startsWith(prefix) || !/^[0-9a-f]{16}$/.test(root.slice(prefix.length)))
    throw new Error(`refusing to remove an invalid workspace path on ${remote.name}`);
}

export async function removeWorkspace(remote: Remote, root: string, signal?: AbortSignal): Promise<void> {
  assertWorkspaceRoot(remote, root);
  await run(remote, `rm -rf -- ${sh(root)}`, { timeoutMs: 600_000, signal, label: "workspace cleanup" });
}

export async function cleanupWorkspace(workspace: SpaceWorkspace, signal?: AbortSignal): Promise<void> {
  assertWorkspaceRoot(workspace.remote, workspace.root);
  const result = await json<{ removed?: boolean }>(
    transfer({ kind: "space", remote: workspace.remote }, workspace.root, "cleanup", { expectedRoot: workspace.root }, undefined, { signal }),
  );
  if (result.removed !== true) throw new Error(`${workspace.remote.name} did not confirm workspace cleanup`);
}

async function spaceTree(workspace: SpaceWorkspace, signal?: AbortSignal): Promise<string> {
  const result = await json<{ tree: string }>(
    transfer({ kind: "space", remote: workspace.remote }, workspace.root, "tree", { filterScript: filterCheck }, undefined, { signal }),
  );
  return oid(result.tree, "Space workspace tree");
}

export async function diffStatus(
  workspace: SpaceWorkspace,
  signal?: AbortSignal,
): Promise<{ additions: number; deletions: number; pendingSync: boolean }> {
  const tree = await spaceTree(workspace, signal);
  const stat = await json<{ additions: number; deletions: number }>(
    transfer({ kind: "space", remote: workspace.remote }, workspace.root, "numstat", {
      from: workspace.state.commitTree,
      to: tree,
    }, undefined, { signal }),
  );
  return { additions: stat.additions, deletions: stat.deletions, pendingSync: tree !== workspace.state.baselineTree };
}

function workspacePatch(root: string, from: string, to: string): Buffer {
  const patch = git(root, ["diff", "--binary", "--full-index", oid(from, "tree"), oid(to, "tree"), "--"], { timeout: 600_000 });
  if (patch.length > limit) throw new Error("workspace diff exceeds the 200 MiB limit");
  return patch;
}

function mergePatch(root: string, localTree: string, patch: Buffer): { patch: Buffer; tree: string } {
  if (!patch.length) return { patch, tree: localTree };
  const directory = mkdtempSync(join(tmpdir(), "pi-cua-merge-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(directory, "index") };
    git(root, ["read-tree", localTree], { env });
    try {
      git(root, ["apply", "--cached", "--3way", "--binary", "--whitespace=nowarn"], { env, input: patch });
    } catch {
      throw new Error("local and Space workspace changes conflict; resolve one side before syncing");
    }
    const tree = oid(git(root, ["write-tree"], { env }).toString("utf8").trim(), "merged tree");
    return { patch: workspacePatch(root, localTree, tree), tree };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function trackIgnored(root: string, patch: Buffer): Buffer {
  const summary = git(root, ["apply", "--numstat", "-z"], { input: patch });
  const candidates = summary
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => record.split("\t").slice(2).join("\t"))
    .filter((path) => {
      if (!path) return false;
      try {
        lstatSync(join(root, path));
        return true;
      } catch {
        return false;
      }
    });
  if (!candidates.length) return Buffer.alloc(0);
  let ignored: Buffer;
  try {
    ignored = git(root, ["check-ignore", "-z", "--stdin"], { input: `${candidates.join("\0")}\0` });
  } catch (error) {
    if ((error as { status?: number }).status === 1) return Buffer.alloc(0);
    throw error;
  }
  if (ignored.length)
    git(root, ["--literal-pathspecs", "add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: ignored });
  return ignored;
}

function applyPatch(root: string, patch: Buffer, expectedTree: string, beforeTree: string): void {
  if (workspaceTree(root) !== beforeTree) throw new Error("local workspace changed while the Space sync was running");
  let tracked: Buffer = Buffer.alloc(0);
  if (patch.length) {
    git(root, ["apply", "--binary", "--whitespace=nowarn"], { input: patch });
    tracked = trackIgnored(root, patch);
  }
  if (workspaceTree(root) === expectedTree) return;
  if (patch.length) {
    git(root, ["apply", "--binary", "--whitespace=nowarn", "--reverse"], { input: patch });
    if (tracked.length)
      git(root, ["--literal-pathspecs", "rm", "--cached", "-f", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: tracked });
  }
  throw new Error("workspace verification failed after applying Space changes");
}

export async function syncToLocal(workspace: SpaceWorkspace, localCwd: string, progress?: Progress, signal?: AbortSignal): Promise<boolean> {
  const { state } = workspace;
  const localRoot = realpathSync(state.localRoot);
  if (realpathSync(gitText(localCwd, ["rev-parse", "--show-toplevel"])) !== localRoot)
    throw new Error("local workspace path changed since entering the Space");
  progress?.("workspace.local.verify", "capturing the local workspace");
  const localTree = workspaceTree(localRoot);
  progress?.("workspace.local.diff", "capturing Space changes");
  const spaceFinal = await spaceTree(workspace, signal);
  const spacePatch = await transfer({ kind: "space", remote: workspace.remote }, workspace.root, "diff", {
    from: state.baselineTree,
    to: spaceFinal,
  }, undefined, { timeoutMs: 600_000, signal });
  let patch: Buffer = spacePatch;
  let finalTree = spaceFinal;
  if (localTree !== state.baselineTree) {
    progress?.("workspace.local.merge", "merging local and Space changes");
    ({ patch, tree: finalTree } = mergePatch(localRoot, localTree, spacePatch));
  }
  if (finalTree === localTree) return false;
  progress?.("workspace.local.apply", `applying ${(patch.length / 1048576).toFixed(1)} MiB of Space changes`);
  try {
    applyPatch(localRoot, patch, finalTree, localTree);
  } catch (error) {
    if ((error as { status?: number }).status !== undefined)
      throw new Error("Space changes do not apply cleanly to the local workspace");
    throw error;
  }
  return spacePatch.length > 0;
}
