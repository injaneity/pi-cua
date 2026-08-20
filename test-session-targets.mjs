#!/usr/bin/env node

import assert from "node:assert/strict";
import { preferPickerItem } from "./session-targets.mjs";

const items = ["local", "cua-windows", "cua-linux", "create"].map((value) => ({
  value,
}));
assert.deepEqual(
  preferPickerItem(items, "cua-linux").map((item) => item.value),
  ["cua-linux", "local", "cua-windows", "create"],
);
assert.equal(preferPickerItem(items, undefined), items);

console.log("session target tests passed");
