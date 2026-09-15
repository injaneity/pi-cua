const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const canonical = (value) =>
  process.platform === "win32"
    ? fs.realpathSync(value).toLowerCase()
    : fs.realpathSync(value);
const [action, encoded] = process.argv.slice(-2);
const options = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
const limit = 200 * 1024 * 1024;
const started = performance.now();
const input = fs.readFileSync(0);
const inputMs = performance.now() - started;
let gitMs = 0;
process.on("exit", () =>
  process.stderr.write(
    JSON.stringify({
      cua_git_timing: true,
      action,
      inputMs,
      gitMs,
      totalMs: performance.now() - started,
    }) + "\n",
  ),
);
if (input.length > limit + 8) throw new Error("Git transfer exceeds 200 MiB");
const git = (args, data, root = options.root, timeout = 60000) => {
  const before = performance.now();
  try {
    return execFileSync("git", ["-C", root, ...args], {
      input: data,
      timeout,
      maxBuffer: limit,
      stdio: ["pipe", "pipe", "pipe"],
      env: options.index
        ? { ...process.env, GIT_INDEX_FILE: options.index }
        : process.env,
    });
  } finally {
    gitMs += performance.now() - before;
  }
};
const oid = (value) => {
  if (
    typeof value !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
  )
    throw new Error("Invalid Git object ID");
  return value;
};
const list = (values) => {
  if (!Array.isArray(values) || values.length > 200000)
    throw new Error("Invalid Git object list");
  return values.map(oid);
};
const matchingCommit = (commit, tree) => {
  if (!commit || !tree) return undefined;
  const id = oid(commit);
  if (
    git(["cat-file", "--batch-check=%(objecttype)"], id + "\n")
      .toString()
      .trim() !== "commit"
  )
    return undefined;
  return git(["rev-parse", id + "^{tree}"])
    .toString()
    .trim() === oid(tree)
    ? id
    : undefined;
};
const snapshotCommit = (tree, parent) =>
  git(
    ["hash-object", "-t", "commit", "-w", "--stdin"],
    `tree ${oid(tree)}\nparent ${oid(parent)}\nauthor pi-cua <pi-cua@localhost> 0 +0000\ncommitter pi-cua <pi-cua@localhost> 0 +0000\n\npi-cua transfer\n`,
  )
    .toString()
    .trim();
const json = (value) => process.stdout.write(JSON.stringify(value));
const inventory = (tree) => {
  const ids = git([
    "rev-list",
    "--objects",
    "--no-object-names",
    oid(tree) + "^{tree}",
    ...(options.exclude ? ["--not", oid(options.exclude)] : []),
  ]);
  if (!ids.length) return [];
  const rows = git(
    ["cat-file", "--batch-check=%(objectname) %(objectsize)"],
    ids,
  )
    .toString()
    .trim()
    .split("\n");
  return rows.map((row) => {
    const [id, size] = row.split(" ");
    if (!/^\d+$/.test(size)) throw new Error("Missing source object");
    return [oid(id), Number(size)];
  });
};
const snapshot = () => {
  options.root = git(["rev-parse", "--show-toplevel"]).toString().trim();
  execFileSync(process.execPath, ["-e", options.filterScript, options.root], {
    timeout: 60000,
    maxBuffer: limit,
  });
  const directory = fs.mkdtempSync(
    require("node:path").join(require("node:os").tmpdir(), "cua-index-"),
  );
  const original = git([
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  ])
    .toString()
    .trim();
  try {
    options.index = require("node:path").join(directory, "index");
    if (fs.existsSync(original)) {
      fs.copyFileSync(original, options.index);
      fs.utimesSync(
        options.index,
        0,
        Math.floor(fs.statSync(original).mtimeMs / 1000),
      );
    } else {
      git(["read-tree", "HEAD"]);
    }
    git(["add", "-A", "--", "."]);
    return oid(git(["write-tree"]).toString().trim());
  } finally {
    delete options.index;
    fs.rmSync(directory, { recursive: true });
  }
};
if (action === "inventory") {
  json([
    ...inventory(options.tree),
    ...(options.baseline ? inventory(options.baseline) : []),
  ]);
} else if (action === "snapshot") {
  const tree = snapshot();
  let baselineAvailable = false;
  if (options.baseline) {
    const baseline = oid(options.baseline);
    try {
      git(["cat-file", "-e", baseline + "^{tree}"]);
      baselineAvailable = true;
    } catch {}
  }
  const objects = [
    ...inventory(tree),
    ...(baselineAvailable ? inventory(options.baseline) : []),
  ];
  json({ tree, objects, baselineAvailable });
} else if (action === "missing" || action === "prepare") {
  if (action === "prepare") {
    const path = require("node:path");
    const commit = oid(options.commit);
    git(["cat-file", "-e", commit + "^{commit}"], undefined, options.cache);
    fs.mkdirSync(path.dirname(options.root), { recursive: true });
    if (!fs.existsSync(path.join(options.root, ".git"))) {
      git(
        ["clone", "--shared", "--no-checkout", options.cache, options.root],
        undefined,
        options.cache,
      );
      git(["update-ref", "--no-deref", "HEAD", commit]);
    } else {
      if (
        !fs.lstatSync(options.root).isDirectory() ||
        !fs.lstatSync(path.join(options.root, ".git")).isDirectory() ||
        canonical(git(["rev-parse", "--show-toplevel"]).toString().trim()) !==
          canonical(options.root)
      )
        throw new Error("Invalid destination workspace root");
      git(["checkout", "--detach", "--force", commit]);
      git(["clean", "-ffd"]);
    }
    git(["remote", "set-url", "origin", options.remoteUrl]);
  }
  const entries = JSON.parse(input.toString());
  const ids = list(entries.map(([id]) => id));
  if (entries.some(([, size]) => !Number.isSafeInteger(size) || size < 0))
    throw new Error("Invalid Git object size");
  const sizes = new Map(entries);
  if (options.exclude)
    git(["cat-file", "-e", oid(options.exclude) + "^{tree}"]);
  const missing = () =>
    ids.length
      ? git(
          ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
          ids.join("\n") + "\n",
        )
          .toString()
          .trim()
          .split("\n")
          .filter((row) => row.endsWith(" missing"))
          .map((row) => oid(row.split(" ")[0]))
      : [];
  let absent = missing();
  let refreshed = false;
  let refreshFailed = false;
  if (
    options.cache &&
    absent.reduce((n, id) => n + sizes.get(id), 0) > 1048576 &&
    fs.existsSync(options.cache)
  ) {
    try {
      git(
        [
          "-c",
          "gc.auto=0",
          "-c",
          "maintenance.auto=false",
          "-c",
          "http.lowSpeedLimit=1024",
          "-c",
          "http.lowSpeedTime=10",
          "fetch",
          "--no-tags",
          "origin",
          "HEAD",
        ],
        undefined,
        options.cache,
        20000,
      );
      refreshed = true;
    } catch {
      refreshFailed = true;
    }
    absent = missing();
  }
  json({
    missing: absent,
    refreshed,
    refreshFailed,
    baseCommit: matchingCommit(options.commit, options.exclude),
  });
} else if (action === "pack") {
  const request = JSON.parse(input.toString());
  const ids = list(request.missing);
  const have = list(request.have);
  if (!ids.length) throw new Error("Empty pack request");
  const base = options.trees
    ? matchingCommit(options.baseCommit, options.exclude)
    : undefined;
  const roots = list(options.trees ?? ids);
  const revisions = [
    ...roots.map((tree) => (base ? snapshotCommit(tree, base) : tree)),
    ...have.map((id) => "^" + id),
    ...(base || options.exclude ? ["^" + oid(base ?? options.exclude)] : []),
  ];
  process.stdout.write(
    git(
      [
        "pack-objects",
        "--stdout",
        "--revs",
        "--thin",
        "--no-reuse-object",
        "--compression=6",
      ],
      revisions.join("\n") + "\n",
    ),
  );
} else if (action === "cleanup") {
  const path = require("node:path");
  const expected = path.resolve(options.expectedRoot);
  if (
    !/^[a-f0-9]{16}$/i.test(path.basename(expected)) ||
    fs.lstatSync(expected).isSymbolicLink()
  )
    throw new Error("Invalid cleanup workspace");
  const actual = git(["rev-parse", "--show-toplevel"]).toString().trim();
  if (canonical(actual) !== canonical(expected))
    throw new Error("Source workspace root mismatch");
  fs.rmSync(expected, { recursive: true });
  json({ removed: true });
} else if (action === "apply") {
  const tree = oid(options.tree);
  const baseline = oid(options.baseline);
  if (!/^[a-f0-9]{32}$/.test(options.reference))
    throw new Error("Invalid snapshot reference");
  let offset = 0;
  while (offset < input.length) {
    if (offset + 4 > input.length) throw new Error("Truncated pack frame");
    const size = input.readUInt32BE(offset);
    offset += 4;
    if (size < 12 || offset + size > input.length)
      throw new Error("Invalid pack frame");
    git(
      ["index-pack", "--stdin", "--fix-thin", "--strict"],
      input.subarray(offset, offset + size),
    );
    offset += size;
  }
  for (const id of [
    tree,
    baseline,
    ...(options.commitTree ? [oid(options.commitTree)] : []),
  ]) {
    if (git(["cat-file", "-t", id]).toString().trim() !== "tree")
      throw new Error("Missing snapshot tree");
  }
  git(["read-tree", "--reset", "-u", tree]);
  const actual = snapshot();
  if (actual !== tree)
    throw new Error(
      "workspace verification failed after importing Git objects",
    );
  git([
    "update-ref",
    "refs/cua-pi/sync/" + options.reference + "/workspace",
    tree,
  ]);
  git([
    "update-ref",
    "refs/cua-pi/sync/" + options.reference + "/baseline",
    baseline,
  ]);
  if (options.commitTree)
    git([
      "update-ref",
      "refs/cua-pi/sync/" + options.reference + "/origin",
      oid(options.commitTree),
    ]);
  json({ tree });
} else {
  throw new Error("Unknown Git transfer action");
}
