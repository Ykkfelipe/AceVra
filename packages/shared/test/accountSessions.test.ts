/**
 * Session presentation rules.
 *
 * These pin three things the account UI must not get wrong:
 *  - only a session the backend actually marked is ever called "this session";
 *  - "last active" and "where" are reported only when Clerk said something, and a
 *    missing timestamp never becomes "just now"; and
 *  - a failed revoke is never described as though the session still exists.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  accountSessionActivity,
  accountSessionDevice,
  describeAccountSessionRevoke,
  splitAccountSessions,
} from "../src/accountSessions.js";
import { parseAccountSessions, type AccountSession } from "../src/account.js";

const session = (id: string, over: Partial<AccountSession> = {}): AccountSession => ({
  id,
  status: "active",
  createdAt: 1_699_000_000_000,
  lastActiveAt: 1_700_000_000_000,
  deviceType: null,
  browserName: null,
  country: null,
  current: false,
  ...over,
});

const text = (id: string, fallback: string) => fallback;

test("the marked session is the current one and everything else is other", () => {
  const { current, others } = splitAccountSessions([
    session("sess_a"),
    session("sess_b", { current: true }),
    session("sess_c"),
  ]);
  assert.equal(current?.id, "sess_b");
  assert.deepEqual(
    others.map((s) => s.id),
    ["sess_a", "sess_c"],
  );
});

test("nothing is promoted to current when no session is marked", () => {
  // A token with no `sid` claim marks nothing. Guessing "the only session is this one"
  // would assert an identity the backend never confirmed.
  const split = splitAccountSessions([session("sess_only")]);
  assert.equal(split.current, null);
  assert.equal(split.others.length, 1);
});

test("an empty list splits cleanly", () => {
  assert.deepEqual(splitAccountSessions([]), { current: null, others: [] });
});

test("only the first marked session counts if the backend ever marks two", () => {
  const split = splitAccountSessions([
    session("sess_a", { current: true }),
    session("sess_b", { current: true }),
  ]);
  assert.equal(split.current?.id, "sess_a");
  assert.equal(split.others.length, 0, "a marked session is never also listed as other");
});

test("activity buckets by elapsed time", () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(accountSessionActivity({ lastActiveAt: now }, now), { kind: "justNow" });
  assert.deepEqual(accountSessionActivity({ lastActiveAt: now - 5 * 60_000 }, now), {
    kind: "minutes",
    value: 5,
  });
  assert.deepEqual(accountSessionActivity({ lastActiveAt: now - 3 * 3_600_000 }, now), {
    kind: "hours",
    value: 3,
  });
  assert.deepEqual(accountSessionActivity({ lastActiveAt: now - 2 * 86_400_000 }, now), {
    kind: "days",
    value: 2,
  });
});

test("an impossible timestamp reads as unknown, never as just now", () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(accountSessionActivity({ lastActiveAt: now + 60_000 }, now), {
    kind: "unknown",
  });
  assert.deepEqual(accountSessionActivity({ lastActiveAt: Number.NaN }, now), { kind: "unknown" });
});

test("a device label uses only what Clerk reported", () => {
  assert.equal(
    accountSessionDevice({ deviceType: "Desktop", browserName: "Electron" }),
    "Desktop · Electron",
  );
  assert.equal(accountSessionDevice({ deviceType: "Mobile", browserName: null }), "Mobile");
  assert.equal(accountSessionDevice({ deviceType: null, browserName: null }), null);
  assert.equal(accountSessionDevice({ deviceType: "  ", browserName: null }), null);
});

test("revoke outcomes are described without implying the session still exists", () => {
  const revoked = describeAccountSessionRevoke({ status: "revoked" }, text);
  assert.equal(revoked.ok, true);

  const notFound = describeAccountSessionRevoke({ status: "not_found" }, text);
  assert.equal(notFound.ok, false);
  assert.equal(/no longer listed/i.test(notFound.message), true);
  // The wording must not reveal whether the id belonged to someone else.
  assert.equal(/another|belong|permission|not yours|forbidden/i.test(notFound.message), false);

  const unavailable = describeAccountSessionRevoke({ status: "unavailable" }, text);
  assert.equal(unavailable.ok, false);
  assert.equal(/try again/i.test(unavailable.message), true);
});

test("the sessions body is validated rather than trusted", () => {
  const good = {
    sessions: [
      {
        id: "sess_a",
        status: "active",
        createdAt: 1,
        lastActiveAt: 2,
        deviceType: null,
        browserName: null,
        country: null,
        current: true,
      },
    ],
  };
  assert.equal(parseAccountSessions(good)?.sessions[0]?.current, true);

  for (const bad of [
    null,
    {},
    { sessions: {} },
    { sessions: [{ id: "a" }] },
    { sessions: [{ ...good.sessions[0], current: "yes" }] },
    { sessions: [{ ...good.sessions[0], lastActiveAt: "2" }] },
    { sessions: [{ ...good.sessions[0], id: "" }] },
    { sessions: ["nope"] },
  ]) {
    assert.equal(parseAccountSessions(bad), null, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test("activity fields are optional in the body and become null, never a guess", () => {
  const parsed = parseAccountSessions({
    sessions: [
      {
        id: "sess_a",
        status: "active",
        createdAt: 1,
        lastActiveAt: 2,
        current: false,
      },
    ],
  });
  assert.equal(parsed?.sessions[0]?.deviceType, null);
  assert.equal(parsed?.sessions[0]?.browserName, null);
  assert.equal(parsed?.sessions[0]?.country, null);
});

test("an unreadable list is distinguishable from an empty one", () => {
  // `sessions: []` means "you have no other logins". An unavailable flag means "we
  // could not check". Collapsing them would show a confident, wrong security summary.
  assert.equal(parseAccountSessions({ sessions: [] })?.unavailable, undefined);
  assert.deepEqual(parseAccountSessions({ sessions: [] })?.sessions, []);
});
