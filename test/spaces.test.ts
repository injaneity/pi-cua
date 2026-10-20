import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { probe } from "../remote.ts";
import { spaceOperations } from "../tools.ts";
import { cleanupWorkspace, diffStatus, inspectWorkspace, prepareWorkspace, type SpaceWorkspace, syncToLocal } from "../workspace.ts";
import { FakeSpacesClient } from "./fake-spaces.ts";

process.env.PI_CUA_ALLOW_LOCAL_ORIGIN = "1";
const scratch = mkdtempSync(join(tmpdir(), "pi-cua-spaces-test-"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

after(() => {
  if (process.env.PI_CUA_KEEP !== "1") rmSync(scratch, { recursive: true, force: true });
});

describe("workspace moves between Spaces", () => {
  const origin = join(scratch, "origin.git");
  const local = join(scratch, "local");
  const client = new FakeSpacesClient(
    ["a", "b", "c"].map((id) => {
      const home = join(scratch, `home-${id}`);
      mkdirSync(home, { recursive: true });
      return { id: `fake:${id}`, name: `space-${id}`, os: "macos", provider: "local", online: true, home };
    }),
  );

  before(() => {
    execFileSync("git", ["init", "-q", "--bare", origin]);
    execFileSync("git", ["clone", "-q", origin, local]);
    git(local, "config", "user.email", "test@example.invalid");
    git(local, "config", "user.name", "test");
    writeFileSync(join(local, ".gitignore"), "build/\n");
    writeFileSync(join(local, "README.md"), "hello\n");
    writeFileSync(join(local, "tool.sh"), "#!/bin/sh\necho tool\n");
    chmodSync(join(local, "tool.sh"), 0o755);
    writeFileSync(join(local, "blob.bin"), Buffer.from([0, 1, 2, 255, 254]));
    git(local, "add", ".");
    git(local, "commit", "-qm", "base");
    git(local, "push", "-q", "origin", "HEAD");
    writeFileSync(join(local, "README.md"), "hello local edit\n");
    writeFileSync(join(local, "untracked.txt"), "untracked\n");
  });

  test("local → A → B → local keeps every change and merges a concurrent local edit", async () => {
    const remoteA = (await probe(client, client.spaces[0]!)).remote;
    const remoteB = (await probe(client, client.spaces[1]!)).remote;
    const repository = inspectWorkspace(local)!;
    assert.ok(repository);

    const a = await prepareWorkspace(remoteA, "session-1", repository, undefined, {});
    assert.equal(readFileSync(join(a.cwd, "README.md"), "utf8"), "hello local edit\n");
    assert.equal(readFileSync(join(a.cwd, "untracked.txt"), "utf8"), "untracked\n");
    assert.deepEqual(readFileSync(join(a.cwd, "blob.bin")), Buffer.from([0, 1, 2, 255, 254]));
    writeFileSync(join(a.cwd, "from-a.txt"), "made on A\n");
    writeFileSync(join(a.cwd, "README.md"), "hello local edit\nand A\n");
    const workspaceA: SpaceWorkspace = { remote: remoteA, root: a.root, state: a.state };
    const statusA = await diffStatus(workspaceA);
    assert.equal(statusA.pendingSync, true);
    assert.ok(statusA.additions >= 2);

    const b = await prepareWorkspace(remoteB, "session-1", repository, workspaceA, {});
    assert.equal(readFileSync(join(b.cwd, "from-a.txt"), "utf8"), "made on A\n");
    assert.equal(readFileSync(join(b.cwd, "README.md"), "utf8"), "hello local edit\nand A\n");
    assert.ok(execFileSync("test", ["-x", join(b.cwd, "tool.sh")]) !== undefined);
    await cleanupWorkspace(workspaceA);
    assert.equal(existsSync(a.root), false);

    writeFileSync(join(b.cwd, "from-b.txt"), "made on B\n");
    writeFileSync(join(local, "local-later.txt"), "local while away\n");
    const changed = await syncToLocal({ remote: remoteB, root: b.root, state: b.state }, local);
    assert.equal(changed, true);
    assert.equal(readFileSync(join(local, "from-a.txt"), "utf8"), "made on A\n");
    assert.equal(readFileSync(join(local, "from-b.txt"), "utf8"), "made on B\n");
    assert.equal(readFileSync(join(local, "README.md"), "utf8"), "hello local edit\nand A\n");
    assert.equal(readFileSync(join(local, "local-later.txt"), "utf8"), "local while away\n");
  });

  test("falls back to a commit snapshot when the Space cannot reach origin", async () => {
    const remoteC = (await probe(client, client.spaces[2]!)).remote;
    const repository = inspectWorkspace(local)!;
    const hidden = `${origin}.hidden`;
    renameSync(origin, hidden);
    try {
      const c = await prepareWorkspace(remoteC, "session-2", repository, undefined, {});
      assert.equal(readFileSync(join(c.cwd, "from-b.txt"), "utf8"), "made on B\n");
      assert.equal(readFileSync(join(c.cwd, "untracked.txt"), "utf8"), "untracked\n");
    } finally {
      renameSync(hidden, origin);
    }
  });

  test("preparing over an existing workspace keeps the earlier copy instead of wiping it", async () => {
    const remoteC = (await probe(client, client.spaces[2]!)).remote;
    const repository = inspectWorkspace(local)!;
    const first = await prepareWorkspace(remoteC, "session-3", repository, undefined, {});
    writeFileSync(join(first.cwd, "unsynced.txt"), "only copy\n");
    const second = await prepareWorkspace(remoteC, "session-3", repository, undefined, {});
    assert.equal(second.root, first.root);
    assert.equal(existsSync(join(second.cwd, "unsynced.txt")), false);
    const kept = readdirSync(join(remoteC.home, ".cua-pi", "work")).filter((name) => name.startsWith(`${basename(first.root)}.stranded-`));
    assert.equal(kept.length, 1);
    assert.equal(readFileSync(join(remoteC.home, ".cua-pi", "work", kept[0]!, "unsynced.txt"), "utf8"), "only copy\n");
  });

  test("refuses workspaces with Git filters it cannot reproduce", () => {
    writeFileSync(join(local, ".gitattributes"), "*.bin filter=lfs\n");
    try {
      assert.throws(() => inspectWorkspace(local), /unsupported Git attribute/);
    } finally {
      rmSync(join(local, ".gitattributes"));
    }
  });
});

describe("pi tools on a Space", () => {
  const home = join(scratch, "home-tools");
  const localCwd = join(scratch, "local-cwd");
  const client = new FakeSpacesClient([{ id: "fake:tools", name: "space-tools", os: "macos", provider: "local", online: true, home }]);
  let ops: ReturnType<typeof spaceOperations>;
  let remoteCwd: string;
  const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map((block) => block.text ?? "").join("\n");

  before(async () => {
    remoteCwd = join(home, "work");
    mkdirSync(join(remoteCwd, "src"), { recursive: true });
    mkdirSync(localCwd, { recursive: true });
    git(remoteCwd, "init", "-q");
    writeFileSync(join(remoteCwd, "hello.txt"), "hi from the Space\n");
    writeFileSync(join(remoteCwd, "src", "a.ts"), "export const answer = 42;\n");
    const { remote } = await probe(client, client.spaces[0]!);
    ops = spaceOperations(remote, localCwd, remoteCwd);
  });

  test("read, write and edit act on the Space, never the local directory", async () => {
    const read = await createReadToolDefinition(localCwd, { operations: ops.read }).execute("1", { path: "hello.txt" }, undefined, undefined, undefined as never);
    assert.match(text(read), /hi from the Space/);
    await createWriteToolDefinition(localCwd, { operations: ops.write }).execute("2", { path: "new/dir/file.txt", content: "written\n" }, undefined, undefined, undefined as never);
    assert.equal(readFileSync(join(remoteCwd, "new/dir/file.txt"), "utf8"), "written\n");
    await createEditToolDefinition(localCwd, { operations: ops.edit }).execute(
      "3",
      { path: join(localCwd, "hello.txt"), edits: [{ oldText: "hi", newText: "hello" }] },
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(readFileSync(join(remoteCwd, "hello.txt"), "utf8"), "hello from the Space\n");
    assert.equal(existsSync(join(localCwd, "hello.txt")), false);
    await assert.rejects(
      createReadToolDefinition(localCwd, { operations: ops.read }).execute("4", { path: "missing.txt" }, undefined, undefined, undefined as never),
    );
  });

  test("bash streams output, reports exit codes, times out and cancels", async () => {
    const bash = createBashToolDefinition(localCwd, { operations: ops.bash });
    const ok = await bash.execute("5", { command: "pwd; echo err >&2" }, undefined, undefined, undefined as never);
    assert.match(text(ok), new RegExp(remoteCwd.replaceAll("/", "\\/")));
    assert.match(text(ok), /err/);
    const failed = await bash.execute("6", { command: "exit 3" }, undefined, undefined, undefined as never);
    assert.match(text(failed), /exited with code 3/);
    await assert.rejects(bash.execute("7", { command: "sleep 5", timeout: 1 }, undefined, undefined, undefined as never), /timed out after 1 seconds/);
    const marker = join(remoteCwd, "should-not-exist");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    await assert.rejects(bash.execute("8", { command: `sleep 2; touch ${marker}` }, controller.signal, undefined, undefined as never), /aborted/);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(existsSync(marker), false);
  });

  test("find globs and grep searches the Space", async () => {
    const found = await createFindToolDefinition(localCwd, { operations: ops.find }).execute("9", { pattern: "*.ts" }, undefined, undefined, undefined as never);
    assert.match(text(found), /src\/a\.ts/);
    const output = await ops.grep(["git", "grep", "--no-index", "--exclude-standard", "-n", "-e", "answer"], localCwd);
    assert.match(output, /src\/a\.ts:1:export const answer/);
    assert.equal(await ops.grep(["git", "grep", "--no-index", "-n", "-e", "nothing-matches-this"], localCwd), "");
  });
});
