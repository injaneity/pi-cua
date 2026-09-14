import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createAgentSessionRuntime,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
const fixture = JSON.parse(await readFile(process.argv[2], "utf8"));
const base = dirname(fileURLToPath(import.meta.url));
const cwd = fixture.state.localRoot;
const agentDir =
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const manager = SessionManager.inMemory(cwd);
const executionId = manager.getSessionId();
const run = promisify(execFile);
const python = async (code, payload) => {
  const result = await run(
    "python3",
    [
      "-c",
      `import sys,json,hashlib,shlex\nsys.path.insert(0,${JSON.stringify(base)})\nimport backend\ndata=json.loads(sys.argv[1])\n${code}`,
      JSON.stringify(payload),
    ],
    { timeout: 120000, maxBuffer: 1024 * 1024 },
  );
  return result.stdout.trim();
};
const sourceRoot = await python(
  `identity=backend.execution_digest(data['executionId'])[:16]\nroot=backend.guest_home('macos')+'/workspaces/'+identity\ncommand='git clone --shared --no-checkout '+shlex.quote(data['mac_template'])+' '+shlex.quote(root)+' && git -C '+shlex.quote(root)+' read-tree --reset -u '+data['tree']\nbackend.run_guest_ssh(data['mac_address'],'macos',command,timeout=60,report=False)\nprint(root)`,
  { ...fixture, executionId },
);
manager.appendCustomEntry("cua-execution-target", {
  kind: "sandbox",
  name: "mac-studio",
  os: "macos",
  executionId,
  sandboxGeneration: fixture.mac_generation,
  localCwd: cwd,
  remoteCwd: sourceRoot,
  workspaceState: fixture.state,
});
let runtime;
let passed = false;
try {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
    modelsPath: null,
    modelsStorePath: join(tmpdir(), `cua-benchmark-models-${executionId}.json`),
  });
  await resourceLoader.reload();
  runtime = await createAgentSessionRuntime(
    async ({ sessionManager, sessionStartEvent }) =>
      createAgentSession({
        cwd,
        agentDir,
        settingsManager,
        resourceLoader,
        modelRuntime,
        sessionManager,
        sessionStartEvent,
      }),
    { cwd, agentDir, sessionManager: manager },
  );
  const session = runtime.session;
  await session.bindExtensions({ mode: "rpc" });
  const entry = session.agent.state.tools.find(
    (tool) => tool.name === "enter_environment",
  );
  assert.ok(entry);
  const started = performance.now();
  const result = await entry.execute(
    crypto.randomUUID(),
    { os: "linux", name: "linux-1" },
    AbortSignal.timeout(600000),
  );
  const elapsedMs = performance.now() - started;
  assert.ok(!result.isError, JSON.stringify(result));
  const target = manager
    .getEntries()
    .filter((item) => item.customType === "cua-execution-target")
    .at(-1)?.data;
  assert.equal(target?.name, "linux-1");
  assert.equal(target.executionId, executionId);
  const bash = session.agent.state.tools.find((tool) => tool.name === "bash");
  const smoke = await bash.execute(
    crypto.randomUUID(),
    {
      command: `git write-tree; test -f libs/cua-driver/tests/fixtures/shared/web/journal.test.cjs && echo fixture-present`,
    },
    AbortSignal.timeout(60000),
  );
  assert.ok(!smoke.isError, JSON.stringify(smoke));
  assert.match(JSON.stringify(smoke), new RegExp(fixture.tree));
  assert.match(JSON.stringify(smoke), /fixture-present/);
  const timings = manager
    .getEntries()
    .filter((item) =>
      ["cua-backend-timing", "cua-entry-timing"].includes(item.customType),
    );
  console.log(
    JSON.stringify(
      {
        elapsedMs,
        sourceRoot,
        target,
        timings: timings.map(({ customType, data }) => ({ customType, data })),
        verifiedTree: fixture.tree,
      },
      null,
      2,
    ),
  );
  passed = elapsedMs < 30000;
} finally {
  await runtime?.dispose();
  await python(
    `identity=backend.execution_digest(data['executionId'])[:16]\nfor name,profile in [('mac-studio','macos'),('linux-1','linux')]:\n box=next(b for b in backend.managed_sandboxes() if b['name']==name)\n root=backend.guest_home(profile)+'/workspaces/'+identity\n backend.cleanup_workspace_root(box['address'],profile,root)`,
    { executionId },
  );
}
if (!passed) process.exitCode = 1;
