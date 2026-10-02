// Screen takeover gate (specs/computer-use.md "Screen takeover").
import assert from "node:assert/strict";
import { test } from "node:test";
import { requireTakeoverGrant } from "../takeover-grant.js";

const OWNER = { session: "sess_a", task: "turn_1" };

function authority(states) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async requestTakeover(owner) {
      calls.push(["request", owner]);
      return { state: states[index++] ?? states.at(-1) };
    },
    async takeoverStatus(owner) {
      calls.push(["status", owner]);
      return { state: states[index++] ?? states.at(-1) };
    },
  };
}

const fastClock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
};

test("an Allow after waiting asks for a fresh observation (Helper accepts only 3 s old ones)", async () => {
  const fake = authority(["pending", "pending", "granted"]);
  await assert.rejects(
    requireTakeoverGrant(fake, OWNER, fastClock()),
    (error) => error.code === "takeover_allowed_reobserve",
  );
  assert.deepEqual(fake.calls[0], ["request", OWNER]);
  assert.equal(fake.calls.length, 3);
});

test("an existing grant for the same task needs no wait", async () => {
  const fake = authority(["granted"]);
  await requireTakeoverGrant(fake, OWNER, fastClock());
  assert.equal(fake.calls.length, 1);
});

test("deny refuses with takeover_declined", async () => {
  await assert.rejects(
    requireTakeoverGrant(authority(["pending", "denied"]), OWNER, fastClock()),
    (error) => error.code === "takeover_declined",
  );
});

test("no answer within the wait refuses with takeover_pending (bounded)", async () => {
  const fake = authority(["pending"]);
  await assert.rejects(
    requireTakeoverGrant(fake, OWNER, { ...fastClock(), waitMs: 2_000 }),
    (error) => error.code === "takeover_pending",
  );
  assert.ok(fake.calls.length <= 6);
});

test("fails closed without an authority that supports takeover", async () => {
  for (const candidate of [
    undefined,
    {},
    { requestTakeover: async () => ({ state: "granted" }) },
  ]) {
    await assert.rejects(
      requireTakeoverGrant(candidate, OWNER, fastClock()),
      (error) => error.code === "takeover_unavailable",
    );
  }
  await assert.rejects(
    requireTakeoverGrant(authority(["granted"]), { session: "", task: "t" }, fastClock()),
    (error) => error.code === "takeover_unavailable",
  );
});
