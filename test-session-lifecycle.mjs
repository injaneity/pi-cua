import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile(
  "index.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
);

function handler(event, scope) {
  let callback;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === event)
      callback = node.getText(ast);
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === "pi.on" &&
      node.arguments[0]?.text === event
    )
      callback = node.arguments[1].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(callback, event);
  const code = ts.transpileModule(`(${callback})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2023 },
  }).outputText;
  return vm.runInNewContext(code, scope);
}

for (const os of ["linux", "windows", "macos"]) {
  for (const git of [false, true]) {
    test(`${os} child materialization uses child identity with git=${git}`, async () => {
      const requests = [];
      const source = {
        ...parent,
        os,
        workspaceState: git ? parent.workspaceState : undefined,
      };
      const scope = {
        target: source,
        runtimeClosed: false,
        executionRoutes: () => ({ packages: [], files: [] }),
        reportTargetProgress() {},
        workspaceSource: (value) => value,
        refreshSandboxInventory() {},
        parseWorkspaceState: (value) => value,
        runBackend: async (request) => {
          requests.push(request);
          return {
            remote_cwd: `/workspaces/${request.execution_id}`,
            address: source.address,
            runtime_digest: "runtime",
            reconciled: true,
            sandbox_generation: source.sandboxGeneration,
          };
        },
      };
      const result = await handler("materializeTarget", scope)(
        {
          kind: "sandbox",
          name: source.name,
          os,
          generation: source.sandboxGeneration,
        },
        { cwd: "/local", sessionManager: { getSessionId: () => "child" } },
        { inheritExecution: false, source },
      );
      assert.equal(requests[0].execution_id, "child");
      assert.equal(requests[0].resume, undefined);
      assert.equal(requests[0].source, git ? source : undefined);
      assert.equal(requests[0].sandbox_generation, "node-1");
      assert.equal(result.executionId, "child");
      assert.equal(result.remoteCwd, "/workspaces/child");
    });
  }
}

const parent = {
  kind: "sandbox",
  name: "mac-studio",
  os: "macos",
  executionId: "parent",
  sandboxGeneration: "node-1",
  address: "100.64.0.9",
  localCwd: "/local",
  remoteCwd: "/workspaces/parent",
  workspaceState: { commit: "parent-commit" },
};

for (const reason of ["resume", "new", "fork", "reload", "quit"]) {
  test(`${reason} shutdown only disconnects, preserving thread and workspace`, () => {
    const closes = [];
    const scope = {
      runtimeClosed: false,
      workspaceDiffGeneration: 0,
      bridge: { close: (...args) => closes.push(args) },
    };
    handler("session_shutdown", scope)({ reason }, {});
    assert.equal(scope.runtimeClosed, true);
    assert.equal(scope.workspaceDiffGeneration, 1);
    assert.equal(scope.bridge, undefined);
    assert.deepEqual(closes, [[]]);
  });
}

function startup(reason, current = parent) {
  const saved = [];
  const activated = [];
  const materialized = [];
  const notifications = [];
  const scope = {
    pendingSessionStart: { reason, previousSessionFile: "/parent.jsonl" },
    runtimeClosed: false,
    placementError: undefined,
    createsSession: (value) => value === "new" || value === "fork",
    loadParentTarget: () => parent,
    loadSessionTarget: () => current,
    loadConnectionIntent: () => undefined,
    clearConnectionIntent: () => {},
    saveTarget: (value) => saved.push(value),
    resumeTarget: async (value) => value,
    materializeTarget: async (destination, ctx, options) => {
      materialized.push({ destination, options });
      assert.equal(options.inheritExecution, false);
      assert.equal(options.source, parent);
      return {
        ...parent,
        executionId: "child",
        remoteCwd: "/workspaces/child",
      };
    },
    activate: async (value) => activated.push(value),
    pi: { appendEntry() {}, events: { emit() {} } },
    executionTargetIntentEntry: "cua-execution-target-intent",
  };
  const ctx = {
    ui: { setStatus() {}, notify: (value) => notifications.push(value) },
  };
  return { scope, ctx, saved, activated, materialized, notifications };
}

for (const reason of ["new", "fork"]) {
  test(`${reason} ignores copied placement and copies parent into a separate execution`, async () => {
    const state = startup(reason);
    state.scope.loadConnectionIntent = () => {
      throw new Error("copied intent must not run");
    };
    await handler("resources_discover", state.scope)({}, state.ctx);
    assert.equal(state.saved[0].kind, "local");
    assert.equal(state.materialized.length, 1);
    assert.equal(state.activated[0].executionId, "child");
    assert.notEqual(state.activated[0].remoteCwd, parent.remoteCwd);
    assert.equal(parent.executionId, "parent");
    assert.deepEqual(state.notifications, []);
  });
}

for (const reason of ["resume", "reload", "startup"]) {
  test(`${reason} restores its own execution without inheriting the departing thread`, async () => {
    const state = startup(reason);
    state.scope.loadParentTarget = () => {
      throw new Error("must not inherit");
    };
    await handler("resources_discover", state.scope)({}, state.ctx);
    assert.equal(state.activated[0], parent);
    assert.equal(state.materialized.length, 0);
    assert.deepEqual(state.notifications, []);
  });
}

test("resume of a local thread stays local", async () => {
  const state = startup("resume", { kind: "local" });
  await handler("resources_discover", state.scope)({}, state.ctx);
  assert.equal(state.activated[0].kind, "local");
  assert.equal(state.materialized.length, 0);
});

test("failed fork setup never activates the parent workspace", async () => {
  const state = startup("fork");
  state.scope.materializeTarget = async () => {
    throw new Error("copy failed");
  };
  await handler("resources_discover", state.scope)({}, state.ctx);
  assert.equal(state.activated.length, 0);
  assert.equal(state.saved[0].kind, "local");
  assert.match(state.notifications[0], /copy failed/);
});
