import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
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
test("object transfer preserves ignored files, modes, deletions, binary data and dirty baseline", () => {
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
    execFileSync("git", ["clone", "--no-local", source, target], {
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
        rpc(source, "inventory", undefined, { tree: baseline, exclude: base }),
      ),
    ]);
    const missing = JSON.parse(
      rpc(target, "missing", json([...inventory]), { exclude: base }),
    ).missing;
    const pack = rpc(
      source,
      "pack",
      json({
        missing,
        have: [...inventory.keys()].filter((id) => !missing.includes(id)),
      }),
      { exclude: base },
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
      git(target, "ls-files", "--stage", "shared/journal.test.cjs").toString(),
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
    writeFileSync(join(source, ".gitattributes"), "*.bin filter=unsupported\n");
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
