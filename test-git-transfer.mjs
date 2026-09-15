import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const script = readFileSync(
  new URL("git-transfer.cjs", import.meta.url),
  "utf8",
);
const backend = readFileSync(new URL("backend.py", import.meta.url), "utf8");
const filterScript = backend.match(
  /WORKSPACE_FILTER_CHECK = r"""([\s\S]*?)"""/,
)[1];
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args]);
const rpc = (root, action, input = Buffer.alloc(0), options = {}) => {
  const args = [
    "-e",
    script,
    action,
    Buffer.from(JSON.stringify({ root, filterScript, ...options })).toString(
      "base64",
    ),
  ];
  const configuration = {
    input,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  };
  if (process.platform === "win32") {
    args[1] = `eval(Buffer.from('${Buffer.from(script).toString("base64")}','base64').toString('utf8'))`;
    const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
    return execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "& " +
          [process.execPath, ...args].map(quote).join(" ") +
          "; exit $LASTEXITCODE",
      ],
      configuration,
    );
  }
  return execFileSync(process.execPath, args, configuration);
};
const json = (value) => Buffer.from(JSON.stringify(value));
const frame = (pack) => {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(pack.length);
  return Buffer.concat([size, pack]);
};
for (const prepare of [false, true])
  test(`object transfer preserves ignored files, modes, deletions, binary data and dirty baseline (prepare=${prepare})`, () => {
    const directory = mkdtempSync(join(tmpdir(), "cua-git-test-"));
    try {
      const source = join(directory, "source"),
        target = join(directory, "target");
      mkdirSync(source);
      git(source, "init", "-q");
      git(source, "config", "user.name", "test");
      git(source, "config", "user.email", "test@example.invalid");
      writeFileSync(join(source, ".gitignore"), "shared/\n");
      writeFileSync(join(source, "deleted.txt"), "delete me\n");
      git(source, "add", ".");
      git(source, "commit", "-qm", "base");
      const base = git(source, "rev-parse", "HEAD^{tree}").toString().trim();
      const commit = git(source, "rev-parse", "HEAD").toString().trim();
      const cache = join(directory, "cache.git");
      execFileSync("git", ["clone", "--mirror", "--no-local", source, cache], {
        stdio: "pipe",
      });
      if (!prepare)
        execFileSync("git", ["clone", "--no-local", cache, target], {
          stdio: "pipe",
        });
      writeFileSync(join(source, "local.txt"), "original local baseline\n");
      const baseline = JSON.parse(
        rpc(source, "snapshot", undefined, { exclude: base }),
      ).tree;
      writeFileSync(join(source, "local.txt"), "changed in guest\n");
      rmSync(join(source, "deleted.txt"));
      mkdirSync(join(source, "shared"));
      writeFileSync(join(source, "shared", "journal.test.cjs"), "fixture\n");
      chmodSync(join(source, "shared", "journal.test.cjs"), 0o755);
      git(source, "add", "-f", "shared/journal.test.cjs");
      git(source, "update-index", "--chmod=+x", "shared/journal.test.cjs");
      writeFileSync(
        join(source, "binary.bin"),
        Buffer.from([0, 255, 13, 10, 128]),
      );
      const staged = git(source, "diff", "--cached", "--binary");
      const snapshot = JSON.parse(
        rpc(source, "snapshot", undefined, { exclude: base, baseline }),
      );
      assert.equal(snapshot.baselineAvailable, true);
      assert.deepEqual(git(source, "diff", "--cached", "--binary"), staged);
      const inventory = new Map([
        ...snapshot.objects,
        ...JSON.parse(
          rpc(source, "inventory", undefined, {
            tree: baseline,
            exclude: base,
          }),
        ),
      ]);
      const missing = JSON.parse(
        rpc(target, prepare ? "prepare" : "missing", json([...inventory]), {
          exclude: base,
          cache,
          commit,
          remoteUrl: "https://example.invalid/repo",
        }),
      ).missing;
      assert.equal(git(target, "rev-parse", "HEAD").toString().trim(), commit);
      if (prepare) assert.equal(existsSync(join(target, ".gitignore")), false);
      const pack = rpc(
        source,
        "pack",
        json({
          missing,
          have: [...inventory.keys()].filter((id) => !missing.includes(id)),
        }),
        { exclude: base, trees: [snapshot.tree, baseline], baseCommit: commit },
      );
      const result = JSON.parse(
        rpc(target, "apply", frame(pack), {
          tree: snapshot.tree,
          baseline,
          reference: "a".repeat(32),
        }),
      );
      assert.equal(result.tree, snapshot.tree);
      assert.equal(JSON.parse(rpc(target, "snapshot")).tree, snapshot.tree);
      assert.equal(
        git(target, "show", baseline + ":local.txt").toString(),
        "original local baseline\n",
      );
      assert.deepEqual(
        readFileSync(join(target, "binary.bin")),
        Buffer.from([0, 255, 13, 10, 128]),
      );
      assert.match(
        git(
          target,
          "ls-files",
          "--stage",
          "shared/journal.test.cjs",
        ).toString(),
        /^100755 /,
      );
      assert.deepEqual(
        JSON.parse(
          rpc(target, "missing", json([...inventory]), { exclude: base }),
        ).missing,
        [],
      );
      assert.throws(
        () =>
          rpc(target, "apply", Buffer.from([1, 2]), {
            tree: snapshot.tree,
            baseline,
            reference: "a".repeat(32),
          }),
        /Truncated pack/,
      );
      assert.equal(JSON.parse(rpc(target, "snapshot")).tree, snapshot.tree);
      writeFileSync(
        join(source, ".gitattributes"),
        "*.bin filter=unsupported\n",
      );
      assert.throws(
        () => rpc(source, "snapshot"),
        (error) => {
          assert.match(
            error.stderr.toString(),
            /unsupported Git attribute: filter=unsupported/,
          );
          return true;
        },
      );
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
test("small edits to large existing files transfer as deltas", () => {
  const parent = mkdtempSync(join(tmpdir(), "cua-delta-test-"));
  const root = join(parent, "source");
  const target = join(parent, "target");
  try {
    mkdirSync(root);
    git(root, "init", "-q");
    git(root, "config", "user.name", "test");
    git(root, "config", "user.email", "test@example.invalid");
    const original =
      Array.from({ length: 4096 }, (_, i) =>
        createHash("sha256").update(String(i)).digest("hex"),
      ).join("\n") + "\n";
    writeFileSync(join(root, "lock.txt"), original);
    git(root, "add", ".");
    git(root, "commit", "-qm", "base");
    const base = git(root, "rev-parse", "HEAD^{tree}").toString().trim();
    execFileSync("git", ["clone", "--no-local", root, target], {
      stdio: "pipe",
    });
    writeFileSync(join(root, "lock.txt"), original + "changed\n");
    git(root, "add", ".");
    const tree = git(root, "write-tree").toString().trim();
    const blob = git(root, "rev-parse", ":lock.txt").toString().trim();
    const pack = rpc(root, "pack", json({ missing: [blob, tree], have: [] }), {
      trees: [tree],
      exclude: base,
      baseCommit: git(root, "rev-parse", "HEAD").toString().trim(),
    });
    assert.ok(
      pack.length < 8192,
      `small edit produced a ${pack.length}-byte pack`,
    );
    rpc(target, "apply", frame(pack), {
      tree,
      baseline: base,
      commitTree: base,
      reference: "a".repeat(32),
    });
    assert.equal(
      git(target, "show", tree + ":lock.txt").toString(),
      original + "changed\n",
    );
  } finally {
    rmSync(parent, { recursive: true });
  }
});

test("preparation refuses a redirected destination worktree", () => {
  const parent = mkdtempSync(join(tmpdir(), "cua-prepare-test-"));
  const root = join(parent, "repo");
  const outside = join(parent, "outside");
  try {
    mkdirSync(root);
    mkdirSync(outside);
    git(root, "init", "-q");
    git(root, "config", "user.name", "test");
    git(root, "config", "user.email", "test@example.invalid");
    writeFileSync(join(root, "protected.txt"), "base");
    git(root, "add", ".");
    git(root, "commit", "-qm", "base");
    const commit = git(root, "rev-parse", "HEAD").toString().trim();
    writeFileSync(join(outside, "protected.txt"), "private");
    git(root, "config", "core.worktree", outside);
    assert.throws(() =>
      rpc(root, "prepare", json([]), {
        cache: root,
        commit,
        remoteUrl: "https://example.invalid/repo",
      }),
    );
    assert.equal(
      readFileSync(join(outside, "protected.txt"), "utf8"),
      "private",
    );
  } finally {
    rmSync(parent, { recursive: true });
  }
});

test("source cleanup removes only the declared Git workspace", () => {
  const parent = mkdtempSync(join(tmpdir(), "cua-cleanup-test-"));
  const root = join(parent, "a".repeat(16));
  const sibling = join(parent, "b".repeat(16));
  try {
    mkdirSync(root);
    mkdirSync(sibling);
    git(root, "init", "-q");
    writeFileSync(join(sibling, "keep.txt"), "keep");
    assert.throws(() =>
      rpc(root, "cleanup", undefined, { expectedRoot: sibling }),
    );
    assert.ok(existsSync(root));
    assert.equal(readFileSync(join(sibling, "keep.txt"), "utf8"), "keep");
    assert.deepEqual(
      JSON.parse(rpc(root, "cleanup", undefined, { expectedRoot: root })),
      { removed: true },
    );
    assert.ok(!existsSync(root));
    assert.equal(readFileSync(join(sibling, "keep.txt"), "utf8"), "keep");
  } finally {
    rmSync(parent, { recursive: true });
  }
});

test("invalid object IDs and missing claimed baselines are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "cua-git-test-"));
  try {
    git(root, "init", "-q");
    assert.throws(
      () => rpc(root, "pack", json({ missing: ["--all"], have: [] })),
      /Invalid Git object ID/,
    );
    assert.throws(() =>
      rpc(root, "missing", json([]), { exclude: "f".repeat(40) }),
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});
