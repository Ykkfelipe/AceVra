import assert from "node:assert/strict";
import test from "node:test";

import { startLeaseAuthorityServer } from "../src/cua-permission-broker/lease-authority/server.js";
import {
  createLeaseAuthorityClient,
  tokenMatches,
} from "../../zcode-cua/lease-authority-client.js";

test("authenticated lease authority sideband serializes acquire and stop", async (t) => {
  const releasedHelperLeases: string[] = [];
  const server = await startLeaseAuthorityServer("/tmp/acevra-cua-lease-authority-test", {
    releaseHelper: async (record) => {
      releasedHelperLeases.push(record.helperLeaseId ?? "");
    },
  });
  t.after(() => server.close());
  const client = createLeaseAuthorityClient({
    ZCODE_CUA_LEASE_AUTHORITY_SOCKET: server.socketPath,
    ZCODE_CUA_LEASE_AUTHORITY_TOKEN: server.token,
  });
  assert.ok(client);
  const reservation = await client.beginAcquire({ session: "s", task: "t" });
  const active = await client.commitAcquire(
    reservation.leaseId,
    "helper-lease-1",
    'certificate root = H"test"',
  );
  assert.equal(active.state, "active");
  assert.deepEqual(await client.stop(), {
    status: "released",
    record: { ...active, state: "stopped" },
  });
  assert.deepEqual(releasedHelperLeases, ["helper-lease-1"]);
  assert.deepEqual(await client.stop(), {
    status: "already_stopped",
    record: { ...active, state: "stopped" },
  });
});

test("lease authority token comparison is constant-time and exact", () => {
  assert.equal(tokenMatches("same", "same"), true);
  assert.equal(tokenMatches("same", "different"), false);
  assert.equal(tokenMatches(undefined, "same"), false);
});

test("CUA-4 sideband exposes admission and activity reports but never pause or resume", async (t) => {
  const server = await startLeaseAuthorityServer("/tmp/acevra-cua-lease-authority-test-cua4");
  t.after(() => server.close());
  const client = createLeaseAuthorityClient({
    ZCODE_CUA_LEASE_AUTHORITY_SOCKET: server.socketPath,
    ZCODE_CUA_LEASE_AUTHORITY_TOKEN: server.token,
  });
  assert.ok(client);
  assert.deepEqual(await client.admission(), { paused: false });
  await server.authority.pause();
  assert.equal((await client.admission()).paused, true);
  assert.deepEqual(
    await client.reportActivity({
      session: "session-a",
      task: "turn-1",
      callId: "call-1",
      phase: "completed",
      method: "observe",
      at: 5,
      effect: "confirmed",
      observation: { id: "obs-1", width: 10, height: 10 },
    }),
    { accepted: true },
  );
  assert.equal(server.authority.getSession("session-a")?.observation?.id, "obs-1");
  // The model-facing runtime cannot resume (or pause/stop) itself through the sideband.
  await assert.rejects(() => client.request("resume"), /bad_request/u);
  await assert.rejects(() => client.request("pause"), /bad_request/u);
  assert.equal(server.authority.getAdmission().paused, true);
});
