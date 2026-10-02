// Screen takeover grants owned by the lease authority (zcode-cua/specs/computer-use.md
// "Screen takeover").
//
// Run: TSX_TSCONFIG_PATH=packages/services/tsconfig.json mise exec -- node --import tsx --test packages/services/test/cuaTakeoverGrants.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { createLeaseAuthority } from "../src/cua-permission-broker/lease-authority/authority.js";
import {
  TAKEOVER_PENDING_TTL_MS,
  createTakeoverGrants,
} from "../src/cua-permission-broker/lease-authority/takeover.js";

const OWNER = { session: "sess_a", task: "turn_1" };

test("request → allow grants only that task; a new task asks again", () => {
  const grants = createTakeoverGrants(() => 1_000);
  assert.equal(grants.request(OWNER), "pending");
  assert.equal(grants.status(OWNER), "pending");
  assert.equal(grants.decide("sess_a", "allow"), true);
  assert.equal(grants.status(OWNER), "granted");
  // 同一任务再次请求不重复询问。
  assert.equal(grants.request(OWNER), "granted");
  assert.equal(grants.status({ session: "sess_a", task: "turn_2" }), "none");
  assert.equal(grants.request({ session: "sess_a", task: "turn_2" }), "pending");
});

test("deny is recorded; asking again in the same task re-asks", () => {
  const grants = createTakeoverGrants(() => 1_000);
  grants.request(OWNER);
  assert.equal(grants.decide("sess_a", "deny"), true);
  assert.equal(grants.status(OWNER), "denied");
  assert.equal(grants.request(OWNER), "pending");
});

test("decide only answers a pending request and never another session's", () => {
  const grants = createTakeoverGrants(() => 1_000);
  assert.equal(grants.decide("sess_a", "allow"), false);
  grants.request(OWNER);
  assert.equal(grants.decide("sess_b", "allow"), false);
  assert.equal(grants.status(OWNER), "pending");
});

test("an unanswered request expires instead of being approvable forever", () => {
  let clock = 0;
  const grants = createTakeoverGrants(() => clock);
  grants.request(OWNER);
  clock = TAKEOVER_PENDING_TTL_MS + 1;
  assert.equal(grants.status(OWNER), "none");
  assert.equal(grants.decide("sess_a", "allow"), false);
});

test("authority revokes the grant on Stop and Pause but not on the agent's own release", async () => {
  const authority = createLeaseAuthority();
  const grant = () => {
    authority.takeover.request(OWNER);
    authority.takeover.decide("sess_a", "allow");
  };

  grant();
  const lease = await authority.beginAcquire(OWNER);
  await authority.commitAcquire(lease.leaseId, "helper-1", "req");
  await authority.release(lease.leaseId, "model_release");
  assert.equal(authority.takeover.status(OWNER), "granted", "own release keeps the task grant");

  const second = await authority.beginAcquire(OWNER);
  await authority.commitAcquire(second.leaseId, "helper-2", "req");
  await authority.release(second.leaseId, "interrupted");
  assert.equal(authority.takeover.status(OWNER), "none", "physical input / Esc revokes");

  grant();
  await authority.beginAcquire(OWNER);
  await authority.stop({ keepTakeover: true });
  assert.equal(
    authority.takeover.status(OWNER),
    "granted",
    "runtime reservation cleanup after a Helper refusal keeps the user's Allow",
  );
  await authority.beginAcquire(OWNER);
  await authority.stop();
  assert.equal(authority.takeover.status(OWNER), "none", "user Stop revokes");

  grant();
  await authority.pause();
  assert.equal(authority.takeover.status(OWNER), "none", "Pause revokes");
  await authority.resume();
});
