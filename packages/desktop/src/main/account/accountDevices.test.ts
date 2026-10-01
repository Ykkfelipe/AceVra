import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAccountDevices } from "./accountDevices.js";
import { createInstallationStore } from "./accountInstallation.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const DEVICE = { id: "dev_1", displayName: "Mac", presence: "online", capabilities: ["files"] };

function harness(respond: (req: { method: string; path: string; body: any }) => Response | null) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const intervals: Array<() => void> = [];
  let cleared = 0;
  const devices = createAccountDevices({
    apiBaseUrl: "http://127.0.0.1:9",
    getToken: async () => "tok",
    installationId: async () => "11111111-1111-4111-8111-111111111111",
    describe: () => ({ platform: "darwin", displayName: "Mac", capabilities: ["files", "shell"] }),
    fetch: (async (url: URL, init: RequestInit) => {
      const entry = {
        method: init.method ?? "GET",
        path: new URL(url).pathname,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(entry);
      const out =
        entry.method === "GET" && entry.path === "/v1/devices"
          ? json(200, { devices: [DEVICE] })
          : respond(entry);
      if (!out) throw new TypeError("down");
      return out;
    }) as typeof fetch,
    timers: {
      setInterval: ((fn: () => void) => (intervals.push(fn), { unref() {} })) as never,
      clearInterval: (() => void cleared++) as never,
    },
  });
  return { devices, calls, intervals, cleared: () => cleared };
}

test("start registers this installation (no secrets sent) and begins heartbeats", async () => {
  const h = harness(() => json(201, { device: DEVICE }));
  await h.devices.start();
  assert.deepEqual(Object.keys(h.calls[0]!.body).sort(), [
    "capabilities",
    "displayName",
    "installationId",
    "platform",
    "type",
  ]);
  assert.equal(h.calls[0]!.body.type, "desktop");
  assert.equal(h.intervals.length, 1);
  h.intervals[0]!();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.at(-1)!.path, "/v1/devices/dev_1/heartbeat");
});

test("stop (logout) halts heartbeats and forgets only the projection", async () => {
  const h = harness(() => json(201, { device: DEVICE }));
  await h.devices.start();
  h.devices.stop();
  assert.equal(h.cleared() >= 1, true);
  assert.deepEqual(await h.devices.list(), {
    registration: "none",
    thisDeviceId: null,
    devices: [],
  });
  assert.equal(h.calls.filter((c) => c.path.includes("revoke")).length, 0, "never unregisters");
});

test("relogin registers again with the same installation id and resolves the same device", async () => {
  const h = harness(() => json(200, { device: DEVICE }));
  await h.devices.start();
  h.devices.stop();
  await h.devices.start();
  const registers = h.calls.filter((c) => c.path === "/v1/devices/register");
  assert.equal(registers.length, 2);
  assert.equal(registers[0]!.body.installationId, registers[1]!.body.installationId);
  assert.equal((await h.devices.list()).thisDeviceId, "dev_1");
});

test("installation owned by another account → conflict, no heartbeat, local use unaffected", async () => {
  const h = harness(() => json(409, { error: "installation_bound" }));
  await h.devices.start();
  assert.equal(h.intervals.length, 0);
  assert.equal((await h.devices.list()).registration, "conflict");
});

test("backend revoked this device → heartbeat stops and registration reads revoked", async () => {
  const h = harness((r) =>
    r.path.endsWith("/heartbeat")
      ? json(403, { error: "device_revoked" })
      : json(201, { device: DEVICE }),
  );
  await h.devices.start();
  h.intervals[0]!();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.cleared() >= 1, true);
  const view = await h.devices.list();
  assert.equal(view.registration, "revoked");
});

test("revoked on register stays revoked; unreachable backend never fabricates registration", async () => {
  assert.equal(
    (
      await (async () => {
        const h = harness(() => json(403, { error: "device_revoked" }));
        await h.devices.start();
        return h.devices.list();
      })()
    ).registration,
    "revoked",
  );
  const down = harness(() => null);
  await down.devices.start();
  assert.equal((await down.devices.list()).registration, "none");
  assert.equal(down.intervals.length, 0);
});

test("a registration that finishes after stop() is discarded", async () => {
  let release!: (r: Response) => void;
  const h = harness(() => null);
  const slow = createAccountDevices({
    apiBaseUrl: "http://127.0.0.1:9",
    getToken: async () => "tok",
    installationId: async () => "11111111-1111-4111-8111-111111111111",
    describe: () => ({ platform: "darwin", displayName: "Mac", capabilities: [] }),
    fetch: (() => new Promise<Response>((r) => (release = r))) as never,
    timers: { setInterval: (() => ({ unref() {} })) as never, clearInterval: (() => {}) as never },
  });
  const started = slow.start();
  await new Promise((r) => setImmediate(r));
  slow.stop();
  release(json(201, { device: DEVICE }));
  await started;
  assert.equal((await slow.list()).registration, "none");
  void h;
});

test("installation identity: random UUID, stable across calls and restarts, survives corruption by re-minting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "av-inst-"));
  try {
    const file = join(dir, "acevra-installation.json");
    const first = await createInstallationStore(file).getOrCreate();
    assert.match(first, /^[0-9a-f-]{36}$/);
    assert.equal(
      await createInstallationStore(file).getOrCreate(),
      first,
      "stable across restarts",
    );
    assert.deepEqual(Object.keys(JSON.parse(await readFile(file, "utf8"))), ["installationId"]);
    await writeFile(file, "{not json");
    assert.notEqual(await createInstallationStore(file).getOrCreate(), first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
