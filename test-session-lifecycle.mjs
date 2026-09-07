import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
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
  scope.AbortSignal = AbortSignal;
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

test("picker retains unavailable sandboxes and refuses execution", async () => {
  const menus = [];
  const scope = {
    listSandboxes: async () => ({
      sandboxes: [
        {
          name: "linux-1",
          os: "linux",
          online: false,
          unavailable_reason: "inspect the existing workspace",
        },
        { name: "mac-studio", os: "macos", online: true },
      ],
    }),
    searchDestinationOptions: async (_ctx, options) => {
      menus.push(options);
      return menus.length === 1 ? "connect" : "linux-1";
    },
  };
  await assert.rejects(
    handler("pickDestination", scope)({ hasUI: true }),
    /inspect the existing workspace/,
  );
  assert.equal(menus[1].length, 2);
  assert.equal(menus[1][0].value, "linux-1");
  assert.match(menus[1][0].description, /inspect/);
});

for (const approved of [false, true]) {
  test(`replacement acceptance preserves evidence and requires approval=${approved}`, async () => {
    const saved = {
      kind: "sandbox",
      name: "windows-1",
      sandboxGeneration: "old",
    };
    const entries = [];
    const placements = [];
    let closed = false;
    const scope = {
      loadSessionTarget: () => saved,
      listSandboxes: async () => ({
        sandboxes: [{ name: "windows-1", kind: "external" }],
      }),
      pi: { appendEntry: (...entry) => entries.push(entry) },
      bridge: {
        close: () => {
          closed = true;
        },
      },
      target: saved,
      saveTarget: (target) => placements.push(target),
      placementError: undefined,
    };
    const result = await handler("acceptReplacement", scope)(
      { kind: "sandbox", name: "windows-1", generation: "new" },
      { hasUI: true, ui: { confirm: async () => approved } },
    );
    assert.equal(result, approved);
    assert.equal(closed, approved);
    assert.equal(entries.length, approved ? 1 : 0);
    assert.equal(placements.length, approved ? 1 : 0);
    if (approved) {
      assert.equal(entries[0][1], saved);
      assert.equal(placements[0].kind, "local");
    }
  });
}

test("fleet identity replacement requires no data-salvage prompt", async () => {
  const scope = {
    loadSessionTarget: () => ({
      kind: "sandbox",
      name: "fleet",
      sandboxGeneration: "old",
    }),
    listSandboxes: async () => ({
      sandboxes: [{ name: "fleet", kind: "fleet" }],
    }),
  };
  assert.equal(
    await handler("acceptReplacement", scope)(
      { kind: "sandbox", name: "fleet", generation: "new" },
      { hasUI: false },
    ),
    true,
  );
});

test("offline fleet remains selectable for bounded automatic recovery", async () => {
  const scope = {
    listSandboxes: async () => ({
      sandboxes: [
        {
          name: "linux-1",
          os: "linux",
          kind: "fleet",
          online: false,
          generation: "old",
        },
      ],
    }),
    searchDestinationOptions: async (_ctx, options) =>
      options.some((item) => item.value === "connect") ? "connect" : "linux-1",
  };
  const result = await handler("pickDestination", scope)({ hasUI: true });
  assert.equal(result.name, "linux-1");
  assert.equal(result.generation, "old");
});

test("switch event is visible and model-readable without starting a turn", () => {
  const messages = [];
  const scope = {
    process: { platform: "darwin" },
    pi: { sendMessage: (...args) => messages.push(args) },
  };
  const announce = handler("announceTargetChange", scope);
  announce(
    { kind: "local" },
    { kind: "sandbox", name: "windows-1", os: "windows" },
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0][0].display, true);
  assert.match(
    messages[0][0].content,
    /local \(macos\).*windows-1 \(windows\)/,
  );
  assert.equal(messages[0][1].triggerTurn, false);
  assert.equal(messages[0][1].deliverAs, undefined);
  announce(
    { kind: "sandbox", name: "windows-1", os: "windows" },
    { kind: "sandbox", name: "windows-1", os: "windows" },
  );
  assert.equal(messages.length, 1);
});

for (const mode of ["switch", "restore", "failure"]) {
  test(`activation announces only a completed explicit switch: ${mode}`, async () => {
    const announcements = [];
    const scope = {
      runtimeClosed: false,
      target: { kind: "local" },
      bridge: undefined,
      placementError: undefined,
      executionRoutes: () => ({ tools: [] }),
      ToolBridge: class {
        async connect() {
          if (mode === "failure") throw new Error("unreachable");
        }
        close() {}
      },
      formatSandboxProgress: () => "connecting",
      installProxies() {},
      saveTarget() {},
      pi: { events: { emit() {} } },
      refreshWorkspaceDiff() {},
      announceTargetChange: (...args) => announcements.push(args),
    };
    const pending = handler("activate", scope)(
      { kind: "sandbox", name: "windows-1", os: "windows", reconciled: true },
      { ui: { setStatus() {} } },
      { persist: mode !== "restore" },
    );
    if (mode === "failure") await assert.rejects(pending, /unreachable/);
    else await pending;
    assert.equal(announcements.length, mode === "switch" ? 1 : 0);
  });
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
  test(`${reason} shutdown only disconnects, preserving thread and workspace`, async () => {
    const closes = [];
    const scope = {
      runtimeClosed: false,
      workspaceDiffGeneration: 0,
      bridge: { close: (...args) => closes.push(args) },
    };
    await handler("session_shutdown", scope)({ reason }, {});
    assert.equal(scope.runtimeClosed, true);
    assert.equal(scope.workspaceDiffGeneration, 1);
    assert.equal(scope.bridge, undefined);
    assert.deepEqual(closes, [[]]);
  });
}

for (const mode of ["cancel", "deadline"]) {
  test(`backend ${mode} escalates when the process ignores termination`, async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {},
    });
    const timers = [];
    const kills = [];
    const scope = {
      backend: "/backend.py",
      spawn: () => child,
      StringDecoder,
      process: { env: {}, kill: (pid, signal) => kills.push([pid, signal]) },
      setTimeout: (callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
      },
      clearTimeout() {},
    };
    const controller = new AbortController();
    const pending = handler("runBackend", scope)(
      { action: "ensure" },
      controller.signal,
    );
    const rejected = assert.rejects(pending, /deadline/);
    if (mode === "cancel") controller.abort();
    else timers[0].callback();
    assert.equal(timers[1].delay, 5000);
    timers[1].callback();
    await rejected;
    assert.deepEqual(kills, [
      [-123, "SIGTERM"],
      [-123, "SIGKILL"],
    ]);
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
