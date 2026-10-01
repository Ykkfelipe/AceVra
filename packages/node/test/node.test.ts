import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestApp } from "../../account-api/test/helpers.ts";
import { main } from "../src/cli.ts";
import { deriveNodeCapabilities } from "../src/capabilities.ts";
import { resolveNodePaths } from "../src/dataRoot.ts";
import { loadOrCreateIdentity } from "../src/identity.ts";
import { resolveEndpoints } from "../src/transport.ts";

const person = (n: string) => ({
  displayName: n,
  avatarUrl: null,
  verifiedEmails: [`${n}@example.test`],
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(
  fn: () => Promise<T | false | undefined> | T | false | undefined,
  ms = 8000,
): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(25);
  }
  throw new Error("timeout");
};

async function harness(options: Parameters<typeof createTestApp>[0] = {}) {
  const t = await createTestApp({ users: { u_a: person("a"), u_b: person("b") }, ...options });
  await t.ledger.approve({ clerkUserId: "u_a" });
  await t.ledger.approve({ clerkUserId: "u_b" });
  const home = await mkdtemp(join(tmpdir(), "av-node-"));
  const paths = resolveNodePaths({ ACEVRA_NODE_HOME: home });
  const a = t.as("u_a");
  /** Runs `acevra node connect` in-process until aborted; resolves with output + exit code. */
  const run = (api: string, extra: string[] = []) => {
    const controller = new AbortController();
    let output = "";
    let errors = "";
    const done = main(["node", "connect", "--api", api, ...extra], {
      env: { ACEVRA_NODE_HOME: home },
      stdout: { write: (v) => void (output += v) },
      stderr: { write: (v) => void (errors += v) },
      signal: controller.signal,
      pollMs: 40,
      channel: { minDelayMs: 40, maxDelayMs: 150 },
    });
    return { done, stop: () => controller.abort(), out: () => output, err: () => errors };
  };
  const statusOf = async () =>
    JSON.parse(await readFile(paths.status, "utf8").catch(() => "{}")).connection as
      | string
      | undefined;
  const approveCode = async (code: string) => {
    const found = (await (
      await a("/v1/pairings/lookup", { method: "POST", json: { code } })
    ).json()) as any;
    return a(`/v1/pairings/${found.pairing.id}/approve`, { method: "POST", json: {} });
  };
  const codeOf = (text: string) => text.match(/Code: ([A-Z2-9]{4}-[A-Z2-9]{4})/)?.[1];
  return {
    t,
    home,
    paths,
    a,
    run,
    statusOf,
    approveCode,
    codeOf,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

test("connect → code → approve → claim → authenticated; stop/restart resolves the same device with no re-pairing", async () => {
  const h = await harness();
  const srv = await h.t.listen();
  try {
    const first = h.run(srv.url, ["--name", "Dell Server"]);
    const code = await until(() => h.codeOf(first.out()));
    assert.match(first.out(), /Account → Devices → Pair a node/);
    assert.equal((await h.approveCode(code)).status, 200);
    await until(async () => (await h.statusOf()) === "connected");
    const devices = ((await (await h.a("/v1/devices")).json()) as any).devices;
    assert.equal(devices.length, 1);
    assert.equal(devices[0].type, "node");
    assert.equal(devices[0].displayName, "Dell Server");
    assert.equal(devices[0].presence, "online");
    assert.deepEqual(devices[0].capabilities, [], "no wired capability, none advertised");
    first.stop();
    assert.equal(await first.done, 0);
    // Restart: no pairing code is printed, same device id, online again.
    const second = h.run(srv.url);
    await until(async () => (await h.statusOf()) === "connected");
    assert.equal(codeOf2(second.out()), undefined, "ordinary restart needs no pairing");
    const again = ((await (await h.a("/v1/devices")).json()) as any).devices;
    assert.deepEqual(
      again.map((d: any) => d.id),
      devices.map((d: any) => d.id),
    );
    second.stop();
    await second.done;
  } finally {
    await srv.close();
    await h.cleanup();
  }
  function codeOf2(text: string) {
    return h.codeOf(text);
  }
});

test("secrets stay private: key file is 0600 Ed25519; no key/secret in output, logs, status or state", async () => {
  const h = await harness();
  const srv = await h.t.listen();
  try {
    const run = h.run(srv.url);
    const code = await until(() => h.codeOf(run.out()));
    await h.approveCode(code);
    await until(async () => (await h.statusOf()) === "connected");
    run.stop();
    await run.done;
    if (process.platform !== "win32") {
      assert.equal((await stat(h.paths.key)).mode & 0o777, 0o600);
      assert.equal((await stat(h.paths.root)).mode & 0o777, 0o700);
      assert.equal((await stat(h.paths.state)).mode & 0o777, 0o600);
    }
    const pem = await readFile(h.paths.key, "utf8");
    assert.match(pem, /BEGIN PRIVATE KEY/);
    const body = pem.replace(/-----[A-Z ]+-----|\s/g, "");
    const state = await readFile(h.paths.state, "utf8");
    const logs = (
      await Promise.all(
        (await readdir(h.paths.logs)).map((f) => readFile(join(h.paths.logs, f), "utf8")),
      )
    ).join("\n");
    for (const text of [
      run.out(),
      run.err(),
      logs,
      await readFile(h.paths.status, "utf8"),
      state,
    ]) {
      assert.ok(!text.includes(body), "private key material");
    }
    assert.ok(!state.includes("secret"), "pairing secret removed after claim");
    assert.ok(!logs.includes("secret") && !logs.includes(code.replace("-", "")));
    // The backend never received the private key: only a public key exists server-side.
    const rows = JSON.stringify((await h.t.db.query("SELECT * FROM devices")).rows);
    assert.ok(!rows.includes(body));
  } finally {
    await srv.close();
    await h.cleanup();
  }
});

test("rejected pairing ends with an error and leaves no device", async () => {
  const h = await harness();
  const srv = await h.t.listen();
  try {
    const run = h.run(srv.url);
    const code = await until(() => h.codeOf(run.out()));
    const found = (await (
      await h.a("/v1/pairings/lookup", { method: "POST", json: { code } })
    ).json()) as any;
    await h.a(`/v1/pairings/${found.pairing.id}/reject`, { method: "POST", json: {} });
    assert.equal(await run.done, 1);
    assert.match(run.err(), /rejected/);
    assert.deepEqual(((await (await h.a("/v1/devices")).json()) as any).devices, []);
  } finally {
    await srv.close();
    await h.cleanup();
  }
});

test("revoke from the account terminates the node; restart cannot resurrect it; re-pairing makes a NEW device", async () => {
  const h = await harness();
  const srv = await h.t.listen();
  try {
    const run = h.run(srv.url);
    await h.approveCode(await until(() => h.codeOf(run.out())));
    await until(async () => (await h.statusOf()) === "connected");
    const id = (((await (await h.a("/v1/devices")).json()) as any).devices[0] as any).id;
    await h.a(`/v1/devices/${id}/revoke`, { method: "POST" });
    assert.equal(await run.done, 3, "node exits as revoked");
    assert.equal(await h.statusOf(), "revoked");
    // Restarting the same identity stays revoked.
    const again = h.run(srv.url);
    assert.equal(await again.done, 3);
    // Explicit disconnect + new pairing creates a different device row.
    assert.equal(
      await main(["node", "disconnect"], {
        env: { ACEVRA_NODE_HOME: h.home },
        stdout: { write() {} },
      }),
      0,
    );
    const fresh = h.run(srv.url);
    await h.approveCode(await until(() => h.codeOf(fresh.out())));
    await until(async () => (await h.statusOf()) === "connected");
    const devices = ((await (await h.a("/v1/devices")).json()) as any).devices;
    assert.equal(devices.length, 2);
    assert.equal(devices.find((d: any) => d.id === id).presence, "revoked");
    fresh.stop();
    await fresh.done;
  } finally {
    await srv.close();
    await h.cleanup();
  }
});

test("network drop and backend restart: the node reconnects by itself, same device, no Clerk", async () => {
  const h = await harness({ presenceWindowMs: 200 });
  const first = await h.t.listen();
  try {
    const run = h.run(first.url);
    await h.approveCode(await until(() => h.codeOf(run.out())));
    await until(async () => (await h.statusOf()) === "connected");
    const id = (((await (await h.a("/v1/devices")).json()) as any).devices[0] as any).id;
    // Interruption: the server drops the connection.
    h.t.channel.closeDevice(id, "terminate");
    await until(
      async () => (await h.statusOf()) === "offline" || (await h.statusOf()) === "connecting",
    );
    await until(async () => (await h.statusOf()) === "connected");
    // Backend restart: listener gone entirely, then back on the same address with the same DB.
    await first.close();
    await until(async () => (await h.statusOf()) !== "connected");
    const second = await h.t.listen(first.port);
    try {
      await until(async () => (await h.statusOf()) === "connected", 10_000);
      const devices = ((await (await h.a("/v1/devices")).json()) as any).devices;
      assert.equal(devices.length, 1);
      assert.equal(devices[0].id, id);
      assert.equal(devices[0].presence, "online");
      run.stop();
      await run.done;
    } finally {
      await second.close();
    }
  } finally {
    await h.cleanup();
  }
});

test("status output is useful and never prints credentials", async () => {
  const h = await harness();
  const srv = await h.t.listen();
  try {
    const run = h.run(srv.url, ["--name", "Dell Server"]);
    await h.approveCode(await until(() => h.codeOf(run.out())));
    await until(async () => (await h.statusOf()) === "connected");
    let text = "";
    await main(["node", "status"], {
      env: { ACEVRA_NODE_HOME: h.home },
      stdout: { write: (v) => void (text += v) },
    });
    assert.match(text, /Device: Dell Server/);
    assert.match(text, /Account: paired/);
    assert.match(text, /Control plane: Connected/);
    assert.match(text, /Capabilities: none yet/);
    assert.match(text, /Device ID: [0-9a-f-]{8}…/);
    const id = (((await (await h.a("/v1/devices")).json()) as any).devices[0] as any).id;
    assert.ok(!text.includes(id), "device id is abbreviated");
    // disconnect refuses while the process is alive, then works once stopped.
    let err = "";
    assert.equal(
      await main(["node", "disconnect"], {
        env: { ACEVRA_NODE_HOME: h.home },
        stdout: { write() {} },
        stderr: { write: (v) => void (err += v) },
      }),
      1,
    );
    assert.match(err, /still running/);
    run.stop();
    await run.done;
  } finally {
    await srv.close();
    await h.cleanup();
  }
});

test("identity: Ed25519, stable, owner-only, loosened permissions are tightened", async () => {
  const home = await mkdtemp(join(tmpdir(), "av-node-id-"));
  try {
    const paths = resolveNodePaths({ ACEVRA_NODE_HOME: home });
    const a = await loadOrCreateIdentity(paths);
    const b = await loadOrCreateIdentity(paths);
    assert.equal(a.publicKey, b.publicKey);
    assert.match(a.keyId, /^k_[A-Za-z0-9_-]{22}$/);
    if (process.platform !== "win32") {
      await chmod(paths.key, 0o644);
      await loadOrCreateIdentity(paths);
      assert.equal((await stat(paths.key)).mode & 0o777, 0o600);
    }
    await writeFile(paths.key, "not a key");
    await assert.rejects(loadOrCreateIdentity(paths));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("transport policy: https/wss in production; plain http only for loopback or explicit dev opt-in", () => {
  assert.deepEqual(resolveEndpoints("https://api.example.test/anything"), {
    httpBase: "https://api.example.test",
    wsUrl: "wss://api.example.test/v1/device-channel",
  });
  assert.equal(
    resolveEndpoints("http://127.0.0.1:8787").wsUrl,
    "ws://127.0.0.1:8787/v1/device-channel",
  );
  assert.throws(() => resolveEndpoints("http://example.test"), /https/);
  assert.equal(
    resolveEndpoints("http://10.0.0.5:8787", { ACEVRA_NODE_ALLOW_INSECURE: "1" }).wsUrl,
    "ws://10.0.0.5:8787/v1/device-channel",
  );
  assert.throws(() => resolveEndpoints("ftp://x"), /https/);
  assert.throws(() => resolveEndpoints("nonsense"), /Invalid/);
});

test("capabilities are derived from wired services only", () => {
  assert.deepEqual(deriveNodeCapabilities(), []);
  assert.deepEqual(
    deriveNodeCapabilities([
      { capability: "git", available: () => false },
      { capability: "files", available: () => true },
      { capability: "files", available: () => true },
    ]),
    ["files"],
  );
});

test("an unreachable or hostile control plane never yields a device or a crash", async () => {
  const h = await harness();
  try {
    const run = h.run("http://127.0.0.1:9");
    assert.equal(await run.done, 1);
    assert.match(run.err(), /./);
    assert.equal(await main(["node", "bogus"], { stderr: { write() {} } }), 2);
    assert.equal(await main(["nope"], { stderr: { write() {} } }), 2);
    assert.equal(
      await main(["node", "connect", "--api", "http://example.test"], {
        env: { ACEVRA_NODE_HOME: h.home },
        stderr: { write() {} },
      }),
      1,
    );
  } finally {
    await h.cleanup();
  }
});
