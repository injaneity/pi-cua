#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";

const agentDir = dirname(fileURLToPath(import.meta.url));
const token = readFileSync(
  join(agentDir, "cua-tool-broker.token"),
  "utf8",
).trim();
const cwd = process.argv[2];
const manifest = process.argv[3];
const port = Number(process.env.CUA_PI_TOOL_BROKER_PORT || "43121");
if (!cwd || !manifest) {
  throw new Error("usage: cua-tool-relay <cwd> <required-tools-base64>");
}

const socket = connect({ host: "127.0.0.1", port }, () => {
  socket.write(`${JSON.stringify({ type: "open", token, cwd, manifest })}\n`);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.setNoDelay(true);
socket.on("error", (error) => {
  process.stderr.write(`desktop tool broker unavailable: ${error.message}\n`);
  process.exitCode = 1;
});
socket.on("close", () => process.exit());
process.on("SIGTERM", () => socket.destroy());
process.on("SIGINT", () => socket.destroy());
