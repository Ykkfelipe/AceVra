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
    listed.map((s) => s.id),
    ["sess_a"],
  );
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
  const [plain] = await directory.listActiveSessions("user_me");
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
  const [detail] = await withActivity.listActiveSessions("user_me");
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
  const listed = await directory.listActiveSessions("user_me");
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

test("a directory outage is a not_found, never a crash", async () => {
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
