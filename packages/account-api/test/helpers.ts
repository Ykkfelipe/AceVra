import { createSign, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { createControlPlane } from "../src/controlPlane.js";
import { createServer, type Server } from "node:http";
import { getRequestListener } from "@hono/node-server";
import type { DeviceChannelOptions } from "../src/deviceChannel.js";
import type { TaskServiceOptions } from "../src/tasks.js";
import { createAdmissionLedger } from "../src/accounts.js";
import { createClerkIdentityVerifier } from "../src/clerk.js";
import { migrate } from "../src/migrate.js";
import type {
  ClerkUserDirectory,
  ClerkUserProfile,
  HumanSessionDirectory,
  SqlExecutor,
} from "../src/ports.js";

/** A real PostgreSQL engine (WASM), so the production SQL is what the tests run. */
export async function createTestDb(): Promise<SqlExecutor> {
  const pglite = new PGlite();
  const wrap = (c: { query: PGlite["query"]; exec: PGlite["exec"] }): SqlExecutor => ({
    exec: async (script) => {
      await c.exec(script);
    },
    query: async (text, params) => ({ rows: (await c.query(text, params as never)).rows as never }),
    transaction: async (fn) => pglite.transaction((tx) => fn(wrap(tx as never))),
  });
  const db = wrap(pglite);
  await migrate(db);
  return db;
}

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Signs a Clerk-shaped session JWT with the test key. */
export function signSessionToken(
  claims: { sub: string; azp?: string; expOffsetSec?: number; sid?: string | null },
  key = privateKey,
): string {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: "RS256", typ: "JWT", kid: "test" })}.${b64({
    sub: claims.sub,
    ...(claims.sid === null ? {} : { sid: claims.sid ?? "sess_test" }),
    azp: claims.azp,
    iss: "https://clerk.test",
    iat: now,
    nbf: now - 5,
    exp: now + (claims.expOffsetSec ?? 60),
  })}`;
  const sign = createSign("RSA-SHA256");
  sign.update(input);
  return `${input}.${sign.sign(key).toString("base64url")}`;
}
export const foreignKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;

export async function createTestApp(options?: {
  users?: Record<string, ClerkUserProfile>;
  /** Human sessions owned by Clerk user id, as the boundary reports them. */
  sessions?: HumanSessionDirectory;
  /**
   * Revocation-freshness TTL in seconds. Omit or 0 to leave the check off, which is
   * what most suites want; the M3a suite sets it explicitly.
   */
  sessionFreshnessSeconds?: number;
  authorizedParties?: string[];
  rateLimit?: { limit: number; windowMs: number };
  log?: (line: string) => void;
  channel?: DeviceChannelOptions;
  presenceWindowMs?: number;
  nodeGraceMs?: number;
  /** Use wall-clock time (acceptance runs); default is a controllable fake clock. */
  realClock?: boolean;
  tasks?: TaskServiceOptions;
  /** Reuse a database across "backend restarts". */
  db?: SqlExecutor;
}) {
  const db = options?.db ?? (await createTestDb());
  const clock = options?.realClock
    ? {
        get now() {
          return Date.now();
        },
        set now(_value: number) {},
      }
    : { now: Date.now() };
  const users = options?.users ?? {};
  const directory: ClerkUserDirectory = {
    getUser: async (id) => {
      const user = users[id];
      if (!user) throw new Error("unknown clerk user");
      return user;
    },
  };
  const verifier = createClerkIdentityVerifier({
    secretKey: "sk_test_unused-networkless",
    jwtKey: publicPem,
    authorizedParties: options?.authorizedParties ?? [],
  });
  const { app, channel, tasks } = createControlPlane({
    db,
    verifier,
    directory,
    sessions: options?.sessions,
    sessionFreshnessSeconds: options?.sessionFreshnessSeconds,
    clock: () => clock.now,
    channel: options?.channel,
    tasks: options?.tasks,
    presenceWindowMs: options?.presenceWindowMs,
    nodeGraceMs: options?.nodeGraceMs,
    rateLimit: options?.rateLimit ?? { limit: 10_000, windowMs: 60_000 },
    log: options?.log,
  });
  const me = (token?: string, headers: Record<string, string> = {}) =>
    app.request("/v1/me", {
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });
  /** Authenticated request as a Clerk user (admission decided by the ledger). */
  const as =
    (sub: string, sid?: string | null) =>
    async (path: string, init: RequestInit & { json?: unknown } = {}) =>
      app.request(path, {
        ...init,
        headers: {
          authorization: `Bearer ${signSessionToken({ sub, ...(sid === undefined ? {} : { sid }) })}`,
          ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
        ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      });
  /** Real HTTP + WebSocket listener (port 0 = ephemeral; pass a port to simulate a restart). */
  const listen = async (port = 0) => {
    const server: Server = createServer(getRequestListener(app.fetch));
    channel.attach(server);
    await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
    const address = server.address() as { port: number };
    return {
      port: address.port,
      url: `http://127.0.0.1:${address.port}`,
      wsUrl: `ws://127.0.0.1:${address.port}/v1/device-channel`,
      close: () => {
        channel.dropAll();
        server.closeAllConnections();
        return new Promise<void>((ok) => server.close(() => ok()));
      },
    };
  };
  return { db, app, me, as, clock, channel, tasks, listen, ledger: createAdmissionLedger(db) };
}

/** A node's Ed25519 identity, as the headless node generates it. */
export function makeNodeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    sign: (message: string) =>
      cryptoSign(null, Buffer.from(message), privateKey).toString("base64url"),
  };
}
