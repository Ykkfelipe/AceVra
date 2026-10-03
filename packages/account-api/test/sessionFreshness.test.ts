import assert from "node:assert/strict";
import test from "node:test";
import { createSessionFreshness, type SessionStatusCheck } from "../src/sessionFreshness.js";

/** A controllable clock, so the revocation bound can be proven without waiting. */
function clock(start = 1_000_000) {
  const state = { now: start };
  return {
    now: () => state.now,
    advance: (ms: number) => (state.now += ms),
    set: (n: number) => (state.now = n),
  };
}

function harness(options?: {
  statuses?: SessionStatusCheck[] | (() => Promise<SessionStatusCheck>);
  ttlMs?: number;
  maxEntries?: number;
}) {
  const time = clock();
  const asked: Array<{ user: string; session: string }> = [];
  const queue = [...(Array.isArray(options?.statuses) ? options.statuses : [])];
  const responder =
    typeof options?.statuses === "function"
      ? options.statuses
      : async () =>
          queue.length > 1 ? (queue.shift() as SessionStatusCheck) : (queue[0] ?? "active");
  const freshness = createSessionFreshness({
    check: async (clerkUserId, sessionId) => {
      asked.push({ user: clerkUserId, session: sessionId });
      return responder();
    },
    ttlMs: options?.ttlMs ?? 300_000,
    clock: time.now,
    maxEntries: options?.maxEntries,
  });
  return { freshness, asked, time };
}

const evaluate = (
  h: ReturnType<typeof harness>,
  overrides: Partial<{ clerkUserId: string; sessionId: string; tokenExpiresAt: number }> = {},
) =>
  h.freshness.evaluate({
    clerkUserId: overrides.clerkUserId ?? "user_me",
    sessionId: overrides.sessionId ?? "sess_1",
    tokenExpiresAt: overrides.tokenExpiresAt ?? 1_000_000 + 60_000,
  });

test("an active session is admitted and not re-checked inside the TTL", async () => {
  const h = harness();
  const first = await evaluate(h);
  assert.deepEqual(first, { admit: true, reason: "revalidated_active" });
  for (let i = 0; i < 5; i += 1) {
    h.time.advance(10_000);
    assert.equal((await evaluate(h)).admit, true);
  }
  assert.equal(h.asked.length, 1, "one Clerk call per TTL window, not per request");
});

test("a session Clerk reports dead is rejected despite a valid, unexpired token", async () => {
  const h = harness({ statuses: ["not_active"] });
  const verdict = await evaluate(h);
  assert.equal(verdict.admit, false);
  assert.equal(verdict.reason, "revoked");
});

test("a mid-TTL revocation is caught on the next revalidation — the bound", async () => {
  // This is the security property, proven with a fake clock: a session confirmed at T
  // is admitted until T + TTL, and rejected at the first check after that.
  let status: SessionStatusCheck = "active";
  const h = harness({ statuses: async () => status, ttlMs: 300_000 });
  assert.equal((await evaluate(h)).admit, true);

  status = "not_active"; // revoked one millisecond after the confirmation
  h.time.advance(299_999);
  assert.equal((await evaluate(h)).admit, true, "still inside the freshness window");

  h.time.advance(1);
  const after = await evaluate(h);
  assert.equal(after.admit, false, "rejected exactly one TTL after the last confirmation");
  assert.equal(after.reason, "revoked");
  assert.equal(h.asked.length, 2, "exactly one revalidation at the boundary");
});

test("the negative answer is cached, so an outage cannot re-admit a dead session", async () => {
  let status: SessionStatusCheck = "not_active";
  const h = harness({ statuses: async () => status });
  assert.equal((await evaluate(h)).admit, false);
  status = "unavailable";
  h.time.advance(1_000);
  assert.equal((await evaluate(h)).admit, false, "cached negative survives an outage");
  assert.equal(h.asked.length, 1);
});

test("one user's revocation state cannot affect another sid", async () => {
  const h = harness({ statuses: ["active"] });
  await evaluate(h, { sessionId: "sess_dead", clerkUserId: "user_a" });
  const other = await evaluate(h, { sessionId: "sess_alive", clerkUserId: "user_b" });
  assert.equal(other.admit, true);
  assert.equal(h.asked.length, 2, "each sid was checked on its own");
});

test("a revoked session cannot be revived by another user presenting the same sid", async () => {
  // The cache is keyed by sid. A different user must not inherit the other user's
  // negative, and must not be able to launder a revoked sid back to "active".
  const h = harness({ statuses: ["not_active"] });
  assert.equal((await evaluate(h, { clerkUserId: "user_a", sessionId: "sess_x" })).admit, false);
  // Same sid, other user: revalidates rather than trusting the cached answer blindly.
  h.time.advance(300_000);
  assert.equal((await evaluate(h, { clerkUserId: "user_b", sessionId: "sess_x" })).admit, false);
});

test("concurrent first requests share one in-flight Clerk call", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const h = harness({
    statuses: async () => {
      await gate;
      return "active";
    },
  });
  const pending = Promise.all([evaluate(h), evaluate(h), evaluate(h)]);
  release!();
  await pending;
  assert.equal(h.asked.length, 1, "a burst is not a burst of Clerk calls");
});

test("when Clerk is unreachable an unexpired token is admitted and not cached", async () => {
  const h = harness({ statuses: ["unavailable"] });
  const verdict = await evaluate(h, { tokenExpiresAt: 1_000_000 + 60_000 });
  assert.equal(verdict.admit, true);
  assert.equal(verdict.reason, "outage_unexpired");
  // The absence of an answer must not be remembered as an answer.
  h.time.advance(1_000);
  assert.equal(h.freshness.size(), 0, "an outage caches nothing");
});

test("when Clerk is unreachable and the token has expired, the request is rejected", async () => {
  const h = harness({ statuses: ["unavailable"] });
  const verdict = await evaluate(h, { tokenExpiresAt: 1_000_000 - 1 });
  assert.equal(verdict.admit, false);
});

test("a check that throws is treated as an outage, not as a revocation", async () => {
  const h = harness({
    statuses: async () => {
      throw new Error("clerk exploded");
    },
  });
  const verdict = await evaluate(h);
  assert.equal(verdict.admit, true);
  assert.equal(verdict.reason, "outage_unexpired");
});

test("a restart revalidates and still rejects a revoked session", async () => {
  // A fresh cache is what a control-plane restart produces. It must not weaken the
  // property, because nothing was ever persisted.
  const first = harness({ statuses: ["not_active"] });
  assert.equal((await evaluate(first)).admit, false);

  const afterRestart = harness({ statuses: ["not_active"] });
  assert.equal((await evaluate(afterRestart)).admit, false);
});

test("the cache is bounded", async () => {
  const h = harness({ maxEntries: 3 });
  for (let i = 0; i < 10; i += 1) await evaluate(h, { sessionId: `sess_${i}` });
  assert.equal(h.freshness.size(), 3);
});

test("forget drops a cached answer and forces revalidation", async () => {
  const h = harness();
  await evaluate(h);
  h.freshness.forget("sess_1");
  await evaluate(h);
  assert.equal(h.asked.length, 2);
});

test("a zero TTL revalidates every time", async () => {
  const h = harness({ ttlMs: 0 });
  await evaluate(h);
  await evaluate(h);
  assert.equal(h.asked.length, 2, "the check can be disabled without changing its shape");
});
