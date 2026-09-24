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
