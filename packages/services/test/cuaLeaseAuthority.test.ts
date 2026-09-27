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
