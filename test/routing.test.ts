import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { localClipboard, spaceOperations } from "../tools.ts";
import { pathPrefix } from "../remote.ts";
import { orderedSpaces, type SpaceItem } from "../spaces.ts";
import { FakeSpacesClient } from "./fake-spaces.ts";

test("online Spaces precede unknown and offline without mutating inventory", () => {
  const items: SpaceItem[] = [
    { id: "offline", name: "A", online: false, os: "linux", provider: "local" },
    { id: "unknown", name: "B", os: "linux", provider: "local" },
    { id: "online", name: "C", online: true, os: "linux", provider: "local" },
  ];
  assert.deepEqual(orderedSpaces(items).map((item) => item.id), ["online", "unknown", "offline"]);
  assert.equal(items[0].id, "offline");
  items[0].online = true;
  assert.deepEqual(orderedSpaces(items).map((item) => item.id), ["offline", "online", "unknown"]);
});

test("only pasted images in the controller temp directory use local reads", () => {
  assert.equal(localClipboard(join(tmpdir(), "pi-clipboard-1234.png")), true);
  assert.equal(localClipboard(join(tmpdir(), "pi-clipboard-1234.webp")), true);
  for (const path of ["pi-clipboard-1234.png", "/workspace/pi-clipboard-1234.png", join(tmpdir(), "credentials.json"), join(tmpdir(), "nested/pi-clipboard-1234.png")]) {
    assert.equal(localClipboard(path), false, path);
  }
});

test("an older fetch expiry cannot evict a newer cached read", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new FakeSpacesClient([]);
  let calls = 0;
  client.spawn = async (_space, _spec, output) => {
    output("stdout", Buffer.from(`read-${++calls}`));
    return {
      exited: Promise.resolve({ code: 0, signal: null, error: null }),
      write: async () => {}, closeStdin: async () => {}, kill: async () => {},
    };
  };
  const ops = spaceOperations({ client, spaceId: "test", name: "test", home: "/home/test", os: "linux" }, "/local", "/remote");
  assert.equal((await ops.read.readFile("file")).toString(), "read-1");
  t.mock.timers.tick(600);
  await ops.read.access("file");
  t.mock.timers.tick(500);
  assert.equal((await ops.read.readFile("file")).toString(), "read-2");
  assert.equal(calls, 2);
});

test("workspace bash uses the same PATH setup as internal commands", async () => {
  const client = new FakeSpacesClient([]);
  let script = "";
  client.spawn = async (_space, spec) => {
    script = spec.args?.[1] ?? "";
    return {
      exited: Promise.resolve({ code: 0, signal: null, error: null }),
      write: async () => {},
      closeStdin: async () => {},
      kill: async () => {},
    };
  };
  const ops = spaceOperations({ client, spaceId: "test", name: "test", home: "/home/test", os: "linux" }, "/local", "/remote");
  await ops.bash.exec("node --version", "/local", { onData: () => {} });
  assert.equal(script, `${pathPrefix}cd '/remote' && node --version`);
});
