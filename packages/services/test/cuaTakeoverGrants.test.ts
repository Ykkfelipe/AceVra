// Screen takeover grants owned by the lease authority (zcode-cua/specs/computer-use.md
// "Screen takeover").
//
// Run: TSX_TSCONFIG_PATH=packages/services/tsconfig.json mise exec -- node --import tsx --test packages/services/test/cuaTakeoverGrants.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { createLeaseAuthority } from "../src/cua-permission-broker/lease-authority/authority.js";
import {
  PROTECTED_GRANT_TTL_MS,
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

// Phase 4/5: the granted record is the ProtectedForegroundGrant (identity + bounded expiry).
test("an Allow mints a grant id and a bounded expiry; expiry is reported once as expired", () => {
  let clock = 1_000;
  const grants = createTakeoverGrants(
    () => clock,
    () => "grant-xyz",
  );
  grants.request(OWNER);
  grants.decide("sess_a", "allow");
  const view = grants.grant(OWNER);
  assert.equal(view.state, "granted");
  assert.equal(view.grantId, "grant-xyz");
  assert.equal(view.expiresAt, 1_000 + PROTECTED_GRANT_TTL_MS);
  clock = 1_000 + PROTECTED_GRANT_TTL_MS;
  assert.deepEqual(grants.grant(OWNER), { state: "none", expired: true });
  assert.equal(grants.status(OWNER), "none");
  // Asking again starts a fresh request; the expiry marker does not linger.
  assert.equal(grants.request(OWNER), "pending");
  assert.deepEqual(grants.grant(OWNER), { state: "pending" });
});

test("native-lease lifecycle endings keep the grant; only user reclaim, Stop and Pause end it", async () => {
  const authority = createLeaseAuthority();
  authority.takeover.request(OWNER);
  authority.takeover.decide("sess_a", "allow");
  const grantId = authority.takeover.grant(OWNER).grantId;
  for (const reason of [
    "lease_expired",
    "connection_generation_changed",
    "helper_exited",
    "host_disconnected",
    "stale_geometry",
    "focus_mismatch",
  ]) {
    const lease = await authority.beginAcquire(OWNER);
    await authority.commitAcquire(lease.leaseId, `helper-${reason}`, "req", 2);
    assert.equal(authority.getStatus()?.helperConnectionGeneration, 2);
    await authority.release(lease.leaseId, reason);
    assert.equal(authority.takeover.grant(OWNER).grantId, grantId, `${reason} keeps the grant`);
  }
  const lease = await authority.beginAcquire(OWNER);
  await authority.commitAcquire(lease.leaseId, "helper-last", "req");
  await authority.release(lease.leaseId, "user_takeover");
  assert.equal(authority.takeover.grant(OWNER).state, "none", "user takeover ends the grant");
});

test("Stop revokes the grant first and stays truthful when the Helper is unreachable", async () => {
  const order: string[] = [];
  const authority = createLeaseAuthority({
    releaseHelper: async () => {
      order.push(`release:${authority.takeover.status(OWNER)}`);
      throw new Error("helper is gone");
    },
  });
  authority.takeover.request(OWNER);
  authority.takeover.decide("sess_a", "allow");
  const lease = await authority.beginAcquire(OWNER);
  await authority.commitAcquire(lease.leaseId, "helper-1", "req");
  const stopped = await authority.stop();
  assert.equal(stopped.status, "released");
  assert.equal(stopped.helperRelease, "unreachable");
  assert.equal(authority.getStatus()?.state, "stopped", "the user owns the screen again");
  assert.deepEqual(order, ["release:none"], "the grant was already revoked when release ran");
  // Pause with a dead Helper also completes.
  authority.takeover.request(OWNER);
  authority.takeover.decide("sess_a", "allow");
  const second = await authority.beginAcquire(OWNER);
  await authority.commitAcquire(second.leaseId, "helper-2", "req");
  const paused = await authority.pause();
  assert.equal(paused.status, "paused");
  assert.equal(authority.takeover.status(OWNER), "none");
  await authority.resume();
});

test("authority refusals carry canonical codes", async () => {
  const authority = createLeaseAuthority();
  await authority.beginAcquire(OWNER);
  await assert.rejects(authority.beginAcquire(OWNER), {
    code: "exclusive_busy",
  });
  await assert.rejects(authority.commitAcquire("nope", "h", "r"), {
    code: "lease_not_owned",
  });
  await assert.rejects(authority.release("nope"), { code: "invalid_lease" });
});
