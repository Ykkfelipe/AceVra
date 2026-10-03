/**
 * Revocation freshness, exercised through the real routes.
 *
 * The unit tests in sessionFreshness.test.ts prove the cache arithmetic. These prove
 * the property that matters end to end: a session Clerk has revoked stops being
 * accepted by the account API even though its JWT is still cryptographically valid
 * and unexpired — and the device, pairing and task routes are unaffected by it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestApp } from "./helpers.js";
import type { HumanSessionDirectory, HumanSessionRecord } from "../src/ports.js";

const record = (id: string): HumanSessionRecord => ({
  id,
  status: "active",
  createdAt: 1_699_000_000_000,
  lastActiveAt: 1_700_000_000_000,
  deviceType: null,
  browserName: null,
  country: null,
});

const ME = { displayName: "Ada", avatarUrl: null, verifiedEmails: ["me@test"] };
const OTHER = { displayName: "Bea", avatarUrl: null, verifiedEmails: ["other@test"] };

/** Liveness controlled per sid, so a test can revoke one session mid-flight. */
function livenessDirectory(
  owned: Record<string, string[]>,
  overrides: () => string | null = () => null,
) {
  const asked: string[] = [];
  const directory: HumanSessionDirectory = {
    listActiveSessions: async (clerkUserId) => ({
      sessions: (owned[clerkUserId] ?? []).map(record),
      partial: false,
    }),
    revokeSession: async (clerkUserId, sessionId) =>
      (owned[clerkUserId] ?? []).includes(sessionId)
        ? { ok: true }
        : { ok: false, reason: "not_found" as const },
    sessionStatus: async (clerkUserId, sessionId) => {
      asked.push(sessionId);
      const forced = overrides();
      if (forced !== null) return forced as "active" | "not_active" | "unavailable";
      return (owned[clerkUserId] ?? []).includes(sessionId) ? "active" : "not_active";
    },
  };
  return { directory, asked };
}

async function appWith(directory: HumanSessionDirectory, ttlSeconds: number) {
  const app = await createTestApp({
    sessions: directory,
    sessionFreshnessSeconds: ttlSeconds,
    users: { user_me: ME, user_other: OTHER },
    // Wall clock: the bound is a real duration here, and the suite does not wait it out.
    realClock: true,
  });
  await app.ledger.approve({ email: "me@test" });
  await app.ledger.approve({ email: "other@test" });
  return app;
}

test("an active session is admitted and reaches ordinary routes", async () => {
  const { directory } = livenessDirectory({ user_me: ["sess_me"] });
  const app = await appWith(directory, 300);
  assert.equal((await app.as("user_me", "sess_me")("/v1/me")).status, 200);
  assert.equal((await app.as("user_me", "sess_me")("/v1/devices")).status, 200);
  assert.equal((await app.as("user_me", "sess_me")("/v1/sessions")).status, 200);
});

test("a revoked session is rejected even though its JWT is valid and unexpired", async () => {
  // The token is signed with the real test key and carries exp 60s out, so the only
  // thing that can reject it is the freshness check.
  const { directory } = livenessDirectory({ user_me: [] }, () => "not_active");
  const app = await appWith(directory, 300);
  const res = await app.as("user_me", "sess_me")("/v1/me");
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "unauthenticated" });
});

test("revocation stops device, pairing and task routes too, not just /v1/me", async () => {
  // Freshness lives in authenticate(), so no route body runs for a revoked session.
  const { directory } = livenessDirectory({ user_me: [] }, () => "not_active");
  const app = await appWith(directory, 300);
  for (const path of [
    "/v1/devices",
    "/v1/targets",
    "/v1/tasks",
    "/v1/sessions",
    "/v1/pairings/lookup",
  ]) {
    const isLookup = path === "/v1/pairings/lookup";
    const res = await app.as("user_me", "sess_me")(
      path,
      isLookup
        ? {
            method: "POST",
            json: { code: "ABCDEFGH" },
          }
        : undefined,
    );
    assert.equal(res.status, 401, `${path} must reject a revoked session`);
  }
});

test("one user's revocation does not affect another user's session", async () => {
  // One directory answers for both users, so the rejection must come from the sid the
  // caller presents, not from anything global.
  const scoped = livenessDirectory({ user_me: ["sess_mine"], user_other: ["sess_theirs"] });
  scoped.directory.sessionStatus = async (clerkUserId, sessionId) =>
    clerkUserId === "user_other" && sessionId === "sess_theirs" ? "not_active" : "active";
  const app = await appWith(scoped.directory, 300);

  assert.equal((await app.as("user_other", "sess_theirs")("/v1/me")).status, 401);
  assert.equal(
    (await app.as("user_me", "sess_mine")("/v1/me")).status,
    200,
    "an unrelated session keeps working",
  );
});

test("an unknown sid for an admitted user is rejected rather than trusted", async () => {
  const { directory } = livenessDirectory({ user_me: ["sess_mine"] });
  const app = await appWith(directory, 300);
  assert.equal((await app.as("user_me", "sess_never_existed")("/v1/me")).status, 401);
});

test("a Clerk outage admits an unexpired token and never caches the absence", async () => {
  // Availability is preserved and the bound degrades to token expiry, which is the
  // M3 guarantee. An outage must not become a mass revocation.
  const { directory, asked } = livenessDirectory({ user_me: ["sess_me"] }, () => "unavailable");
  const app = await appWith(directory, 300);
  assert.equal((await app.as("user_me", "sess_me")("/v1/me")).status, 200);
  assert.equal((await app.as("user_me", "sess_me")("/v1/devices")).status, 200);
  assert.ok(asked.length >= 2, "the outage was not cached as an answer");
});

test("with the check disabled, behaviour is exactly M3's", async () => {
  // A signed session Clerk considers dead is still accepted until its token expires.
  const { directory } = livenessDirectory({ user_me: [] }, () => "not_active");
  const app = await appWith(directory, 0);
  assert.equal((await app.as("user_me", "sess_me")("/v1/me")).status, 200);
});

test("no default freshness means existing behaviour is unchanged", async () => {
  const { directory } = livenessDirectory({ user_me: [] }, () => "not_active");
  const app = await createTestApp({
    sessions: directory,
    users: { user_me: ME },
  });
  await app.ledger.approve({ email: "me@test" });
  assert.equal((await app.as("user_me", "sess_me")("/v1/me")).status, 200);
});

test("a restart revalidates and still rejects a revoked session", async () => {
  // Nothing is persisted: the restarted process has an empty cache and asks Clerk.
  const { directory } = livenessDirectory({ user_me: [] }, () => "not_active");
  const db = await (await import("./helpers.js")).createTestDb();
  const first = await createTestApp({
    db,
    sessions: directory,
    sessionFreshnessSeconds: 300,
    users: { user_me: ME },
    realClock: true,
  });
  await first.ledger.approve({ email: "me@test" });
  assert.equal((await first.as("user_me", "sess_me")("/v1/me")).status, 401);

  const restarted = await createTestApp({
    db,
    sessions: directory,
    sessionFreshnessSeconds: 300,
    users: { user_me: ME },
    realClock: true,
  });
  await restarted.ledger.approve({ email: "me@test" });
  assert.equal((await restarted.as("user_me", "sess_me")("/v1/me")).status, 401);
});

test("device ownership fences are unchanged with freshness enabled", async () => {
  const { directory } = livenessDirectory({ user_me: ["sess_me"], user_other: ["sess_other"] });
  const app = await appWith(directory, 300);
  const registered = await app.as("user_me", "sess_me")("/v1/devices/register", {
    method: "POST",
    json: {
      installationId: "33333333-3333-4333-8333-333333333333",
      type: "desktop",
      platform: "darwin",
      displayName: "Mac",
      capabilities: ["files"],
    },
  });
  const { device } = (await registered.json()) as { device: { id: string } };
  assert.ok(device.id);

  // Another account still cannot see or revoke it.
  assert.equal(
    (
      await app.as("user_other", "sess_other")(`/v1/devices/${device.id}/revoke`, {
        method: "POST",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await app.as("user_me", "sess_me")(`/v1/devices/${device.id}/heartbeat`, {
        method: "POST",
      })
    ).status,
    200,
  );
});

test("a token with no sid skips the check and performs no Clerk call", async () => {
  const { directory, asked } = livenessDirectory({ user_me: ["sess_me"] });
  const app = await appWith(directory, 300);
  assert.equal((await app.as("user_me", null)("/v1/me")).status, 200);
  assert.deepEqual(asked, [], "nothing to revalidate, so nothing was asked");
});
