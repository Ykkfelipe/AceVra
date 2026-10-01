import { createSign, generateKeyPairSync } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { createAccountApp } from "../src/app.js";
import { createAccountService, createAdmissionLedger } from "../src/accounts.js";
import { createClerkIdentityVerifier } from "../src/clerk.js";
import { migrate } from "../src/migrate.js";
import type { ClerkUserDirectory, ClerkUserProfile, SqlExecutor } from "../src/ports.js";

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
  claims: { sub: string; azp?: string; expOffsetSec?: number },
  key = privateKey,
): string {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: "RS256", typ: "JWT", kid: "test" })}.${b64({
    sub: claims.sub,
    sid: "sess_test",
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
  authorizedParties?: string[];
  rateLimit?: { limit: number; windowMs: number };
  log?: (line: string) => void;
}) {
  const db = await createTestDb();
  const users = options?.users ?? {};
  const directory: ClerkUserDirectory = {
    getUser: async (id) => {
      const user = users[id];
      if (!user) throw new Error("unknown clerk user");
      return user;
    },
  };
  const app = createAccountApp({
    verifier: createClerkIdentityVerifier({
      secretKey: "sk_test_unused-networkless",
      jwtKey: publicPem,
      authorizedParties: options?.authorizedParties ?? [],
    }),
    accounts: createAccountService({ db, directory }),
    rateLimit: options?.rateLimit ?? { limit: 10_000, windowMs: 60_000 },
    log: options?.log,
  });
  const me = (token?: string, headers: Record<string, string> = {}) =>
    app.request("/v1/me", {
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });
  return { db, app, me, ledger: createAdmissionLedger(db) };
}
