import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { buildRuntime } from "../config.ts";
import { layout } from "../remote.ts";
import { ensurePi, ensureRuntime, hostFiles, probe, RemoteHost } from "../setup.ts";
import { cleanupWorkspace, diffStatus, inspectWorkspace, prepareWorkspace, type SpaceWorkspace, syncToLocal } from "../workspace.ts";
import { FakeSpacesClient } from "./fake-spaces.ts";

process.env.PI_CUA_ALLOW_LOCAL_ORIGIN = "1";
const nodeModules = join(import.meta.dirname, "..", "node_modules");
const piVersion = JSON.parse(readFileSync(join(nodeModules, "@earendil-works/pi-coding-agent/package.json"), "utf8")).version;
const scratch = mkdtempSync(join(tmpdir(), "pi-cua-spaces-test-"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

after(() => {
  if (process.env.PI_CUA_KEEP !== "1") rmSync(scratch, { recursive: true, force: true });
});

function agentDir(name: string, extra: Record<string, unknown> = {}): string {
  const dir = join(scratch, name);
  mkdirSync(join(dir, "extensions"), { recursive: true });
  mkdirSync(join(dir, "skills", "demo"), { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ theme: "dark", apiToken: "secret", logPath: "/var/log/x", ...extra }));
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ key: "never" }));
  writeFileSync(join(dir, "skills", "demo", "SKILL.md"), "# demo\n");
  writeFileSync(join(dir, "skills", "demo", ".env"), "TOKEN=1\n");
  return dir;
}

describe("runtime snapshot", () => {
  test("drops credentials and controller-only settings, and hashes deterministically", () => {
    const dir = agentDir("agent-a");
    const inputs = { agentDir: dir, piVersion, packages: ["npm:demo@1.0.0"], toolFiles: [], skillFiles: [], hostFiles: hostFiles() };
    const first = buildRuntime(inputs);
    const second = buildRuntime(inputs);
    assert.equal(first.hash, second.hash);
    assert.match(first.hash, /^[0-9a-f]{20}$/);
    assert.ok(first.warnings.some((warning) => warning.includes("credential setting: settings.json.apiToken")));
    assert.ok(first.warnings.some((warning) => warning.includes("controller-only file: auth.json")));
    assert.ok(first.warnings.some((warning) => warning.includes(".env")));
    writeFileSync(join(dir, "skills", "demo", "SKILL.md"), "# changed\n");
    assert.notEqual(buildRuntime(inputs).hash, first.hash);
  });
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

describe("tool host over the exec relay", () => {
  const home = join(scratch, "home-host");
  const client = new FakeSpacesClient([{ id: "fake:host", name: "space-host", os: "macos", provider: "local", online: true, home }]);
  let host: RemoteHost;

  before(async () => {
    mkdirSync(home, { recursive: true });
    const piRoot = layout(home).pi(piVersion);
    mkdirSync(piRoot, { recursive: true });
    symlinkSync(nodeModules, join(piRoot, "node_modules"));
    writeFileSync(join(piRoot, "complete"), "");
    const { remote } = await probe(client, client.spaces[0]!);
    assert.equal(await ensurePi(remote, piVersion), piRoot);
    const runtime = buildRuntime({ agentDir: agentDir("agent-host"), piVersion, packages: [], toolFiles: [], skillFiles: [], hostFiles: hostFiles() });
    const runtimeRoot = await ensureRuntime(remote, runtime, piRoot);
    assert.equal(existsSync(join(runtimeRoot, "complete")), true);
    const cwd = join(home, "work");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "hello.txt"), "hi from the Space\n");
    host = new RemoteHost(remote, "0123456789abcdef", runtime.hash, runtimeRoot, piRoot, cwd, ["read", "bash", "edit", "write"]);
    await host.ensure();
  });

  after(async () => {
    await host?.shutdown();
  });

  test("describes tools and runs read through the relay", async () => {
    assert.ok(host.definition("read"));
    const result = await host.execute("read", "call-1", { path: "hello.txt" }, undefined, undefined);
    assert.match(JSON.stringify(result.content), /hi from the Space/);
  });

  test("runs user bash with output, exit code and timeout", async () => {
    const chunks: Buffer[] = [];
    const ok = await host.bash("bash-1", "echo out; echo err >&2; exit 3", { onData: (data) => chunks.push(data) });
    assert.equal(ok.exitCode, 3);
    assert.match(Buffer.concat(chunks).toString(), /out[\s\S]*err|err[\s\S]*out/);
    await assert.rejects(host.bash("bash-2", "sleep 5", { onData: () => {}, timeout: 1 }), /^Error: timeout:1$/);
  });

  test("cancels a running command on the Space when aborted", async () => {
    const marker = join(home, "work", "should-not-exist");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1000);
    await assert.rejects(host.bash("bash-3", `sleep 3; touch ${marker}`, { onData: () => {}, signal: controller.signal }), /aborted/);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    assert.equal(existsSync(marker), false);
  });

  test("restarts the host when it has gone away", async () => {
    await host.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const result = await host.execute("read", "call-2", { path: "hello.txt" }, undefined, undefined);
    assert.match(JSON.stringify(result.content), /hi from the Space/);
  });
});
