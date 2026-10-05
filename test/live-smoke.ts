import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntime } from "../config.ts";
import { ensurePi, ensureRuntime, hostFiles, probe, RemoteHost } from "../setup.ts";
import { WorkerSpacesClient } from "../spaces.ts";
import { cleanupWorkspace, executionDigest, inspectWorkspace, prepareWorkspace, syncToLocal } from "../workspace.ts";

const [spaceName = "mac-studio", piVersion = "1.0.1", fffPackage = "npm:@ff-labs/pi-fff@0.11.0"] = process.argv.slice(2);
const started = performance.now();
const step = (name: string) => console.log(`${((performance.now() - started) / 1000).toFixed(1)}s ${name}`);
const client = new WorkerSpacesClient();
const scratch = mkdtempSync(join(tmpdir(), "pi-cua-live-"));
let host: RemoteHost | undefined;
let cleanup: (() => Promise<void>) | undefined;

try {
  const space = (await client.list()).find((item) => item.name === spaceName);
  assert.ok(space?.online, `${spaceName} is not online: ${space?.reason}`);
  const { remote, probe: probed } = await probe(client, space);
  step(`probe ${remote.os} home=${probed.home} free=${Math.round(probed.freeBytes / 2 ** 30)}GiB`);

  const piRoot = await ensurePi(remote, piVersion);
  step(`pi ${piVersion} at ${piRoot}`);
  const runtime = buildRuntime({
    agentDir: join(homedir(), ".pi", "agent"),
    piVersion,
    packages: [fffPackage],
    toolFiles: [],
    skillFiles: [],
    hostFiles: hostFiles(),
  });
  step(`runtime ${runtime.hash} bundle=${runtime.bundle.length}B warnings=${runtime.warnings.length}`);
  const runtimeRoot = await ensureRuntime(remote, runtime, piRoot);
  step(`runtime ready at ${runtimeRoot}`);

  const local = join(scratch, "Hello-World");
  execFileSync("git", ["clone", "-q", "https://github.com/octocat/Hello-World.git", local]);
  writeFileSync(join(local, "README"), "edited locally before entering\n");
  writeFileSync(join(local, "notes.txt"), "untracked local note\n");
  const repository = inspectWorkspace(local)!;
  const key = `live-smoke-${Date.now()}`;
  const timings: Record<string, number> = {};
  const workspace = await prepareWorkspace(remote, key, repository, undefined, timings);
  cleanup = () => cleanupWorkspace({ remote, root: workspace.root, state: workspace.state });
  step(`workspace ${workspace.root} ${JSON.stringify(timings)}`);

  host = new RemoteHost(remote, executionDigest(key).slice(0, 16), runtime.hash, runtimeRoot, piRoot, workspace.cwd, ["read", "bash", "edit", "write"]);
  await host.ensure();
  const tools = ["read", "bash", "edit", "write", "find", "grep", "fffind", "ffgrep"].filter((name) => host!.definition(name));
  step(`host ready with ${tools.join(", ")}`);

  const read = await host.execute("read", "smoke-read", { path: "README" }, undefined, undefined);
  assert.match(JSON.stringify(read.content), /edited locally before entering/);
  const output: Buffer[] = [];
  const shell = await host.bash("smoke-bash", "uname -sm; ls", { onData: (data) => output.push(data) });
  assert.equal(shell.exitCode, 0);
  assert.match(Buffer.concat(output).toString(), /notes\.txt/);
  step(`read + bash ok: ${Buffer.concat(output).toString().split("\n")[0]}`);
  const finder = tools.find((name) => name === "fffind" || name === "find");
  if (finder) {
    const found = await host.execute(finder, "smoke-find", { pattern: "notes" }, undefined, undefined);
    assert.match(JSON.stringify(found.content), /notes/);
    step(`${finder} (routed extension tool) ok`);
  }
  const marker = `pi-cua-cancel-${Date.now()}`;
  const cancelled = await host
    .bash("smoke-cancel", `sleep 300 # ${marker}`, { onData: () => {}, signal: AbortSignal.timeout(2_000) })
    .then(() => "finished", (error: Error) => error.message);
  assert.notEqual(cancelled, "finished");
  const left = await host.bash("smoke-cancel-check", `pgrep -f '[s]leep 300 # ${marker}' || true`, { onData: (data) => output.push(data) });
  assert.equal(left.exitCode, 0);
  assert.doesNotMatch(Buffer.concat(output).toString(), /^\d+$/m);
  step(`cancel ok: ${cancelled}`);
  await host.execute("write", "smoke-write", { path: "from-space.txt", content: "written on the Space\n" }, undefined, undefined);

  const changed = await syncToLocal({ remote, root: workspace.root, state: workspace.state }, local);
  assert.equal(changed, true);
  assert.equal(readFileSync(join(local, "from-space.txt"), "utf8"), "written on the Space\n");
  step("synced back to local");
} finally {
  await host?.shutdown().catch(() => undefined);
  await cleanup?.().catch((error) => console.error(`cleanup failed: ${error}`));
  client.close();
  rmSync(scratch, { recursive: true, force: true });
  step("cleaned up");
}
