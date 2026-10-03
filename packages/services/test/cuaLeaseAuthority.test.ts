import assert from "node:assert/strict";
import test from "node:test";

import { createLeaseAuthority } from "../src/cua-permission-broker/lease-authority/authority.js";

test("lease authority serializes admission, commit, and idempotent stop", async () => {
  const authority = createLeaseAuthority();
  const reservation = await authority.beginAcquire({ session: "s", task: "t" });
  assert.equal(reservation.state, "reserving");
  const active = await authority.commitAcquire(
    reservation.leaseId,
    "helper-lease-1",
    "identifier and anchor",
  );
  assert.equal(active.state, "active");
  assert.deepEqual(await authority.stop(), {
    status: "released",
    record: { ...active, state: "stopped" },
  });
  assert.deepEqual(await authority.stop(), {
    status: "already_stopped",
    record: { ...active, state: "stopped" },
  });
});

test("stop releases the observed Helper lease before publishing terminal state", async () => {
  const events: string[] = [];
  const authority = createLeaseAuthority({
    releaseHelper: async (record) => {
      events.push(`release:${record.helperLeaseId}`);
    },
  });
  const reservation = await authority.beginAcquire({ session: "s", task: "t" });
  const active = await authority.commitAcquire(
    reservation.leaseId,
    "helper-lease-1",
    "identifier and anchor",
  );
  const stopped = await authority.stop();
  assert.deepEqual(events, ["release:helper-lease-1"]);
  assert.equal(stopped.status, "released");
  assert.equal(authority.getStatus()?.state, "stopped");
  assert.equal(active.state, "active");
});

test("late commit cannot resurrect a stopped generation", async () => {
  const authority = createLeaseAuthority();
  const reservation = await authority.beginAcquire({ session: "s", task: "t" });
  await authority.stop();
  await assert.rejects(
    () => authority.commitAcquire(reservation.leaseId, "helper-lease-1", "identifier and anchor"),
    /no longer admissible/,
  );
});

test("CUA-4 pause closes admission, releases the active lease, and resume only reopens admission", async () => {
  const released: string[] = [];
  const authority = createLeaseAuthority({
    now: () => 1_000,
    releaseHelper: async (record) => {
      released.push(String(record.helperLeaseId));
    },
  });
  const reservation = await authority.beginAcquire({ session: "s", task: "t" });
  await authority.commitAcquire(reservation.leaseId, "helper-lease-1", "requirement");
  assert.deepEqual(await authority.pause(), { status: "paused", released: true });
  assert.deepEqual(released, ["helper-lease-1"]);
  assert.equal(authority.getStatus()?.state, "stopped");
  assert.deepEqual(authority.getAdmission(), { paused: true, pausedAt: 1_000 });
  assert.deepEqual(authority.getLastTermination(), {
    leaseId: reservation.leaseId,
    reason: "paused",
    at: 1_000,
  });
  await assert.rejects(
    () => authority.beginAcquire({ session: "s", task: "t2" }),
    (error: Error & { code?: string }) => error.code === "paused",
  );
  assert.deepEqual(await authority.pause(), { status: "already_paused", released: false });
  assert.deepEqual(await authority.resume(), { status: "resumed" });
  assert.deepEqual(authority.getAdmission(), { paused: false });
  assert.deepEqual(await authority.resume(), { status: "not_paused" });
  // Resume never re-acquires: the next foreground work goes through normal admission.
  assert.equal(authority.getStatus()?.state, "stopped");
  const next = await authority.beginAcquire({ session: "s", task: "t3" });
  assert.equal(next.state, "reserving");
});

test("CUA-4 records the release reason so a physical-input yield is distinguishable", async () => {
  const authority = createLeaseAuthority({ now: () => 7 });
  const reservation = await authority.beginAcquire({ session: "s", task: "t" });
  await authority.commitAcquire(reservation.leaseId, "helper-lease-1", "requirement");
  await authority.release(reservation.leaseId, "interrupted");
  assert.deepEqual(authority.getLastTermination(), {
    leaseId: reservation.leaseId,
    reason: "interrupted",
    at: 7,
  });
  const second = await authority.beginAcquire({ session: "s", task: "t" });
  await authority.commitAcquire(second.leaseId, "helper-lease-2", "requirement");
  await authority.stop();
  assert.equal(authority.getLastTermination()?.reason, "stopped");
});

test("CUA-4 activity is fenced per session, bounded, and ordered", () => {
  const authority = createLeaseAuthority();
  const base = { task: "turn", route: "none" } as const;
  authority.reportActivity({
    ...base,
    session: "a",
    callId: "c1",
    phase: "started",
    method: "observe",
    at: 10,
  });
  authority.reportActivity({
    ...base,
    session: "a",
    callId: "c1",
    phase: "completed",
    method: "observe",
    at: 20,
    effect: "confirmed",
    target: { pid: 5, app: "Notes", window: "Shopping list" },
    observation: {
      id: "obs-1",
      width: 800,
      height: 600,
      blank: false,
      framePath: "/frames/obs-1.png",
    },
  });
  // A late started report for the same call cannot erase its completion.
  authority.reportActivity({
    ...base,
    session: "a",
    callId: "c1",
    phase: "started",
    method: "observe",
    at: 11,
  });
  const a = authority.getSession("a");
  assert.equal(a?.activity?.phase, "completed");
  assert.equal(a?.activity?.startedAt, 10);
  assert.equal(a?.activity?.completedAt, 20);
  assert.deepEqual(a?.observation, {
    id: "obs-1",
    capturedAt: 20,
    width: 800,
    height: 600,
    blank: false,
    target: { pid: 5, app: "Notes", window: "Shopping list" },
    framePath: "/frames/obs-1.png",
  });
  // An older call cannot overwrite a newer one; a new action keeps the last observation.
  authority.reportActivity({
    ...base,
    session: "a",
    callId: "c0",
    phase: "completed",
    method: "press",
    at: 15,
  });
  assert.equal(authority.getSession("a")?.activity?.callId, "c1");
  authority.reportActivity({
    ...base,
    session: "a",
    callId: "c2",
    phase: "started",
    method: "press",
    at: 30,
  });
  assert.equal(authority.getSession("a")?.activity?.method, "press");
  assert.equal(authority.getSession("a")?.observation?.id, "obs-1");
  // Another session sees nothing of session a.
  assert.equal(authority.getSession("b"), undefined);
  for (let index = 0; index < 20; index += 1) {
    authority.reportActivity({
      ...base,
      session: `s${index}`,
      callId: "x",
      phase: "started",
      method: "observe",
      at: 40 + index,
    });
  }
  assert.equal(authority.getSession("a"), undefined, "oldest sessions are evicted at the bound");
  // Malformed reports are ignored rather than stored.
  authority.reportActivity({
    ...base,
    session: "",
    callId: "x",
    phase: "started",
    method: "observe",
    at: 1,
  });
  authority.reportActivity({
    ...base,
    session: "z",
    callId: "x",
    phase: "bogus" as "started",
    method: "observe",
    at: 1,
  });
  assert.equal(authority.getSession("z"), undefined);
});

// 回归（实测 2026-10-02）：内核回收让 agent 绑定消失，release 永远不会发生，authority 的
// active 记录与辉光常驻。规则：运行时心跳经活动 sideband（method "renew_lease"）续期；停跳
// 超过窗口即惰性过期并撤销授权（specs/computer-use.md "The authority lease record fails open
// with the same heartbeat"）。
function keepaliveReport(authority: {
  getStatus(): { leaseId: string; ownerSession: string } | undefined;
}) {
  const record = authority.getStatus();
  return {
    session: record!.ownerSession,
    callId: record!.leaseId,
    method: "renew_lease",
    phase: "completed" as const,
    at: 0,
  };
}

test("active lease record fails open when runtime keepalives stop", async () => {
  let clock = 1_000_000;
  const authority = createLeaseAuthority({ now: () => clock });
  const reservation = await authority.beginAcquire({ session: "s", task: "t" });
  const active = await authority.commitAcquire(reservation.leaseId, "helper-lease-1", "req");
  assert.equal(active.keepaliveAt, clock);

  clock += 10_000;
  authority.reportActivity(keepaliveReport(authority));
  clock += 10_000;
  assert.equal(authority.getStatus()?.state, "active", "keepalive within the window keeps it");

  clock += 31_000;
  assert.equal(authority.getStatus()?.state, "released");
  assert.equal(authority.getLastTermination()?.reason, "runtime_heartbeat_lost");
  assert.equal(
    authority.takeover.grant({ session: "s", task: "t" }).state,
    "none",
    "stale-heartbeat expiry revokes the takeover grant like a user reclaim",
  );
});

test("a stale active record no longer blocks the next acquire", async () => {
  let clock = 1_000_000;
  const authority = createLeaseAuthority({ now: () => clock });
  const first = await authority.beginAcquire({ session: "s", task: "t1" });
  await authority.commitAcquire(first.leaseId, "helper-lease-1", "req");
  clock += 31_000;
  const second = await authority.beginAcquire({ session: "s", task: "t2" });
  assert.equal(second.state, "reserving");
});

test("keepalive after expiry never resurrects the record", async () => {
  let clock = 1_000_000;
  const authority = createLeaseAuthority({ now: () => clock });
  const reservation = await authority.beginAcquire({ session: "s", task: "t" });
  await authority.commitAcquire(reservation.leaseId, "helper-lease-1", "req");
  clock += 31_000;
  assert.equal(authority.getStatus()?.state, "released");
  authority.reportActivity(keepaliveReport(authority));
  assert.equal(authority.getStatus()?.state, "released");
});

test("renew_lease reports renew the lease without entering the activity projection", async () => {
  let clock = 1_000_000;
  const authority = createLeaseAuthority({ now: () => clock });
  const reservation = await authority.beginAcquire({ session: "s", task: "t" });
  await authority.commitAcquire(reservation.leaseId, "helper-lease-1", "req");
  authority.reportActivity(keepaliveReport(authority));
  assert.equal(authority.getSession("s"), undefined, "heartbeat is liveness, not session activity");
});

test("a renew_lease report from another lease id does not refresh the record", async () => {
  let clock = 1_000_000;
  const authority = createLeaseAuthority({ now: () => clock });
  const reservation = await authority.beginAcquire({ session: "s", task: "t" });
  await authority.commitAcquire(reservation.leaseId, "helper-lease-1", "req");
  clock += 10_000;
  authority.reportActivity({
    session: "s",
    callId: "not-this-lease",
    method: "renew_lease",
    phase: "completed",
    at: 0,
  });
  clock += 21_000; // 31s since commit; the forged renew_lease must not have refreshed it
  assert.equal(authority.getStatus()?.state, "released");
});

// 回归（2026-10-03 实测 split-brain）：UI 29 s 已显示释放，Helper 原生租约 50 s 仍存活。
// 过期结束记录时必须经 Stop 同一路径结束 Helper 租约，且只发一次。
test("keepalive expiry also ends the Helper lease, exactly once", async () => {
  let clock = 1_000_000;
  const released: Array<{ helperLeaseId?: string; ownerSession: string; ownerTask: string }> = [];
  const authority = createLeaseAuthority({
    now: () => clock,
    releaseHelper: async (record) => {
      released.push({
        helperLeaseId: record.helperLeaseId,
        ownerSession: record.ownerSession,
        ownerTask: record.ownerTask,
      });
    },
  });
  const reservation = await authority.beginAcquire({ session: "s", task: "t" });
  await authority.commitAcquire(reservation.leaseId, "helper-lease-1", "req");
  clock += 31_000;
  assert.equal(authority.getStatus()?.state, "released");
  assert.equal(authority.getStatus()?.state, "released");
  await Promise.resolve();
  assert.deepEqual(released, [
    { helperLeaseId: "helper-lease-1", ownerSession: "s", ownerTask: "t" },
  ]);
});
