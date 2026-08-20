#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

const source = new URL(".", import.meta.url).pathname;
const directory = await mkdtemp(join(tmpdir(), "pi-cua-broker-"));
const token = "test-token-that-is-long-enough";
let broker;

try {
  await Promise.all([
    copyFile(
      join(source, "tool-broker.mjs"),
      join(directory, "cua-tool-broker.mjs"),
    ),
    copyFile(
      join(source, "tool-relay.mjs"),
      join(directory, "cua-tool-relay.mjs"),
    ),
    writeFile(join(directory, "cua-tool-broker.token"), token),
    writeFile(
      join(directory, "cua-tool-host.mjs"),
      'process.stdout.write("{\\"type\\":\\"ready\\"}\\n"); process.stdin.pipe(process.stdout);',
    ),
  ]);

  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  reservation.close();
  await once(reservation, "close");

  broker = spawn(process.execPath, [join(directory, "cua-tool-broker.mjs")], {
    env: { ...process.env, CUA_PI_TOOL_BROKER_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await once(broker.stderr, "data");

  const relay = spawn(
    process.execPath,
    [join(directory, "cua-tool-relay.mjs"), directory, "W10="],
    {
      env: { ...process.env, CUA_PI_TOOL_BROKER_PORT: String(port) },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  let errors = "";
  relay.stderr.on("data", (chunk) => (errors += chunk));
  await new Promise((resolve) => {
    relay.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes('"type":"ready"')) resolve();
    });
  });
  relay.stdin.end("hello\n");
  const [code] = await once(relay, "close");

  assert.equal(code, 0, errors);
  assert.match(output, /"type":"ready"/, errors);
  assert.match(output, /hello/);
  console.log("desktop tool broker test passed");
} finally {
  broker?.kill();
  if (broker) await once(broker, "close");
  await rm(directory, { recursive: true, force: true });
}
