import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { deviceAuthMessage } from "../src/deviceChannel.js";
import { claimMessage } from "../src/pairing.js";
import { createTestApp, makeNodeKeys } from "./helpers.js";

const person = (n: string) => ({
  displayName: n,
  avatarUrl: null,
  verifiedEmails: [`${n}@example.test`],
});
const body = async (r: Response) => (await r.json()) as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (url: string, json: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(json),
  });

/** Fully pairs a node over real HTTP, as the headless node does. */
async function pairNode(t: Awaited<ReturnType<typeof setup>>, base: string) {
  const keys = makeNodeKeys();
  const p = (await (
    await post(`${base}/v1/pairings`, {
      publicKey: keys.publicKey,
      displayName: "Dell Server",
      platform: "linux",
      capabilities: [],
    })
  ).json()) as any;
  await t.a(`/v1/pairings/${p.pairingId}/approve`, { method: "POST", json: {} });
  const ch = (await (
    await post(`${base}/v1/pairings/${p.pairingId}/challenge`, { secret: p.secret })
  ).json()) as any;
  const claimed = (await (
    await post(`${base}/v1/pairings/${p.pairingId}/claim`, {
      secret: p.secret,
      nonce: ch.nonce,
      signature: keys.sign(claimMessage(p.pairingId, ch.nonce)),
    })
  ).json()) as any;
  return { keys, deviceId: claimed.deviceId as string };
}

async function setup(options: Parameters<typeof createTestApp>[0] = {}) {
  const t = await createTestApp({ users: { u_a: person("a"), u_b: person("b") }, ...options });
  await t.ledger.approve({ clerkUserId: "u_a" });
  await t.ledger.approve({ clerkUserId: "u_b" });
  return { ...t, a: t.as("u_a"), b: t.as("u_b") };
}

/** Minimal client that records every server message and the close code. */
function client(url: string, opts: { origin?: string } = {}) {
  const ws = new WebSocket(url, opts.origin ? { origin: opts.origin } : undefined);
  const messages: any[] = [];
  let closed: { code: number } | null = null;
  ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
  ws.on("close", (code) => (closed = { code }));
  ws.on("error", () => {});
  const waitFor = async (pred: (m: any) => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = messages.find(pred);
      if (hit) return hit;
      await sleep(10);
    }
    throw new Error(
      `timeout waiting; saw ${JSON.stringify(messages)} closed=${JSON.stringify(closed)}`,
    );
  };
  const waitForNth = async (type: string, n: number, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hits = messages.filter((m) => m.type === type);
      if (hits.length >= n) return hits[n - 1];
      await sleep(10);
    }
    throw new Error(`timeout waiting for ${type} #${n}; saw ${JSON.stringify(messages)}`);
  };
  const waitClosed = async (ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (closed) return closed as { code: number };
      await sleep(10);
    }
    throw new Error("timeout waiting for close");
  };
  const opened = new Promise<void>((ok, fail) => {
    ws.once("open", () => ok());
    ws.once("error", fail);
    ws.once("unexpected-response", (_r, res) => fail(new Error(`HTTP ${res.statusCode}`)));
  });
  return { ws, messages, waitFor, waitForNth, waitClosed, opened, isClosed: () => closed !== null };
}
async function authenticate(url: string, deviceId: string, keys: ReturnType<typeof makeNodeKeys>) {
  const c = client(url);
  await c.opened;
  c.ws.send(JSON.stringify({ type: "hello", deviceId, protocol: 1 }));
  const ch = await c.waitFor((m) => m.type === "challenge");
  c.ws.send(
    JSON.stringify({ type: "auth", signature: keys.sign(deviceAuthMessage(deviceId, ch.nonce)) }),
  );
  return c;
}
const presence = async (t: Awaited<ReturnType<typeof setup>>, id: string) =>
  (await body(await t.a("/v1/devices"))).devices.find((d: any) => d.id === id)?.presence;

test("paired node authenticates by proving its key, goes online, and reconnects to the same device", async () => {
  const t = await setup({ presenceWindowMs: 300 });
  const srv = await t.listen();
  try {
    const { keys, deviceId } = await pairNode(t, srv.url);
    t.clock.now += 5000; // fake service clock: pairing time is long past
    const c = await authenticate(srv.wsUrl, deviceId, keys);
    const ok = await c.waitFor((m) => m.type === "authenticated");
    assert.ok(Date.parse(ok.sessionExpiresAt) > Date.now());
    assert.equal(await presence(t, deviceId), "online");
    c.ws.terminate();
    await sleep(50);
    t.clock.now += 1000;
    assert.equal(await presence(t, deviceId), "offline", "offline beyond the grace window");
    const again = await authenticate(srv.wsUrl, deviceId, keys);
    await again.waitFor((m) => m.type === "authenticated");
    assert.equal(await presence(t, deviceId), "online");
    assert.equal(
      ((await t.db.query("SELECT count(*)::int n FROM devices")).rows[0] as any).n,
      1,
      "no duplicate device",
    );
    again.ws.close();
  } finally {
    await srv.close();
  }
});

test("forged device id and wrong key fail identically; nothing reveals whether a device exists", async () => {
  const t = await setup();
  const srv = await t.listen();
  try {
    const { keys, deviceId } = await pairNode(t, srv.url);
    const attacker = makeNodeKeys();
    const results = [];
    for (const [id, k] of [
      [deviceId, attacker],
      ["00000000-0000-4000-8000-000000000000", keys],
      [deviceId.slice(0, 8), keys],
    ] as const) {
      const c = await authenticate(srv.wsUrl, id, k);
      results.push({
        msg: await c.waitFor((m) => m.type === "error"),
        close: await c.waitClosed(),
      });
    }
    for (const r of results) {
      assert.equal(r.msg.code, "auth_failed");
      assert.equal(r.close.code, 4003);
    }
    t.clock.now += 200_000;
    assert.equal(await presence(t, deviceId), "offline", "failed auths never create presence");
  } finally {
    await srv.close();
  }
});

test("revoked device: new authentication fails with 'revoked' (only to the key holder)", async () => {
  const t = await setup();
  const srv = await t.listen();
  try {
    const { keys, deviceId } = await pairNode(t, srv.url);
    await t.a(`/v1/devices/${deviceId}/revoke`, { method: "POST" });
    const c = await authenticate(srv.wsUrl, deviceId, keys);
    await c.waitFor((m) => m.type === "revoked");
    assert.equal((await c.waitClosed()).code, 4001);
    assert.equal(await presence(t, deviceId), "revoked");
    // Without the key, a revoked id is indistinguishable from an unknown one.
    const stranger = await authenticate(srv.wsUrl, deviceId, makeNodeKeys());
    await stranger.waitFor((m) => m.type === "error" && m.code === "auth_failed");
  } finally {
    await srv.close();
  }
});

test("revoking from the account closes the live connection promptly", async () => {
  const t = await setup();
  const srv = await t.listen();
  try {
    const { keys, deviceId } = await pairNode(t, srv.url);
    const c = await authenticate(srv.wsUrl, deviceId, keys);
    await c.waitFor((m) => m.type === "authenticated");
    assert.equal(t.channel.isLive(deviceId), true);
    const started = Date.now();
    await t.a(`/v1/devices/${deviceId}/revoke`, { method: "POST" });
    await c.waitFor((m) => m.type === "revoked");
    assert.equal((await c.waitClosed()).code, 4001);
    assert.ok(Date.now() - started < 1000);
    assert.equal(t.channel.isLive(deviceId), false);
  } finally {
    await srv.close();
  }
});

test("another account cannot revoke or see the node connection", async () => {
  const t = await setup();
  const srv = await t.listen();
  try {
    const { keys, deviceId } = await pairNode(t, srv.url);
    const c = await authenticate(srv.wsUrl, deviceId, keys);
    await c.waitFor((m) => m.type === "authenticated");
    assert.equal((await t.b(`/v1/devices/${deviceId}/revoke`, { method: "POST" })).status, 404);
    assert.equal(t.channel.isLive(deviceId), true);
    assert.deepEqual((await body(await t.b("/v1/devices"))).devices, []);
  } finally {
    await srv.close();
  }
});

test("revocation of the owner's admission is enforced by the periodic re-check", async () => {
  const t = await setup({ channel: { pingIntervalMs: 80 } });
  const srv = await t.listen();
  try {
    const { keys, deviceId } = await pairNode(t, srv.url);
    const c = await authenticate(srv.wsUrl, deviceId, keys);
    await c.waitFor((m) => m.type === "authenticated");
    await t.ledger.revoke({ clerkUserId: "u_a" });
    await c.waitFor((m) => m.type === "revoked", 2000);
  } finally {
    await srv.close();
  }
});

test("a device revoked out-of-band (another instance) is dropped within one ping interval", async () => {
  const t = await setup({ channel: { pingIntervalMs: 80 } });
  const srv = await t.listen();
  try {
    const { keys, deviceId } = await pairNode(t, srv.url);
    const c = await authenticate(srv.wsUrl, deviceId, keys);
    await c.waitFor((m) => m.type === "authenticated");
    await t.db.query("UPDATE devices SET revoked_at = now() WHERE id = $1", [deviceId]);
    await c.waitFor((m) => m.type === "revoked", 2000);
  } finally {
    await srv.close();
  }
});

test("backend restart: node reconnects from its own identity, same device row, no Clerk", async () => {
  const t = await setup();
  const first = await t.listen();
  const { keys, deviceId } = await pairNode(t, first.url);
  const c1 = await authenticate(first.wsUrl, deviceId, keys);
  await c1.waitFor((m) => m.type === "authenticated");
  await first.close();
  await c1.waitClosed();
  const second = await t.listen(first.port); // same database, same address
  try {
    const c2 = await authenticate(second.wsUrl, deviceId, keys);
    await c2.waitFor((m) => m.type === "authenticated");
    assert.equal(await presence(t, deviceId), "online");
    assert.equal(((await t.db.query("SELECT count(*)::int n FROM devices")).rows[0] as any).n, 1);
  } finally {
    await second.close();
  }
});

test("malformed, oversized, binary, unknown and command-like messages close the connection", async () => {
  const t = await setup();
  const srv = await t.listen();
  try {
    const { keys, deviceId } = await pairNode(t, srv.url);
    const send = async (payload: string | Buffer, expectCode?: number) => {
      const c = client(srv.wsUrl);
      await c.opened;
      c.ws.send(payload);
      const closed = await c.waitClosed();
      if (expectCode) assert.equal(closed.code, expectCode);
      return c;
    };
    assert.equal(
      (await (await send("{not json")).waitFor((m) => m.type === "error")).code,
      "malformed",
    );
    await send("[1,2]");
    await send("null");
    await send("x".repeat(40_000), 1009);
    await send(Buffer.from([1, 2, 3]));
    await send(JSON.stringify({ type: "shell.exec", command: "id" }));
    await send(JSON.stringify({ type: "heartbeat" })); // before auth
    // After auth, a command-style message is still refused.
    const c = await authenticate(srv.wsUrl, deviceId, keys);
    await c.waitFor((m) => m.type === "authenticated");
    c.ws.send(JSON.stringify({ type: "file.read", path: "/etc/passwd" }));
    assert.equal((await c.waitFor((m) => m.type === "error")).code, "unknown_type");
    assert.equal((await c.waitClosed()).code, 1008);
    // Bad hello and bad capabilities.
    const bad = client(srv.wsUrl);
    await bad.opened;
    bad.ws.send(JSON.stringify({ type: "hello", deviceId: 5, protocol: 1 }));
    assert.equal((await bad.waitFor((m) => m.type === "error")).code, "bad_hello");
    const caps = await authenticate(srv.wsUrl, deviceId, keys);
    await caps.waitFor((m) => m.type === "authenticated");
    caps.ws.send(JSON.stringify({ type: "capabilities", capabilities: ["root"] }));
    assert.equal((await caps.waitFor((m) => m.type === "error")).code, "bad_capabilities");
  } finally {
    await srv.close();
  }
});

test("message flooding is rate limited and unauthenticated sockets time out", async () => {
  const t = await setup({ channel: { messageLimit: 5, authTimeoutMs: 400 } });
  const srv = await t.listen();
  try {
    const { keys, deviceId } = await pairNode(t, srv.url);
    const flood = await authenticate(srv.wsUrl, deviceId, keys);
    await flood.waitFor((m) => m.type === "authenticated");
    for (let i = 0; i < 20; i++) flood.ws.send(JSON.stringify({ type: "pong" }));
    await flood.waitFor((m) => m.type === "error" && m.code === "rate_limited");
    const idle = client(srv.wsUrl);
    await idle.opened;
    await idle.waitFor((m) => m.type === "error" && m.code === "auth_timeout");
  } finally {
    await srv.close();
  }
});

test("browser-originated upgrades are refused", async () => {
  const t = await setup();
  const srv = await t.listen();
  try {
    await assert.rejects(client(srv.wsUrl, { origin: "https://evil.example" }).opened, /403/);
  } finally {
    await srv.close();
  }
});

test("liveness: pongs keep the session; silence disconnects; heartbeat is acknowledged", async () => {
  const t = await setup({ channel: { pingIntervalMs: 60 } });
  const srv = await t.listen();
  try {
    const { keys, deviceId } = await pairNode(t, srv.url);
    const live = await authenticate(srv.wsUrl, deviceId, keys);
    await live.waitFor((m) => m.type === "authenticated");
    live.ws.on(
      "message",
      (d) =>
        JSON.parse(d.toString()).type === "ping" && live.ws.send(JSON.stringify({ type: "pong" })),
    );
    await sleep(300);
    assert.equal(live.isClosed(), false);
    live.ws.send(JSON.stringify({ type: "heartbeat" }));
    await live.waitFor((m) => m.type === "pong");
    live.ws.close();
    const silent = await authenticate(srv.wsUrl, deviceId, keys);
    await silent.waitFor((m) => m.type === "authenticated");
    assert.equal((await silent.waitClosed(2000)).code, 1008);
  } finally {
    await srv.close();
  }
});

test("session lifetime: expiry warning, in-band re-proof renews, no renewal ends the session", async () => {
  const t = await setup({
    channel: { pingIntervalMs: 50, sessionTtlMs: 400, expiringWarnMs: 250 },
  });
  const srv = await t.listen();
  try {
    const { keys, deviceId } = await pairNode(t, srv.url);
    const c = await authenticate(srv.wsUrl, deviceId, keys);
    await c.waitFor((m) => m.type === "authenticated");
    c.ws.on(
      "message",
      (d) =>
        JSON.parse(d.toString()).type === "ping" && c.ws.send(JSON.stringify({ type: "pong" })),
    );
    await c.waitFor((m) => m.type === "session_expiring", 2000);
    c.ws.send(JSON.stringify({ type: "reauth" }));
    const nonce = (await c.waitForNth("challenge", 2)).nonce;
    c.ws.send(
      JSON.stringify({ type: "auth", signature: keys.sign(deviceAuthMessage(deviceId, nonce)) }),
    );
    await c.waitForNth("authenticated", 2);
    await sleep(150);
    assert.equal(c.isClosed(), false, "renewed session continues");
    // Without renewal the session ends.
    assert.equal((await c.waitClosed(3000)).code, 4002);
    assert.ok(c.messages.some((m) => m.type === "disconnect" && m.reason === "session_expired"));
  } finally {
    await srv.close();
  }
});

test("reauth with a wrong key is refused and ends the connection", async () => {
  const t = await setup();
  const srv = await t.listen();
  try {
    const { keys, deviceId } = await pairNode(t, srv.url);
    const c = await authenticate(srv.wsUrl, deviceId, keys);
    await c.waitFor((m) => m.type === "authenticated");
    c.ws.send(JSON.stringify({ type: "reauth" }));
    const nonce = (await c.waitForNth("challenge", 2)).nonce;
    c.ws.send(
      JSON.stringify({
        type: "auth",
        signature: makeNodeKeys().sign(deviceAuthMessage(deviceId, nonce)),
      }),
    );
    await c.waitFor((m) => m.type === "error" && m.code === "auth_failed");
  } finally {
    await srv.close();
  }
});

test("a second connection replaces the first for the same device (one live session)", async () => {
  const t = await setup();
  const srv = await t.listen();
  try {
    const { keys, deviceId } = await pairNode(t, srv.url);
    const one = await authenticate(srv.wsUrl, deviceId, keys);
    await one.waitFor((m) => m.type === "authenticated");
    const two = await authenticate(srv.wsUrl, deviceId, keys);
    await two.waitFor((m) => m.type === "authenticated");
    assert.equal((await one.waitClosed()).code, 4004);
    assert.equal(t.channel.liveCount(), 1);
  } finally {
    await srv.close();
  }
});

test("capabilities updates are descriptive and validated", async () => {
  const t = await setup();
  const srv = await t.listen();
  try {
    const { keys, deviceId } = await pairNode(t, srv.url);
    const c = await authenticate(srv.wsUrl, deviceId, keys);
    await c.waitFor((m) => m.type === "authenticated");
    c.ws.send(JSON.stringify({ type: "capabilities", capabilities: ["files", "files", "git"] }));
    await sleep(100);
    const device = (await body(await t.a("/v1/devices"))).devices.find(
      (d: any) => d.id === deviceId,
    );
    assert.deepEqual(device.capabilities, ["files", "git"]);
  } finally {
    await srv.close();
  }
});
