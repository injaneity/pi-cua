import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { posix, join } from "node:path";
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
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === "pi.registerTool"
    ) {
      const properties = node.arguments[0]?.properties ?? [];
      if (
        properties.some(
          (item) =>
            item.name?.text === "name" && item.initializer?.text === event,
        )
      ) {
        const execute = properties.find(
          (item) => item.name?.text === "execute",
        );
        callback = execute
          .getText(ast)
          .replace(/^async execute/, "async function");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(callback, event);
  const code = ts.transpileModule(`(${callback})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2023 },
  }).outputText;
  scope.AbortSignal = AbortSignal;
  scope.tmpdir ??= () => "/controller/tmp";
  return vm.runInNewContext(code, scope);
}

test("credentialed web search is not packaged or proxied to guests", () => {
  const declaration = ast.statements
    .filter(ts.isVariableStatement)
    .flatMap((node) => [...node.declarationList.declarations])
    .find((node) => node.name.getText(ast) === "localTools");
  const localTools = vm.runInNewContext(declaration.initializer.getText(ast), {
    Set,
  });
  const tools = [
    {
      name: "web_search",
      sourceInfo: {
        origin: "top-level",
        scope: "user",
        path: "/controller/extensions/exa-search.ts",
      },
    },
    {
      name: "find",
      sourceInfo: {
        origin: "package",
        scope: "user",
        source: "npm:@ff-labs/pi-fff",
      },
    },
    { name: "read", sourceInfo: { origin: "builtin", source: "builtin" } },
  ];
  const routes = handler("executionRoutes", {
    routeCatalog: undefined,
    localTools,
    pi: { getAllTools: () => tools, getCommands: () => [] },
    immutablePackageSource: () => "npm:@ff-labs/pi-fff@0.10.6",
  })();
  assert.deepEqual([...routes.tools], ["find", "read"]);
  assert.deepEqual([...routes.files], []);
  assert.deepEqual([...routes.packages], ["npm:@ff-labs/pi-fff@0.10.6"]);
});

test("full web search output has an explicit controller read route", () => {
  const route = handler("shouldUseControllerTool", {
    posix,
    homedir: () => "/home/user",
    getAgentDir: () => "/home/user/.pi/agent",
    tmpdir: () => "/controller/tmp",
  });
  assert.equal(
    route("read", { path: "/controller/tmp/pi-exa-search-Ab123z/results.txt" }),
    true,
  );
  for (const path of [
    "/guest/tmp/pi-exa-search-Ab123z/results.txt",
    "/controller/tmp/other/results.txt",
    "/controller/tmp/pi-exa-search-Ab123z/../secret.txt",
  ])
    assert.equal(route("read", { path }), false);
  assert.equal(
    route("write", {
      path: "/controller/tmp/pi-exa-search-Ab123z/results.txt",
    }),
    false,
  );
});

test("only canonical papercut ledger file operations stay on the controller", () => {
  const route = handler("shouldUseControllerTool", {
    posix,
    homedir: () => "/home/user",
    getAgentDir: () => "/home/user/.pi/agent",
  });
  for (const path of [
    "/home/user/.pi/agent/papercuts/project-012345abcdef/papercuts.md",
    "~/.pi/agent/papercuts/project-012345abcdef/papercuts.md",
  ]) {
    for (const name of ["read", "write", "edit"])
      assert.equal(route(name, { path }), true);
    for (const name of ["grep", "bash"])
      assert.equal(route(name, { path }), false);
  }
  for (const path of [
    "papercuts.md",
    "/work/papercuts.md",
    "/home/user/.pi/agent/auth.json",
    "/home/user/.pi/agent/papercuts/project-012345abcdef/../../auth.json",
    "/home/user/.pi/agent/papercuts/project-012345abcdef/extra/papercuts.md",
  ])
    for (const name of ["read", "write", "edit"])
      assert.equal(route(name, { path }), false);
  for (const path of [
    "/var/folders/aa/bb/T/pi-clipboard-123.png",
    "/controller/tmp/pi-exa-search-Ab123z/results.txt",
  ])
    for (const name of ["write", "edit"])
      assert.equal(route(name, { path }), false);
});

test("controller clipboard image reads remain supported", () => {
  const route = handler("shouldUseControllerTool", {});
  assert.equal(
    route("read", { path: "/var/folders/aa/bb/T/pi-clipboard-123.png" }),
    true,
  );
  assert.equal(
    route("read", {
      path: "/private/var/folders/aa/bb/T/pi-clipboard-123.webp",
    }),
    true,
  );
});

test("papercut reads use the configured controller agent directory", () => {
  const route = handler("shouldUseControllerTool", {
    posix,
    homedir: () => "/home/user",
    getAgentDir: () => "/custom/agent",
  });
  assert.equal(
    route("read", {
      path: "/custom/agent/papercuts/project-012345abcdef/papercuts.md",
    }),
    true,
  );
  assert.equal(
    route("read", {
      path: "/home/user/.pi/agent/papercuts/project-012345abcdef/papercuts.md",
    }),
    false,
  );
});

test("papercut proxy reads stay live across switches without contacting guests", async () => {
  let proxy;
  let text = "first report";
  const info = {
    name: "read",
    sourceInfo: { origin: "builtin", source: "builtin" },
  };
  const scope = {
    join,
    extensionDir: "/controller/pi-cua",
    executionRoutes: () => ({ definitions: [info] }),
    shouldUseControllerTool: handler("shouldUseControllerTool", {
      posix,
      homedir: () => "/home/user",
      getAgentDir: () => "/home/user/.pi/agent",
    }),
    connectedBridge: () => {
      throw new Error("guest must not be contacted");
    },
    createReadTool: (cwd) => {
      assert.equal(cwd, "/controller/project");
      return { execute: async () => ({ content: [{ type: "text", text }] }) };
    },
    pi: {
      getActiveTools: () => ["read"],
      registerTool: (tool) => {
        proxy = tool;
      },
      setActiveTools() {},
      getAllTools: () => [
        { ...info, sourceInfo: { path: "/controller/pi-cua/index.ts" } },
      ],
    },
  };
  handler("installProxies", scope)({ definition: () => info });
  for (const os of ["linux", "windows", "macos"]) {
    scope.target = { kind: "sandbox", os };
    text += ` ${os}`;
    const result = await proxy.execute(
      "read-ledger",
      {
        path: "/home/user/.pi/agent/papercuts/project-012345abcdef/papercuts.md",
      },
      undefined,
      undefined,
      { cwd: "/controller/project" },
    );
    assert.match(result.content[0].text, /live controller/);
    assert.equal(result.content[1].text, text);
  }
});

for (const name of ["edit", "write"]) {
  test(`papercut ${name} uses the controller executor across all sandbox targets`, async () => {
    let proxy;
    const calls = [];
    const info = { name, sourceInfo: { origin: "builtin", source: "builtin" } };
    const factory = (cwd) => ({
      execute: async (...args) => {
        calls.push({ cwd, args });
        return { content: [{ type: "text", text: "updated" }] };
      },
    });
    const scope = {
      join,
      extensionDir: "/controller/pi-cua",
      executionRoutes: () => ({ definitions: [info] }),
      shouldUseControllerTool: handler("shouldUseControllerTool", {
        posix,
        homedir: () => "/home/user",
        getAgentDir: () => "/home/user/.pi/agent",
      }),
      createEditTool:
        name === "edit"
          ? factory
          : () => {
              throw Error("wrong executor");
            },
      createWriteTool:
        name === "write"
          ? factory
          : () => {
              throw Error("wrong executor");
            },
      connectedBridge: () => {
        throw Error("must not contact guest");
      },
      pi: {
        getActiveTools: () => [name],
        registerTool: (tool) => {
          proxy = tool;
        },
        setActiveTools() {},
        getAllTools: () => [
          { ...info, sourceInfo: { path: "/controller/pi-cua/index.ts" } },
        ],
      },
    };
    handler("installProxies", scope)({ definition: () => info });
    const input = {
      path: "/home/user/.pi/agent/papercuts/project-012345abcdef/papercuts.md",
      ...(name === "edit"
        ? { edits: [{ oldText: "old", newText: "new" }] }
        : { content: "new" }),
    };
    const signal = new AbortController().signal;
    for (const os of ["linux", "windows", "macos"]) {
      scope.target = { kind: "sandbox", os };
      const result = await proxy.execute("update", input, signal, undefined, {
        cwd: "/controller/project",
      });
      assert.match(result.content[0].text, /live controller/);
      assert.equal(calls.at(-1).cwd, "/controller/project");
      assert.equal(calls.at(-1).args[1], input);
      assert.equal(calls.at(-1).args[2], signal);
    }
  });
}

test("OS selection uses existing online targets and excludes offline external hosts", async () => {
  const scope = {
    target: { kind: "local" },
    listSandboxes: async () => ({
      sandboxes: [
        { name: "offline", os: "windows", online: false, kind: "external" },
        { name: "repair", os: "windows", online: false, kind: "fleet" },
        { name: "ready", os: "windows", online: true, kind: "fleet" },
      ],
    }),
  };
  const select = handler("environmentDestination", scope);
  assert.equal((await select("windows", undefined, {})).name, "ready");
  assert.equal((await select("windows", "repair", {})).name, "repair");
  await assert.rejects(
    select("windows", "offline", {}),
    /no eligible existing/,
  );
  await assert.rejects(
    select("linux", undefined, {}),
    /no machine was created/,
  );
});

test("model entry reuses an already connected matching sandbox without backend work", async () => {
  const scope = {
    enteringEnvironment: false,
    target: { kind: "sandbox", name: "windows-1", os: "windows" },
    bridge: { connected: true },
    acceptReplacement: async () => true,
  };
  scope.environmentDestination = handler("environmentDestination", scope);
  const result = await handler("enter_environment", scope)(
    "id",
    { os: "windows" },
    undefined,
    undefined,
    {},
  );
  assert.match(result.content[0].text, /windows-1/);
});

test("model entry forwards cancellation and uses the existing shared entry function", async () => {
  const controller = new AbortController();
  let entered;
  const destination = { kind: "sandbox", name: "mac-studio", os: "macos" };
  const scope = {
    enteringEnvironment: false,
    target: { kind: "local" },
    environmentDestination: async () => destination,
    acceptReplacement: async () => true,
    enterSandbox: async (value, ctx) => {
      entered = value;
      assert.equal(ctx.signal, controller.signal);
    },
  };
  await handler("enter_environment", scope)(
    "id",
    { os: "macos" },
    controller.signal,
    undefined,
    {},
  );
  assert.equal(entered, destination);
});

for (const failure of [false, true]) {
  test(`shared sandbox entry preserves original transfer and cleanup behavior: failure=${failure}`, async () => {
    const order = [];
    const source = { kind: "sandbox", name: "linux-1" };
    const scope = {
      target: source,
      enteringEnvironment: false,
      runtimeClosed: false,
      saveConnectionIntent: () => ({ id: "intent" }),
      materializeTarget: async () => {
        order.push("prepare");
        if (failure) throw new Error("failed setup");
        return { kind: "sandbox", name: "windows-1" };
      },
      ownsConnectionIntent: () => true,
      activate: async () => order.push("activate"),
      clearConnectionIntent: () => order.push("clear"),
      cleanupTarget: async (value) => {
        assert.equal(value, source);
        order.push("cleanup");
      },
    };
    const pending = handler("enterSandbox", scope)(
      { kind: "sandbox", name: "windows-1", os: "windows" },
      {},
    );
    if (failure) await assert.rejects(pending, /failed setup/);
    else await pending;
    assert.deepEqual(
      order,
      failure
        ? ["prepare", "clear"]
        : ["prepare", "activate", "clear", "cleanup"],
    );
    assert.equal(scope.enteringEnvironment, false);
  });
}

test("mixed environment batches are blocked before any tool dispatch", () => {
  const scope = { mixedEnvironmentBatch: false };
  handler(
    "message_end",
    scope,
  )({
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", name: "enter_environment" },
        { type: "toolCall", name: "bash" },
      ],
    },
  });
  assert.equal(handler("tool_call", scope)({ toolName: "bash" }).block, true);
  assert.equal(
    handler("tool_call", scope)({ toolName: "enter_environment" }).block,
    true,
  );
});

for (const os of ["linux", "windows", "macos"]) {
  test(`${os} maps controller skill paths into the guest runtime without local fallback`, () => {
    const scope = {
      posix,
      homedir: () => "/controller",
      runtimeAgentDir: () =>
        os === "windows" ? "C:\\runtime\\agent" : "/runtime/agent",
    };
    const map = handler("mapConfigInput", scope);
    const active = {
      os,
      configPaths: { "/controller/.pi/agent/skills": "skills/global" },
    };
    const result = map(
      "read",
      { path: "~/.pi/agent/skills/demo/SKILL.md" },
      active,
    );
    assert.equal(
      result.path,
      os === "windows"
        ? "C:\\runtime\\agent\\skills\\global\\demo\\SKILL.md"
        : "/runtime/agent/skills/global/demo/SKILL.md",
    );
    assert.equal(
      map(
        "grep",
        { path: "/controller/.pi/agent/skills/demo", pattern: "example" },
        active,
      ).input.pattern,
      "example",
    );
    const workspace = { path: "src/main.ts" };
    assert.equal(map("read", workspace, active).input, workspace);
    assert.equal(
      map("read", { path: "/controller/.pi/agent/skills/../auth.json" }, active)
        .path,
      undefined,
    );
    assert.throws(
      () =>
        map(
          "write",
          { path: "/controller/.pi/agent/skills/demo/SKILL.md" },
          active,
        ),
      /read-only/,
    );
  });
}

for (const mode of ["valid", "builtin-fallback", "local-wins"]) {
  test(`proxy validation checks both remote provider and local precedence: ${mode}`, () => {
    const source = "npm:@ff-labs/pi-fff@0.10.6";
    const info = {
      name: "find",
      sourceInfo: { origin: "package", source, path: "/fff/index.ts" },
    };
    const scope = {
      join,
      extensionDir: "/controller/pi-cua",
      immutablePackageSource: () => source,
      executionRoutes: () => ({ definitions: [info] }),
      pi: {
        getActiveTools: () => ["find"],
        registerTool() {},
        setActiveTools() {},
        getAllTools: () => [
          {
            ...info,
            sourceInfo: {
              ...info.sourceInfo,
              path:
                mode === "local-wins"
                  ? "/fff/index.ts"
                  : "/controller/pi-cua/index.ts",
            },
          },
        ],
      },
    };
    const bridge = {
      definition: () => ({
        name: "find",
        sourceInfo:
          mode === "builtin-fallback"
            ? { origin: "builtin", source: "builtin" }
            : info.sourceInfo,
      }),
    };
    const install = () => handler("installProxies", scope)(bridge);
    if (mode === "valid") install();
    else
      assert.throws(
        install,
        mode === "builtin-fallback" ? /provider mismatch/ : /precedence/,
      );
  });
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
