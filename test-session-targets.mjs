#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  formatSandboxProgress,
  preferPickerItem,
} from "./session-targets.mjs";

const items = ["local", "cua-windows", "cua-linux", "create"].map((value) => ({
  value,
}));
assert.deepEqual(
  preferPickerItem(items, "cua-linux").map((item) => item.value),
  ["cua-linux", "local", "cua-windows", "create"],
);
assert.equal(preferPickerItem(items, undefined), items);

assert.equal(formatSandboxProgress("cua-windows"), "cua-windows (connecting)");
assert.equal(
  formatSandboxProgress(
    "cua-windows",
    "lock",
    "waiting for workspace mutation lock",
  ),
  "cua-windows (waiting for another sandbox operation)",
);
assert.equal(
  formatSandboxProgress(
    "cua-windows",
    "bootstrap.cua-windows.windows",
    "background job is running",
  ),
  "cua-windows (repairing guest) • background job is running",
);
assert.equal(
  formatSandboxProgress(
    "cua-windows",
    "workspace.destination.apply",
    "applying changes",
  ),
  "cua-windows (syncing workspace) • applying changes",
);

console.log("session target tests passed");
