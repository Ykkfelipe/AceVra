/**
 * CUA-4: the lease-authority pair must be composed explicitly into the Agent spawn env.
 *
 * Proven live: the desktop-local lease authority is healthy and its registry entry is present at the
 * spawn boundary (same `ServiceCollection`, published ~1.7 s earlier, handle carrying `socketPath` and
 * `token`), yet the runtime reported `leaseClient=false` and `reportActivity` was a no-op, so the CUA-4
 * session bar had nothing to project. The reason is that the authority only published the pair onto the
 * host's own `process.env` for inheritance, while an Agent child env is assembled as
 * `{...sanitizeZCodeRuntimeEnv(process.env), ...spawnEnv}` — and the sanitizer removes every CUA
 * credential by design. Broker credentials reach the runtime only because they are composed explicitly;
 * the lease pair needs the same route.
 *
 * Run: mise exec -- node --import tsx --test packages/services/test/cuaLeaseAuthoritySpawnEnv.test.ts
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ZCODE_CUA_LEASE_AUTHORITY_SOCKET_ENV_KEY,
  ZCODE_CUA_LEASE_AUTHORITY_TOKEN_ENV_KEY,
  sanitizeZCodeRuntimeEnv,
} from "@zcode/shared";
import { buildLeaseAuthoritySpawnEnv } from "../src/node.js";

const SOCKET = "/tmp/authority.sock";
const TOKEN = "lease-token";

test("the lease pair is composed atomically from one live authority handle", () => {
  assert.deepEqual(buildLeaseAuthoritySpawnEnv({ socketPath: SOCKET, token: TOKEN }), {
    [ZCODE_CUA_LEASE_AUTHORITY_SOCKET_ENV_KEY]: SOCKET,
    [ZCODE_CUA_LEASE_AUTHORITY_TOKEN_ENV_KEY]: TOKEN,
  });
});

test("a half pair or no authority emits neither key", () => {
  // Fail closed: a runtime with only one half would open an unauthenticated sideband.
  assert.deepEqual(buildLeaseAuthoritySpawnEnv(undefined), {});
  assert.deepEqual(buildLeaseAuthoritySpawnEnv({}), {});
  assert.deepEqual(buildLeaseAuthoritySpawnEnv({ socketPath: SOCKET }), {});
  assert.deepEqual(buildLeaseAuthoritySpawnEnv({ token: TOKEN }), {});
  assert.deepEqual(buildLeaseAuthoritySpawnEnv({ socketPath: "   ", token: TOKEN }), {});
  assert.deepEqual(buildLeaseAuthoritySpawnEnv({ socketPath: SOCKET, token: "  " }), {});
});

test("the pair is not ambient: the sanitizer still strips it from public child env", () => {
  // Retains the existing security boundary this fix must not weaken: composition is the only route.
  const publicEnv = sanitizeZCodeRuntimeEnv({
    [ZCODE_CUA_LEASE_AUTHORITY_SOCKET_ENV_KEY]: SOCKET,
    [ZCODE_CUA_LEASE_AUTHORITY_TOKEN_ENV_KEY]: TOKEN,
    PATH: "/usr/bin",
  });
  assert.equal(publicEnv[ZCODE_CUA_LEASE_AUTHORITY_SOCKET_ENV_KEY], undefined);
  assert.equal(publicEnv[ZCODE_CUA_LEASE_AUTHORITY_TOKEN_ENV_KEY], undefined);
});

test("the spawn boundary composes the pair from the registry, never from process.env", async () => {
  // node.ts cannot be assembled as a whole in a unit test (same constraint as the other integrated
  // assembly guards), so the wiring invariants are asserted on the source.
  const nodeSource = await readFile(new URL("../src/node.ts", import.meta.url), "utf8");
  const boundary = nodeSource.slice(
    nodeSource.indexOf("const cuaPluginEnabled = isCuaEnabledForContext(context);"),
    nodeSource.indexOf("const telemetryEnv = getCapturedZCodeAgentTelemetryEnv();"),
  );
  assert.ok(boundary.length > 0, "spawn boundary must be locatable");
  assert.match(
    boundary,
    /buildLeaseAuthoritySpawnEnv\(leaseAuthorityServers\.get\(services\)\)/,
    "the lease pair must be composed from the authority registry at the spawn boundary",
  );
  assert.match(
    boundary,
    /if \(cuaPluginEnabled\) \{/,
    "composition stays gated on Computer Use being enabled",
  );
  // Reading either value from the host environment would re-introduce the dead inheritance route and
  // would also widen the credential to whatever env the host happens to carry.
  assert.doesNotMatch(boundary, /process\.env\.ZCODE_CUA_LEASE_AUTHORITY/);
  assert.doesNotMatch(boundary, /process\.env\[ZCODE_CUA_LEASE_AUTHORITY/);
});
