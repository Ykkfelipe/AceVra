import assert from "node:assert/strict";
import test from "node:test";
import { PAIRING_TTL_MS, claimMessage } from "../src/pairing.js";
import { createTestApp, makeNodeKeys } from "./helpers.js";

const person = (n: string) => ({
  displayName: n,
  avatarUrl: null,
  verifiedEmails: [`${n}@example.test`],
});
const body = async (r: Response) => (await r.json()) as any;
const post = (
  app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> },
  path: string,
  json: unknown,
) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(json),
  });

async function setup() {
  const t = await createTestApp({ users: { u_a: person("a"), u_b: person("b") } });
  await t.ledger.approve({ clerkUserId: "u_a" });
  await t.ledger.approve({ clerkUserId: "u_b" });
  return { ...t, a: t.as("u_a"), b: t.as("u_b"), keys: makeNodeKeys() };
}
type Human = (path: string, init?: RequestInit & { json?: unknown }) => Promise<Response>;
const human = (a: Human, path: string, json: unknown = {}) => a(path, { method: "POST", json });

async function startPairing(
  t: Awaited<ReturnType<typeof setup>>,
  extra: Record<string, unknown> = {},
) {
  const response = await post(t.app, "/v1/pairings", {
    publicKey: t.keys.publicKey,
    displayName: "Dell Server",
    platform: "linux",
    capabilities: [],
    ...extra,
  });
  return { response, ...(response.status === 201 ? await body(response) : {}) } as any;
}
async function fullPair(t: Awaited<ReturnType<typeof setup>>) {
  const p = await startPairing(t);
  await human(t.a, "/v1/pairings/lookup", { code: p.code });
  await human(t.a, `/v1/pairings/${p.pairingId}/approve`);
  const ch = await body(
    await post(t.app, `/v1/pairings/${p.pairingId}/challenge`, { secret: p.secret }),
  );
  const claim = await post(t.app, `/v1/pairings/${p.pairingId}/claim`, {
    secret: p.secret,
    nonce: ch.nonce,
    signature: t.keys.sign(claimMessage(p.pairingId, ch.nonce)),
  });
  return { p, ch, claim };
}

test("valid pairing: create → lookup → approve → challenge → claim creates an owned node device", async () => {
  const t = await setup();
  const p = await startPairing(t);
  assert.match(p.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(p.secret.length >= 40);
  assert.equal(
    (
      (await body(
        await post(t.app, `/v1/pairings/${p.pairingId}/status`, { secret: p.secret }),
      )) as any
    ).status,
    "pending",
  );
  const found = await body(
    await human(t.a, "/v1/pairings/lookup", { code: p.code.toLowerCase().replace("-", " ") }),
  );
  assert.equal(found.pairing.displayName, "Dell Server");
  assert.ok(!("publicKey" in found.pairing) && !("secret" in found.pairing));
  assert.equal((await human(t.a, `/v1/pairings/${p.pairingId}/approve`)).status, 200);
  const { claim } = { claim: null } as any;
  void claim;
  const ch = await body(
    await post(t.app, `/v1/pairings/${p.pairingId}/challenge`, { secret: p.secret }),
  );
  const result = await post(t.app, `/v1/pairings/${p.pairingId}/claim`, {
    secret: p.secret,
    nonce: ch.nonce,
    signature: t.keys.sign(claimMessage(p.pairingId, ch.nonce)),
  });
  assert.equal(result.status, 201);
  const { deviceId, keyId } = await body(result);
  const list = await body(await t.a("/v1/devices"));
  const device = list.devices.find((d: any) => d.id === deviceId);
  assert.equal(device.type, "node");
  assert.equal(device.displayName, "Dell Server");
  assert.deepEqual(
    Object.keys(device).filter((k) => /key|secret|installation|account/i.test(k)),
    [],
  );
  const row = (
    await t.db.query("SELECT device_key_id, account_id FROM devices WHERE id = $1", [deviceId])
  ).rows[0] as any;
  assert.equal(row.device_key_id, keyId);
  assert.deepEqual(
    (await body(await t.b("/v1/devices"))).devices,
    [],
    "other account sees nothing",
  );
});

test("only hashes are stored: neither the secret nor the code appear in the database", async () => {
  const t = await setup();
  const p = await startPairing(t);
  const rows = JSON.stringify((await t.db.query("SELECT * FROM pairings")).rows);
  assert.ok(!rows.includes(p.secret));
  assert.ok(!rows.includes(p.code.replace("-", "")));
});

test("approval is required: an unapproved pairing cannot be challenged or claimed", async () => {
  const t = await setup();
  const p = await startPairing(t);
  const ch = await post(t.app, `/v1/pairings/${p.pairingId}/challenge`, { secret: p.secret });
  assert.equal(ch.status, 409);
  const claim = await post(t.app, `/v1/pairings/${p.pairingId}/claim`, {
    secret: p.secret,
    nonce: "x",
    signature: t.keys.sign("x"),
  });
  assert.equal(claim.status, 409);
});

test("rejected pairing can never be claimed", async () => {
  const t = await setup();
  const p = await startPairing(t);
  assert.equal((await human(t.a, `/v1/pairings/${p.pairingId}/reject`)).status, 200);
  assert.equal(
    (
      (await body(
        await post(t.app, `/v1/pairings/${p.pairingId}/status`, { secret: p.secret }),
      )) as any
    ).status,
    "rejected",
  );
  assert.equal(
    (await post(t.app, `/v1/pairings/${p.pairingId}/challenge`, { secret: p.secret })).status,
    409,
  );
  assert.equal(
    (await human(t.a, `/v1/pairings/${p.pairingId}/approve`)).status,
    409,
    "decision is final",
  );
});

test("expired pairing: not discoverable, not approvable, not claimable", async () => {
  const t = await setup();
  const p = await startPairing(t);
  t.clock.now += PAIRING_TTL_MS + 1000;
  assert.equal((await human(t.a, "/v1/pairings/lookup", { code: p.code })).status, 404);
  assert.equal((await human(t.a, `/v1/pairings/${p.pairingId}/approve`)).status, 409);
  assert.equal(
    (
      (await body(
        await post(t.app, `/v1/pairings/${p.pairingId}/status`, { secret: p.secret }),
      )) as any
    ).status,
    "expired",
  );
});

test("approved but expired before claim fails", async () => {
  const t = await setup();
  const p = await startPairing(t);
  await human(t.a, `/v1/pairings/${p.pairingId}/approve`);
  t.clock.now += PAIRING_TTL_MS + 1000;
  assert.equal(
    (await post(t.app, `/v1/pairings/${p.pairingId}/challenge`, { secret: p.secret })).status,
    409,
  );
});

test("replay and duplicate claim fail; the device is created once", async () => {
  const t = await setup();
  const { p, ch, claim } = await fullPair(t);
  assert.equal(claim.status, 201);
  const replay = await post(t.app, `/v1/pairings/${p.pairingId}/claim`, {
    secret: p.secret,
    nonce: ch.nonce,
    signature: t.keys.sign(claimMessage(p.pairingId, ch.nonce)),
  });
  assert.equal(replay.status, 409);
  assert.equal(((await t.db.query("SELECT count(*)::int n FROM devices")).rows[0] as any).n, 1);
  assert.equal(
    (await post(t.app, `/v1/pairings/${p.pairingId}/challenge`, { secret: p.secret })).status,
    409,
  );
});

test("wrong private key cannot claim, and repeated bad proofs burn the pairing", async () => {
  const t = await setup();
  const p = await startPairing(t);
  await human(t.a, `/v1/pairings/${p.pairingId}/approve`);
  const attacker = makeNodeKeys();
  for (let i = 0; i < 5; i++) {
    const ch = await body(
      await post(t.app, `/v1/pairings/${p.pairingId}/challenge`, { secret: p.secret }),
    );
    if (!ch.nonce) break;
    const r = await post(t.app, `/v1/pairings/${p.pairingId}/claim`, {
      secret: p.secret,
      nonce: ch.nonce,
      signature: attacker.sign(claimMessage(p.pairingId, ch.nonce)),
    });
    assert.equal(r.status, 401);
  }
  assert.equal(((await t.db.query("SELECT count(*)::int n FROM devices")).rows[0] as any).n, 0);
  assert.equal(
    (await post(t.app, `/v1/pairings/${p.pairingId}/challenge`, { secret: p.secret })).status,
    409,
    "pairing burned",
  );
});

test("the human code or approval alone is not a credential: wrong secret, missing/stale nonce, signature over another message", async () => {
  const t = await setup();
  const p = await startPairing(t);
  await human(t.a, `/v1/pairings/${p.pairingId}/approve`);
  assert.equal(
    (await post(t.app, `/v1/pairings/${p.pairingId}/challenge`, { secret: p.code })).status,
    404,
  );
  assert.equal(
    (await post(t.app, `/v1/pairings/${p.pairingId}/challenge`, { secret: "x".repeat(43) })).status,
    404,
  );
  const ch = await body(
    await post(t.app, `/v1/pairings/${p.pairingId}/challenge`, { secret: p.secret }),
  );
  const stale = await post(t.app, `/v1/pairings/${p.pairingId}/claim`, {
    secret: p.secret,
    nonce: "nope",
    signature: t.keys.sign(claimMessage(p.pairingId, "nope")),
  });
  assert.equal(stale.status, 401);
  const ch2 = await body(
    await post(t.app, `/v1/pairings/${p.pairingId}/challenge`, { secret: p.secret }),
  );
  const wrongMsg = await post(t.app, `/v1/pairings/${p.pairingId}/claim`, {
    secret: p.secret,
    nonce: ch2.nonce,
    signature: t.keys.sign("something else"),
  });
  assert.equal(wrongMsg.status, 401);
  void ch;
});

test("code brute force: a few misses per account then a cooldown; valid codes also blocked during it", async () => {
  const t = await setup();
  const p = await startPairing(t);
  for (let i = 0; i < 5; i++)
    assert.equal((await human(t.a, "/v1/pairings/lookup", { code: "AAAAAAAA" })).status, 404);
  const blocked = await human(t.a, "/v1/pairings/lookup", { code: p.code });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  // Another account is not locked out by A's misses.
  assert.equal((await human(t.b, "/v1/pairings/lookup", { code: p.code })).status, 200);
});

test("unauthenticated pairing creation is rate limited and validates keys", async () => {
  const t = await setup();
  assert.equal((await startPairing(t, { publicKey: "not-a-key" })).response.status, 400);
  assert.equal((await startPairing(t, { platform: "plan9" })).response.status, 400);
  assert.equal((await startPairing(t, { capabilities: ["root"] })).response.status, 400);
  const { generateKeyPairSync } = await import("node:crypto");
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .publicKey.export({ type: "spki", format: "der" })
    .toString("base64url");
  assert.equal((await startPairing(t, { publicKey: rsa })).response.status, 400, "only Ed25519");
  let limited = 0;
  for (let i = 0; i < 15; i++) if ((await startPairing(t)).response.status === 429) limited++;
  assert.ok(limited > 0);
});

test("wrong account: unauthenticated and non-admitted callers cannot look up or approve; an approved pairing stays with its approver", async () => {
  const t = await setup();
  const p = await startPairing(t);
  assert.equal((await post(t.app, "/v1/pairings/lookup", { code: p.code })).status, 401);
  assert.equal((await post(t.app, `/v1/pairings/${p.pairingId}/approve`, {})).status, 401);
  await human(t.a, `/v1/pairings/${p.pairingId}/approve`);
  // B cannot re-decide A's approval and the device ends up owned by A.
  assert.equal((await human(t.b, `/v1/pairings/${p.pairingId}/approve`)).status, 409);
  assert.equal((await human(t.b, `/v1/pairings/${p.pairingId}/reject`)).status, 409);
  const ch = await body(
    await post(t.app, `/v1/pairings/${p.pairingId}/challenge`, { secret: p.secret }),
  );
  const r = await body(
    await post(t.app, `/v1/pairings/${p.pairingId}/claim`, {
      secret: p.secret,
      nonce: ch.nonce,
      signature: t.keys.sign(claimMessage(p.pairingId, ch.nonce)),
    }),
  );
  assert.equal((await body(await t.a("/v1/devices"))).devices[0].id, r.deviceId);
  assert.deepEqual((await body(await t.b("/v1/devices"))).devices, []);
  assert.equal((await t.b(`/v1/devices/${r.deviceId}/revoke`, { method: "POST" })).status, 404);
});

test("a human session cannot forge node presence over HTTP heartbeat", async () => {
  const t = await setup();
  const { claim } = await fullPair(t);
  const { deviceId } = await body(claim);
  assert.equal((await t.a(`/v1/devices/${deviceId}/heartbeat`, { method: "POST" })).status, 404);
});
