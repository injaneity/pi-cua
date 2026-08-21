#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  isControllerClipboardImagePath,
  preferPickerItem,
  shouldUseControllerTool,
} from "./session-targets.mjs";

const items = ["local", "cua-windows", "cua-linux", "create"].map((value) => ({
  value,
}));
assert.deepEqual(
  preferPickerItem(items, "cua-linux").map((item) => item.value),
  ["cua-linux", "local", "cua-windows", "create"],
);
assert.equal(preferPickerItem(items, undefined), items);

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

console.log("session target tests passed");
