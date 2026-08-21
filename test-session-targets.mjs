#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  isControllerClipboardImagePath,
  latestCustomEntryData,
  shouldCleanupExecutionTarget,
  shouldHandoffExecutionTarget,
  shouldUseControllerTool,
} from "./session-targets.mjs";

const sessionEntries = [
  {
    type: "custom",
    customType: "cua-execution-target",
    data: { kind: "sandbox", name: "old" },
  },
  { type: "message", message: { role: "user", content: "work" } },
  {
    type: "custom",
    customType: "cua-execution-target-handoff",
    data: { kind: "sandbox", name: "handoff" },
  },
  {
    type: "custom",
    customType: "cua-execution-target",
    data: { kind: "local" },
  },
];
assert.deepEqual(
  latestCustomEntryData(sessionEntries, "cua-execution-target"),
  { kind: "local" },
);
assert.deepEqual(
  latestCustomEntryData(sessionEntries, "cua-execution-target-handoff"),
  { kind: "sandbox", name: "handoff" },
);
assert.equal(latestCustomEntryData(sessionEntries, "missing"), undefined);

assert.equal(
  isControllerClipboardImagePath(
    "/var/folders/ct/session/T/pi-clipboard-example.png",
  ),
  true,
);
assert.equal(
  isControllerClipboardImagePath(
    "/private/var/folders/ct/session/T/pi-clipboard-example.WEBP",
  ),
  true,
);
assert.equal(
  isControllerClipboardImagePath("/workspace/pi-clipboard-example.png"),
  false,
);
assert.equal(
  isControllerClipboardImagePath(
    "/var/folders/ct/session/T/../pi-clipboard-example.png",
  ),
  false,
);
assert.equal(isControllerClipboardImagePath(undefined), false);
assert.equal(
  shouldUseControllerTool("read", {
    path: "/var/folders/ct/session/T/pi-clipboard-example.png",
  }),
  true,
);
assert.equal(
  shouldUseControllerTool("read", { path: "/workspace/screenshot.png" }),
  false,
);
assert.equal(
  shouldUseControllerTool("write", {
    path: "/var/folders/ct/session/T/pi-clipboard-example.png",
  }),
  false,
);

assert.equal(shouldHandoffExecutionTarget("new"), true);
assert.equal(shouldHandoffExecutionTarget("fork"), true);
assert.equal(shouldHandoffExecutionTarget("resume"), false);
assert.equal(shouldCleanupExecutionTarget("new"), false);
assert.equal(shouldCleanupExecutionTarget("fork"), false);
assert.equal(shouldCleanupExecutionTarget("reload"), false);
assert.equal(shouldCleanupExecutionTarget("resume"), true);
assert.equal(shouldCleanupExecutionTarget("quit"), true);

console.log("session target tests passed");
