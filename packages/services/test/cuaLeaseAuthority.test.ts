import assert from "node:assert/strict";
import test from "node:test";

import { createLeaseAuthority } from "../src/cua-permission-broker/lease-authority/authority.js";

test("lease authority serializes admission, commit, and idempotent stop", async () => {
  const authority = createLeaseAuthority();
  const reservation = await authority.beginAcquire({ session: "s", task: "t" });
  assert.equal(reservation.state, "reserving");
  const active = await authority.commitAcquire(reservation.leaseId, "identifier and anchor");
  assert.equal(active.state, "active");
  assert.deepEqual(await authority.stop(), {
    status: "released",
    record: { ...active, state: "stopped" },
  });
  assert.deepEqual(await authority.stop(), {
    status: "already_stopped",
    record: { ...active, state: "stopped" },
  });
  assert.equal(authority.getStatus()?.state, "stopped");
});

test("late commit cannot resurrect a stopped generation", async () => {
  const authority = createLeaseAuthority();
  const reservation = await authority.beginAcquire({ session: "s", task: "t" });
  await authority.stop();
  await assert.rejects(
    () => authority.commitAcquire(reservation.leaseId, "identifier and anchor"),
    /no longer admissible/,
  );
});
