import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "@clerk/backend";
import { createSessionDirectory, type ClerkSessionCalls } from "../src/clerk.js";

const session = (over: Partial<Session> & { id: string; userId: string }): Session =>
  ({
    clientId: "client_1",
    status: "active",
    lastActiveAt: 1_700_000_000_000,
    expireAt: 1_700_003_600_000,
    abandonAt: 1_700_003_600_000,
    createdAt: 1_699_000_000_000,
    updatedAt: 1_700_000_000_000,
    actor: null,
    ...over,
  }) as unknown as Session;

function harness(sessions: Session[]) {
  const revoked: string[] = [];
  const calls: ClerkSessionCalls = {
    list: async () => ({ data: sessions }),
    get: async (id) => {
      const found = sessions.find((s) => s.id === id);
      if (!found) throw new Error("not found");
      return found;
    },
    revoke: async (id) => {
      revoked.push(id);
      return session({ id, userId: "user_me" });
    },
  };
  return { directory: createSessionDirectory(calls), revoked };
}

test("lists only active sessions for the requested user", async () => {
  const { directory } = harness([
    session({ id: "sess_a", userId: "user_me" }),
    session({ id: "sess_b", userId: "user_me", status: "ended" }),
  ]);
  const listed = await directory.listActiveSessions("user_me");
  assert.deepEqual(
    listed.sessions.map((s) => s.id),
    ["sess_a"],
  );
  assert.equal(listed.partial, false);
});

test("the user id always comes from the caller of record, never from the record", async () => {
  let askedFor = "";
  const directory = createSessionDirectory({
    list: async (params) => {
      askedFor = params.userId;
      return { data: [] };
    },
    get: async () => ({ userId: "x" }),
    revoke: async () => ({}),
  });
  await directory.listActiveSessions("user_me");
  assert.equal(askedFor, "user_me");
});

test("reports only activity Clerk actually provided, never a fabricated device", async () => {
  const { directory } = harness([
    session({
      id: "sess_plain",
      userId: "user_me",
      // latestActivity is optional in Clerk's model: absent must read as "unknown".
    }),
  ]);
  const { sessions: plainSessions } = await directory.listActiveSessions("user_me");
  const [plain] = plainSessions;
  assert.deepEqual(plain, {
    id: "sess_plain",
    status: "active",
    createdAt: 1_699_000_000_000,
    lastActiveAt: 1_700_000_000_000,
    deviceType: null,
    browserName: null,
    country: null,
  });

  const { directory: withActivity } = harness([
    session({
      id: "sess_detail",
      userId: "user_me",
      latestActivity: {
        deviceType: "Desktop",
        browserName: "Electron",
        country: "CO",
        // The IP address must never reach the client.
        ipAddress: "203.0.113.9",
      } as never,
    }),
  ]);
  const { sessions: detailSessions } = await withActivity.listActiveSessions("user_me");
  const [detail] = detailSessions;
  assert.ok(detail, "session is listed");
  assert.equal(detail.deviceType, "Desktop");
  assert.equal(detail.browserName, "Electron");
  assert.equal(detail.country, "CO");
  assert.equal(JSON.stringify(detail).includes("203.0.113.9"), false, "no IP address");
});

test("only genuinely active sessions are listed, whatever the query returned", async () => {
  // The list is a security-review surface, so anything not active is dropped even if
  // Clerk's response contained it. An unrecognised status is therefore also excluded,
  // rather than being passed through as an unvetted value.
  const { directory } = harness([
    session({ id: "sess_ok", userId: "user_me" }),
    session({ id: "sess_revoked", userId: "user_me", status: "revoked" }),
    session({ id: "sess_expired", userId: "user_me", status: "expired" }),
    session({ id: "sess_future", userId: "user_me", status: "somethingNewInClerk" }),
  ]);
  const { sessions: listed } = await directory.listActiveSessions("user_me");
  assert.deepEqual(
    listed.map((s) => s.id),
    ["sess_ok"],
  );
  assert.equal(listed[0]!.status, "active");
});

test("revoking a session you own succeeds", async () => {
  const { directory, revoked } = harness([session({ id: "sess_a", userId: "user_me" })]);
  assert.deepEqual(await directory.revokeSession("user_me", "sess_a"), { ok: true });
  assert.deepEqual(revoked, ["sess_a"]);
});

test("another account's session is never revoked and is not confirmed to exist", async () => {
  // This is the load-bearing fence: Clerk's revoke takes a bare session id, so without
  // the ownership check any authenticated user could end someone else's session.
  const { directory, revoked } = harness([session({ id: "sess_theirs", userId: "user_other" })]);
  assert.deepEqual(await directory.revokeSession("user_me", "sess_theirs"), {
    ok: false,
    reason: "not_found",
  });
  assert.deepEqual(revoked, [], "no revoke was attempted");
});

test("an unknown session id is indistinguishable from one owned by someone else", async () => {
  const { directory, revoked } = harness([]);
  assert.deepEqual(await directory.revokeSession("user_me", "sess_missing"), {
    ok: false,
    reason: "not_found",
  });
  assert.deepEqual(revoked, []);
});

test("a lookup outage is a not_found, so an unreachable Clerk never leaks existence", async () => {
  const directory = createSessionDirectory({
    list: async () => ({ data: [] }),
    get: async () => {
      throw new Error("clerk unreachable");
    },
    revoke: async () => ({}),
  });
  assert.deepEqual(await directory.revokeSession("user_me", "sess_a"), {
    ok: false,
    reason: "not_found",
  });
});

test("a revoke failure is NOT reported as not_found", async () => {
  // Deliberately different from the lookup case. By the time we revoke, ownership is
  // already proven, so an outage means "we could not end it" — reporting not_found
  // would tell the user their other session is gone when it may still be live. This
  // propagates so the route answers 503, which the client shows as retryable.
  const directory = createSessionDirectory({
    list: async () => ({ data: [] }),
    get: async () => ({ userId: "user_me" }),
    revoke: async () => {
      throw new Error("clerk unreachable");
    },
  });
  await assert.rejects(() => directory.revokeSession("user_me", "sess_a"), /unreachable/);
});

/* ------------------------------------------------------------------ *
 * Route level: ownership, current-session identity, and the boundary
 * between "human login session" and "AceVra device".
 * ------------------------------------------------------------------ */

import { createTestApp } from "./helpers.js";
import type { HumanSessionDirectory, HumanSessionRecord } from "../src/ports.js";

const record = (id: string, over: Partial<HumanSessionRecord> = {}): HumanSessionRecord => ({
  id,
  status: "active",
  createdAt: 1_699_000_000_000,
  lastActiveAt: 1_700_000_000_000,
  deviceType: null,
  browserName: null,
  country: null,
  ...over,
});

/** A directory that knows several users' sessions, as Clerk would. */
function multiOwnerDirectory(owned: Record<string, HumanSessionRecord[]>) {
  const revoked: Array<{ user: string; session: string }> = [];
  const directory: HumanSessionDirectory = {
    listActiveSessions: async (clerkUserId) => ({
      sessions: owned[clerkUserId] ?? [],
      partial: false,
    }),
    revokeSession: async (clerkUserId, sessionId) => {
      const found = (owned[clerkUserId] ?? []).find((s) => s.id === sessionId);
      if (!found) return { ok: false, reason: "not_found" };
      revoked.push({ user: clerkUserId, session: sessionId });
      return { ok: true };
    },
  };
  return { directory, revoked, owned };
}

const ME = { displayName: "Ada", avatarUrl: null, verifiedEmails: ["me@test"] };
const OTHER = { displayName: "Bea", avatarUrl: null, verifiedEmails: ["other@test"] };
const STRANGER = { displayName: "Cy", avatarUrl: null, verifiedEmails: ["stranger@test"] };

/** An app where `me` and `other` are admitted and `stranger` is not. */
async function appWith(directory: HumanSessionDirectory) {
  const app = await createTestApp({
    sessions: directory,
    users: { user_me: ME, user_other: OTHER, user_stranger: STRANGER },
  });
  await app.ledger.approve({ email: "me@test" });
  await app.ledger.approve({ email: "other@test" });
  return app;
}

test("GET /v1/sessions lists only the caller's own sessions", async () => {
  const { directory } = multiOwnerDirectory({
    user_me: [
      record("sess_1"),
      record("sess_2", { deviceType: "Desktop", browserName: "Electron" }),
    ],
  });
  const app = await appWith(directory);
  const res = await app.as("user_me")("/v1/sessions");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { sessions: Array<Record<string, unknown>> };
  assert.deepEqual(
    body.sessions.map((s) => s.id),
    ["sess_1", "sess_2"],
  );
});

test("another account's sessions are never listed", async () => {
  const { directory } = multiOwnerDirectory({
    user_me: [record("sess_mine")],
    user_other: [record("sess_theirs")],
  });
  const app = await appWith(directory);
  const res = await app.as("user_other")("/v1/sessions");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { sessions: Array<{ id: string }> };
  assert.deepEqual(
    body.sessions.map((s) => s.id),
    ["sess_theirs"],
    "only its own, never the other account's",
  );
});

test("the session this request authenticated with is marked current", async () => {
  const { directory } = multiOwnerDirectory({
    user_me: [record("sess_1"), record("sess_2")],
  });
  const app = await appWith(directory);
  const res = await app.as("user_me", "sess_2")("/v1/sessions");
  const body = (await res.json()) as { sessions: Array<{ id: string; current: boolean }> };
  assert.deepEqual(
    body.sessions.map((s) => [s.id, s.current]),
    [
      ["sess_1", false],
      ["sess_2", true],
    ],
  );
});

test("a token with no sid marks nothing current rather than guessing", async () => {
  const { directory } = multiOwnerDirectory({ user_me: [record("sess_1")] });
  const app = await appWith(directory);
  const res = await app.as("user_me", null)("/v1/sessions");
  const body = (await res.json()) as { sessions: Array<{ current: boolean }> };
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0]!.current, false);
});

test("revoking a session you own succeeds and removes it from the next list", async () => {
  const { directory, revoked, owned } = multiOwnerDirectory({
    user_me: [record("sess_1"), record("sess_2")],
  });
  const app = await appWith(directory);

  const res = await app.as("user_me", "sess_1")("/v1/sessions/sess_2/revoke", { method: "POST" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(revoked, [{ user: "user_me", session: "sess_2" }]);

  owned.user_me = [record("sess_1")];
  const after = await app.as("user_me")("/v1/sessions");
  const body = (await after.json()) as { sessions: Array<{ id: string }> };
  assert.deepEqual(
    body.sessions.map((s) => s.id),
    ["sess_1"],
  );
});

test("revoking another account's session is a non-disclosing 404", async () => {
  const { directory, revoked } = multiOwnerDirectory({
    user_me: [record("sess_mine")],
    user_other: [record("sess_theirs")],
  });
  const app = await appWith(directory);

  const foreign = await app.as("user_me", "sess_mine")("/v1/sessions/sess_theirs/revoke", {
    method: "POST",
  });
  assert.equal(foreign.status, 404);
  assert.deepEqual(await foreign.json(), { error: "not_found" });
  assert.deepEqual(revoked, [], "no revoke was attempted on another account's session");

  // The owner can still revoke it, proving the 404 was about ownership, not absence.
  const owner = await app.as("user_other", "sess_theirs")("/v1/sessions/sess_theirs/revoke", {
    method: "POST",
  });
  assert.equal(owner.status, 200);
  assert.deepEqual(revoked, [{ user: "user_other", session: "sess_theirs" }]);
});

test("an unknown session id is indistinguishable from a foreign one", async () => {
  const { directory, revoked } = multiOwnerDirectory({ user_me: [record("sess_1")] });
  const app = await appWith(directory);
  const res = await app.as("user_me")("/v1/sessions/sess_nope/revoke", { method: "POST" });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
  assert.deepEqual(revoked, []);
});

test("both session routes require an authenticated, admitted account", async () => {
  const { directory } = multiOwnerDirectory({ user_me: [record("sess_1")] });
  const app = await appWith(directory);
  assert.equal((await app.me()).status, 401);
  assert.equal((await app.app.request("/v1/sessions")).status, 401);
  assert.equal(
    (await app.app.request("/v1/sessions/sess_1/revoke", { method: "POST" })).status,
    401,
  );
  // Authenticated but never admitted: 403, and still no session list.
  const denied = await app.as("user_stranger")("/v1/sessions");
  assert.equal(denied.status, 403);
});

test("revoke is rate-limited tighter than reads", async () => {
  const { directory } = multiOwnerDirectory({ user_me: [record("sess_1")] });
  const app = await appWith(directory);
  const statuses: number[] = [];
  for (let i = 0; i < 12; i += 1) {
    statuses.push(
      (await app.as("user_me")(`/v1/sessions/sess_${i}/revoke`, { method: "POST" })).status,
    );
  }
  assert.equal(statuses.includes(429), true, "repeated revokes are throttled");
  // Reads are unaffected by the revoke limiter.
  assert.equal((await app.as("user_me")("/v1/sessions")).status, 200);
});

test("a session id is not a device id and a device id is not a session id", async () => {
  // Signing in does not create a device, and a machine cannot be revoked through the
  // session routes. Asserted against routes that exist, so a passing 404 means "this
  // registry does not know that id" rather than "there is no such route".
  const { directory } = multiOwnerDirectory({ user_me: [record("sess_1")] });
  const app = await appWith(directory);

  // A device id offered to the session revoke route: the directory does not own it.
  assert.equal(
    (await app.as("user_me")("/v1/sessions/dev_1/revoke", { method: "POST" })).status,
    404,
  );

  // A session id offered to real device routes. Register one device, then try to
  // rename and revoke it using the session's id: both must behave as unknown devices.
  const registeredRes = await app.as("user_me")("/v1/devices/register", {
    method: "POST",
    json: {
      installationId: "22222222-2222-4222-8222-222222222222",
      type: "desktop",
      platform: "darwin",
      displayName: "Mac",
      capabilities: ["files"],
    },
  });
  const registered = (await registeredRes.json()) as { device: { id: string } };
  assert.ok(registered.device?.id, "the device registered");
  assert.equal(
    (
      await app.as("user_me")(`/v1/devices/${registered.device.id}`, {
        method: "PATCH",
        json: { displayName: "Renamed" },
      })
    ).status,
    200,
    "the real device is reachable by its own id",
  );
  assert.equal(
    (await app.as("user_me")(`/v1/devices/sess_1/heartbeat`, { method: "POST" })).status,
    404,
    "a session id is not a device id",
  );
});

test("a malformed session id never reaches the directory", async () => {
  // The id is interpolated into an outbound Clerk URL. Constraining its shape here is
  // what stops `/`, `.`, `?`, `#` and `%` from travelling; relying on the SDK to
  // reject a traversal would make the boundary depend on a dependency's internals.
  const seen: string[] = [];
  const { directory } = multiOwnerDirectory({ user_me: [record("sess_1")] });
  const app = await appWith({
    listActiveSessions: directory.listActiveSessions,
    revokeSession: async (user, id) => {
      seen.push(id);
      return directory.revokeSession(user, id);
    },
  });
  for (const bad of [
    "..%2F..%2Fusers",
    "..%2Fsess_x",
    "a%3Fb=1",
    "a%23frag",
    "sess 1",
    "sess/1",
    "x".repeat(200),
  ]) {
    const res = await app.as("user_me")(`/v1/sessions/${bad}/revoke`, { method: "POST" });
    assert.equal(res.status, 404, `expected 404 for ${bad}`);
  }
  assert.deepEqual(seen, [], "no malformed id reached the directory");
});

test("a well-formed session id is accepted", async () => {
  const { directory } = multiOwnerDirectory({ user_me: [record("sess_abc123")] });
  const app = await appWith(directory);
  const res = await app.as("user_me")("/v1/sessions/sess_abc123/revoke", { method: "POST" });
  assert.equal(res.status, 200);
});

test("the revoke limiter is keyed per account, not per client address", async () => {
  // Throttling before authentication, on a shared client key, would let an
  // unauthenticated caller spend the bucket and lock revoke for everyone.
  const { directory } = multiOwnerDirectory({
    user_me: [record("sess_1")],
    user_other: [record("sess_theirs")],
  });
  const app = await appWith(directory);
  for (let i = 0; i < 12; i += 1) {
    await app.as("user_me")(`/v1/sessions/sess_${i}/revoke`, { method: "POST" });
  }
  // user_other is throttled separately and must still be able to act.
  const other = await app.as("user_other")("/v1/sessions/sess_theirs/revoke", { method: "POST" });
  assert.equal(other.status, 200);
});
