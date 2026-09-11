import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  rm,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

const os = process.argv[2];
assert.ok(
  ["linux", "windows", "macos"].includes(os),
  "usage: node smoke-pi-config.mjs <linux|windows|macos>",
);
const base = dirname(fileURLToPath(import.meta.url));
const controller =
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const npmModules = join(controller, "npm", "node_modules");
const fff = JSON.parse(
  await readFile(
    join(npmModules, "@ff-labs", "pi-fff", "package.json"),
    "utf8",
  ),
);
const directory = await mkdtemp(join(tmpdir(), "pi-config-smoke-"));
const agentDir = join(directory, "agent");
const cwd = join(directory, "work");
const skillRoot = join(directory, "fixture-skill");
let runtime;
const ledgerDir = join(
  controller,
  "papercuts",
  `config-smoke-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
);
let ledgerCreated = false;
try {
  await mkdir(join(controller, "papercuts"), { recursive: true });
  await mkdir(ledgerDir);
  ledgerCreated = true;
  const ledgerPath = join(ledgerDir, "papercuts.md");
  await writeFile(ledgerPath, "papercut-before-entry\n");
  await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(skillRoot)]);
  await mkdir(join(agentDir, "extensions"));
  const searchExtension = join(agentDir, "extensions", "web-search.ts");
  await writeFile(
    searchExtension,
    `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({ name: "web_search", label: "Controller search fixture", description: "Controller-only search fixture; no network requests", parameters: Type.Object({ query: Type.String() }), async execute(_id, _input, _signal, _update, ctx) { return { content: [{ type: "text", text: "controller search fixture" }], details: { pid: process.pid, cwd: ctx.cwd } }; } });
}
`,
  );
  await mkdir(join(agentDir, "npm"));
  await symlink(npmModules, join(agentDir, "npm", "node_modules"));
  await writeFile(join(agentDir, "pi-fff.json"), '{"mode":"override"}\n');
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: config-fixture\ndescription: portable configuration fixture\n---\nRun helper.mjs with node.\n",
  );
  await writeFile(
    join(skillRoot, "helper.mjs"),
    'console.log("copied-helper-executed")\n',
  );
  const settingsManager = SettingsManager.inMemory({
    packages: [base, `npm:@ff-labs/pi-fff@${fff.version}`],
    skills: [
      join(controller, "skills"),
      join(homedir(), ".agents", "skills"),
      skillRoot,
    ],
  });
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
    modelsStorePath: join(directory, "models.json"),
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
    { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
  );
  const session = runtime.session;
  await session.bindExtensions({ mode: "rpc" });
  assert.match(
    session.getAllTools().find((tool) => tool.name === "find")?.sourceInfo
      .source ?? "",
    /@ff-labs\/pi-fff/,
    "configure the controller's pi-fff.json with mode=override before this smoke",
  );
  const execute = async (name, input) => {
    const tool = session.agent.state.tools.find((item) => item.name === name);
    assert.ok(tool, `missing tool ${name}`);
    return tool.execute(
      crypto.randomUUID(),
      input,
      AbortSignal.timeout(600000),
    );
  };
  const entry = await execute("enter_environment", { os });
  console.log(JSON.stringify(entry));
  assert.equal(
    session.getAllTools().find((tool) => tool.name === "web_search").sourceInfo
      .path,
    searchExtension,
  );
  const search = await execute("web_search", { query: "routing fixture" });
  assert.equal(search.details.pid, process.pid);
  assert.equal(search.details.cwd, cwd);
  const before = await execute("read", { path: ledgerPath });
  assert.match(JSON.stringify(before), /live controller papercut ledger/);
  assert.match(JSON.stringify(before), /papercut-before-entry/);
  await writeFile(ledgerPath, "papercut-after-entry\n");
  const after = await execute("read", { path: ledgerPath });
  assert.match(JSON.stringify(after), /papercut-after-entry/);
  for (const name of ["find", "grep"]) {
    assert.equal(
      session.getAllTools().find((tool) => tool.name === name).sourceInfo.path,
      join(base, "index.ts"),
    );
  }
  await execute("write", {
    path: "config-transfer-probe.txt",
    content: "portable-configuration-probe\n",
  });
  const found = await execute("find", { pattern: "config-transfer-probe" });
  assert.match(JSON.stringify(found), /config-transfer-probe.txt/);
  const grepped = await execute("grep", {
    pattern: "portable-configuration-probe",
  });
  assert.match(JSON.stringify(grepped), /config-transfer-probe.txt/);
  const skill = await execute("read", { path: join(skillRoot, "SKILL.md") });
  assert.match(JSON.stringify(skill), /resource path in this environment/);
  const helper = await execute("read", { path: join(skillRoot, "helper.mjs") });
  const path = helper.content[0].text.replace(
    "resource path in this environment: ",
    "",
  );
  assert.ok(
    !path.includes("'"),
    "smoke helper path contains unsupported quoting",
  );
  const executed = await execute("bash", { command: `node '${path}'` });
  assert.match(JSON.stringify(executed), /copied-helper-executed/);
  const scoped = await execute("grep", {
    pattern: "portable configuration fixture",
    path: skillRoot,
  });
  assert.match(JSON.stringify(scoped), /SKILL.md/);
  const config = await execute("read", {
    path: join(controller, "pi-fff.json"),
  });
  assert.match(JSON.stringify(config), /override/);
  console.log(
    `${os}: controller web search, live controller papercuts, remote fff, copied configuration, skill paths, scoped search, and helper execution passed; no model calls`,
  );
} finally {
  await runtime?.dispose();
  if (ledgerCreated) await rm(ledgerDir, { recursive: true, force: true });
  await rm(directory, { recursive: true, force: true });
}
