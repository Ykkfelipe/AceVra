import assert from "node:assert/strict";
import test from "node:test";
import { createTestApp, foreignKey, signSessionToken } from "./helpers.js";

const profile = (email: string) => ({
  displayName: "Test Person",
  avatarUrl: "https://img.example/a.png",
  verifiedEmails: [email],
});

test("admitted Clerk user (by id) receives a safe profile and a stable account", async () => {
  const { me, ledger } = await createTestApp({ users: { user_a: profile("a@example.test") } });
  await ledger.approve({ clerkUserId: "user_a" });
  const first = await me(signSessionToken({ sub: "user_a" }));
  assert.equal(first.status, 200);
  const body = (await first.json()) as Record<string, any>;
  assert.equal(body.admission.status, "approved");
  assert.equal(body.account.displayName, "Test Person");
  assert.deepEqual(Object.keys(body.account).sort(), ["avatarUrl", "displayName", "id"]);
  assert.equal(first.headers.get("cache-control"), "no-store");
  const second = (await (await me(signSessionToken({ sub: "user_a" }))).json()) as typeof body;
  assert.equal(second.account.id, body.account.id, "account is resolved, not recreated");
});

test("email approval binds through the VERIFIED email and then survives email changes", async () => {
  const users = { user_b: profile("b@example.test") };
  const { me, ledger, db } = await createTestApp({ users });
  await ledger.approve({ email: "B@Example.test" });
  assert.equal((await me(signSessionToken({ sub: "user_b" }))).status, 200);
  const bound = await db.query("SELECT clerk_user_id FROM admissions");
  assert.equal((bound.rows[0] as any).clerk_user_id, "user_b");
  users.user_b = profile("changed@example.test");
  assert.equal((await me(signSessionToken({ sub: "user_b" }))).status, 200);
});

test("an unverified email cannot claim an approval", async () => {
  const { me, ledger } = await createTestApp({
    users: { user_c: { displayName: null, avatarUrl: null, verifiedEmails: [] } },
  });
  await ledger.approve({ email: "c@example.test" });
  assert.equal((await me(signSessionToken({ sub: "user_c" }))).status, 403);
});

test("authenticated but not on the ledger is denied without disclosure", async () => {
  const { me } = await createTestApp({ users: { user_d: profile("d@example.test") } });
  const response = await me(signSessionToken({ sub: "user_d" }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "not_admitted" });
});

test("revocation takes effect on the very next request and revoke beats approve", async () => {
  const { me, ledger } = await createTestApp({ users: { user_e: profile("e@example.test") } });
  await ledger.approve({ clerkUserId: "user_e" });
  assert.equal((await me(signSessionToken({ sub: "user_e" }))).status, 200);
  await ledger.revoke({ clerkUserId: "user_e" });
  assert.equal((await me(signSessionToken({ sub: "user_e" }))).status, 403);
  await ledger.approve({ clerkUserId: "user_e" }); // approve must not silently un-revoke
  assert.equal((await me(signSessionToken({ sub: "user_e" }))).status, 403);
  await ledger.unrevoke({ clerkUserId: "user_e" });
  assert.equal((await me(signSessionToken({ sub: "user_e" }))).status, 200);
});

test("a revoked pending email stays denied when the user later signs in", async () => {
  const { me, ledger } = await createTestApp({ users: { user_f: profile("f@example.test") } });
  await ledger.approve({ email: "f@example.test" });
  await ledger.revoke({ email: "f@example.test" });
  assert.equal((await me(signSessionToken({ sub: "user_f" }))).status, 403);
});

test("missing, malformed, forged, expired and query-string tokens are all 401", async () => {
  const { me, app, ledger } = await createTestApp({ users: { user_g: profile("g@example.test") } });
  await ledger.approve({ clerkUserId: "user_g" });
  assert.equal((await me()).status, 401);
  assert.equal((await me("not-a-jwt")).status, 401);
  assert.equal((await me(signSessionToken({ sub: "user_g" }, foreignKey))).status, 401);
  assert.equal((await me(signSessionToken({ sub: "user_g", expOffsetSec: -3600 }))).status, 401);
  const viaQuery = await app.request(`/v1/me?token=${signSessionToken({ sub: "user_g" })}`);
  assert.equal(viaQuery.status, 401, "bearer is header-only");
});

test("authorized parties are enforced when configured", async () => {
  const { me, ledger } = await createTestApp({
    users: { user_h: profile("h@example.test") },
    authorizedParties: ["acevra-account://renderer"],
  });
  await ledger.approve({ clerkUserId: "user_h" });
  assert.equal(
    (await me(signSessionToken({ sub: "user_h", azp: "https://evil.test" }))).status,
    401,
  );
  assert.equal(
    (await me(signSessionToken({ sub: "user_h", azp: "acevra-account://renderer" }))).status,
    200,
  );
});

test("a Clerk directory outage on first sight is a 503, never an admission", async () => {
  const { me, ledger } = await createTestApp({ users: {} });
  await ledger.approve({ email: "i@example.test" });
  assert.equal((await me(signSessionToken({ sub: "user_unknown" }))).status, 503);
});

test("only account, admission, device, pairing and task tables exist (no sync/conversation entities)", async () => {
  const { db } = await createTestApp();
  const tables = await db.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
  );
  assert.deepEqual(
    tables.rows.map((r: any) => r.table_name),
    ["accounts", "admissions", "devices", "pairings", "task_events", "tasks"],
  );
});

test("hardening: strict bearer, oversized token, rate limit, safe errors, no CORS, no token logging", async () => {
  const lines: string[] = [];
  const { app } = await createTestApp({
    rateLimit: { limit: 3, windowMs: 60_000 },
    log: (l) => lines.push(l),
  });
  const token = signSessionToken({ sub: "user_x" });
  const call = (authorization: string) => app.request("/v1/me", { headers: { authorization } });
  assert.equal((await call(`Bearer ${token} extra`)).status, 401);
  assert.equal((await call(`Basic ${token}`)).status, 401);
  assert.equal((await call(`Bearer ${"a".repeat(5000)}`)).status, 401);
  const limited = await call(`Bearer ${token}`);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal(limited.headers.get("access-control-allow-origin"), null);
  assert.equal(limited.headers.get("x-content-type-options"), "nosniff");
  const fresh = (await createTestApp()).app;
  const big = await fresh.request("/v1/me", {
    method: "POST",
    headers: { "content-length": "20000" },
    body: "x".repeat(20000),
  });
  assert.equal(big.status, 413);
  assert.ok(
    lines.length > 0 && lines.every((l) => /^[A-Z]+ \/\S* \d{3}$/.test(l)),
    "log lines carry no tokens",
  );
});

test("a thrown handler error becomes a generic 503 with no detail", async () => {
  const { app } = await createTestApp({ users: {} });
  const response = await app.request("/v1/me", {
    headers: { authorization: `Bearer ${signSessionToken({ sub: "boom" })}` },
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "unavailable" });
});

test("repeated and concurrent sign-ins never create a duplicate account row", async () => {
  const { me, ledger, db } = await createTestApp({
    users: { user_dup: profile("dup@example.test") },
  });
  await ledger.approve({ clerkUserId: "user_dup" });
  await Promise.all([1, 2, 3, 4].map(() => me(signSessionToken({ sub: "user_dup" }))));
  await me(signSessionToken({ sub: "user_dup" }));
  const rows = await db.query("SELECT count(*)::int AS n FROM accounts");
  assert.equal((rows.rows[0] as any).n, 1);
});
