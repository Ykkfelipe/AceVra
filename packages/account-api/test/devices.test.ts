import assert from "node:assert/strict";
import test from "node:test";
import { PRESENCE_WINDOW_MS } from "../src/devices.js";
import { createTestApp } from "./helpers.js";

const person = (n: string) => ({
  displayName: n,
  avatarUrl: null,
  verifiedEmails: [`${n}@example.test`],
});
const INSTALL_A = "11111111-1111-4111-8111-111111111111";
const INSTALL_B = "22222222-2222-4222-8222-222222222222";
const reg = (installationId = INSTALL_A, extra: Record<string, unknown> = {}) => ({
  installationId,
  type: "desktop",
  platform: "darwin",
  displayName: "Ada's MacBook",
  capabilities: ["files", "shell", "git"],
  ...extra,
});

async function setup() {
  const t = await createTestApp({
    users: { u_a: person("a"), u_b: person("b"), u_x: person("x") },
  });
  await t.ledger.approve({ clerkUserId: "u_a" });
  await t.ledger.approve({ clerkUserId: "u_b" });
  return { ...t, a: t.as("u_a"), b: t.as("u_b") };
}
const body = async (r: Response) => (await r.json()) as any;

test("register desktop, list own devices, no secrets in responses", async () => {
  const { a } = await setup();
  const created = await a("/v1/devices/register", { method: "POST", json: reg() });
  assert.equal(created.status, 201);
  const device = (await body(created)).device;
  assert.equal(device.presence, "online");
  assert.deepEqual(device.capabilities, ["files", "shell", "git"]);
  for (const hidden of [
    "installationId",
    "installation_id",
    "accountId",
    "account_id",
    "deviceKeyId",
  ]) {
    assert.ok(!(hidden in device), hidden);
  }
  const list = await body(await a("/v1/devices"));
  assert.deepEqual(
    list.devices.map((d: any) => d.id),
    [device.id],
  );
});

test("duplicate and replayed registration resolve the same device (no duplicates)", async () => {
  const { a, db } = await setup();
  const first = await body(await a("/v1/devices/register", { method: "POST", json: reg() }));
  const again = await a("/v1/devices/register", { method: "POST", json: reg() });
  assert.equal(again.status, 200);
  assert.equal((await body(again)).device.id, first.device.id);
  await Promise.all(
    [1, 2, 3].map(() => a("/v1/devices/register", { method: "POST", json: reg() })),
  );
  assert.equal(((await db.query("SELECT count(*)::int n FROM devices")).rows[0] as any).n, 1);
});

test("re-registering keeps a user-chosen name but refreshes descriptive facts", async () => {
  const { a } = await setup();
  const { device } = await body(await a("/v1/devices/register", { method: "POST", json: reg() }));
  await a(`/v1/devices/${device.id}`, { method: "PATCH", json: { displayName: "Studio Mac" } });
  const again = await body(
    await a("/v1/devices/register", {
      method: "POST",
      json: reg(INSTALL_A, { displayName: "other", capabilities: ["files"] }),
    }),
  );
  assert.equal(again.device.displayName, "Studio Mac");
  assert.deepEqual(again.device.capabilities, ["files"]);
});

test("another account cannot list, rename, heartbeat or revoke a device (non-disclosing 404)", async () => {
  const { a, b } = await setup();
  const { device } = await body(await a("/v1/devices/register", { method: "POST", json: reg() }));
  assert.deepEqual((await body(await b("/v1/devices"))).devices, []);
  assert.equal(
    (await b(`/v1/devices/${device.id}`, { method: "PATCH", json: { displayName: "x" } })).status,
    404,
  );
  assert.equal((await b(`/v1/devices/${device.id}/heartbeat`, { method: "POST" })).status, 404);
  assert.equal((await b(`/v1/devices/${device.id}/revoke`, { method: "POST" })).status, 404);
  assert.equal((await b("/v1/devices/forged-id/heartbeat", { method: "POST" })).status, 404);
  // Still intact for the owner.
  assert.equal((await body(await a("/v1/devices"))).devices[0].presence, "online");
});

test("account switch: another account cannot take over an installation", async () => {
  const { a, b } = await setup();
  await a("/v1/devices/register", { method: "POST", json: reg() });
  const taken = await b("/v1/devices/register", { method: "POST", json: reg() });
  assert.equal(taken.status, 409);
  assert.deepEqual(await body(taken), { error: "installation_bound" });
  assert.deepEqual((await body(await b("/v1/devices"))).devices, []);
  // A different installation for B is fine.
  assert.equal(
    (await b("/v1/devices/register", { method: "POST", json: reg(INSTALL_B) })).status,
    201,
  );
});

test("heartbeat updates lastSeen; presence goes offline after the window", async () => {
  const { a, clock } = await setup();
  const { device } = await body(await a("/v1/devices/register", { method: "POST", json: reg() }));
  clock.now += PRESENCE_WINDOW_MS + 5_000;
  assert.equal((await body(await a("/v1/devices"))).devices[0].presence, "offline");
  const beat = await body(await a(`/v1/devices/${device.id}/heartbeat`, { method: "POST" }));
  assert.equal(beat.device.presence, "online");
  assert.ok(Date.parse(beat.device.lastSeenAt) >= clock.now - 1);
});

test("rename validates the name", async () => {
  const { a } = await setup();
  const { device } = await body(await a("/v1/devices/register", { method: "POST", json: reg() }));
  assert.equal(
    (
      await a(`/v1/devices/${device.id}`, {
        method: "PATCH",
        json: { displayName: "  New   name " },
      })
    ).status,
    200,
  );
  assert.equal((await body(await a("/v1/devices"))).devices[0].displayName, "New name");
  for (const bad of ["", "x".repeat(61), "bad\u0001name", 5]) {
    assert.equal(
      (await a(`/v1/devices/${device.id}`, { method: "PATCH", json: { displayName: bad } })).status,
      400,
    );
  }
});

test("revoke: device is flagged, cannot heartbeat or re-register, stays visible to its owner", async () => {
  const { a } = await setup();
  const { device } = await body(await a("/v1/devices/register", { method: "POST", json: reg() }));
  const revoked = await body(await a(`/v1/devices/${device.id}/revoke`, { method: "POST" }));
  assert.equal(revoked.device.presence, "revoked");
  const beat = await a(`/v1/devices/${device.id}/heartbeat`, { method: "POST" });
  assert.equal(beat.status, 403);
  assert.deepEqual(await body(beat), { error: "device_revoked" });
  assert.equal((await a("/v1/devices/register", { method: "POST", json: reg() })).status, 403);
  assert.equal(
    (await a(`/v1/devices/${device.id}`, { method: "PATCH", json: { displayName: "z" } })).status,
    404,
  );
  assert.equal((await body(await a("/v1/devices"))).devices[0].presence, "revoked");
});

test("capability tampering: unknown, non-string or oversized sets are rejected; set is deduped", async () => {
  const { a } = await setup();
  for (const capabilities of [
    ["root"],
    ["files", 3],
    "files",
    Array.from({ length: 17 }, () => "files"),
  ]) {
    assert.equal(
      (await a("/v1/devices/register", { method: "POST", json: reg(INSTALL_A, { capabilities }) }))
        .status,
      400,
    );
  }
  const ok = await body(
    await a("/v1/devices/register", {
      method: "POST",
      json: reg(INSTALL_A, { capabilities: ["git", "git", "minecraft"] }),
    }),
  );
  assert.deepEqual(ok.device.capabilities, ["git", "minecraft"]);
});

test("input validation: bad installation id, type, platform; owner fields are ignored", async () => {
  const { a, db } = await setup();
  for (const extra of [
    { installationId: "x" },
    { type: "cloud" },
    { platform: "plan9" },
    { displayName: "" },
  ]) {
    assert.equal(
      (await a("/v1/devices/register", { method: "POST", json: reg(INSTALL_A, extra) })).status,
      400,
    );
  }
  const forged = await a("/v1/devices/register", {
    method: "POST",
    json: reg(INSTALL_A, { accountId: "someone-else", id: "forced" }),
  });
  assert.equal(forged.status, 201);
  const row = (await db.query("SELECT id, account_id FROM devices")).rows[0] as any;
  assert.notEqual(row.id, "forced");
  assert.notEqual(row.account_id, "someone-else");
});

test("device routes require an admitted account; revoked admission blocks devices too", async () => {
  const { a, as, ledger, app } = await setup();
  assert.equal((await app.request("/v1/devices")).status, 401);
  assert.equal((await as("u_x")("/v1/devices")).status, 403, "Clerk-authenticated, not admitted");
  const { device } = await body(await a("/v1/devices/register", { method: "POST", json: reg() }));
  await ledger.revoke({ clerkUserId: "u_a" });
  assert.equal((await a(`/v1/devices/${device.id}/heartbeat`, { method: "POST" })).status, 403);
});

test("relogin (a fresh token for the same Clerk user) resolves the same device", async () => {
  const { as } = await setup();
  const first = await body(
    await as("u_a")("/v1/devices/register", { method: "POST", json: reg() }),
  );
  const second = await body(
    await as("u_a")("/v1/devices/register", { method: "POST", json: reg() }),
  );
  assert.equal(second.device.id, first.device.id);
});
