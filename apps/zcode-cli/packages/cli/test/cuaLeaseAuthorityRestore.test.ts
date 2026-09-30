/**
 * CUA-4: the trusted plugin-host restore must also hand the lease-authority pair to the sanctioned
 * node_repl host.
 *
 * Packaged evidence for the failure this reproduces: the CLI captured the lease pair, the public env
 * was stripped, and the trusted node_repl *config* carried both values — yet the node_repl process had
 * neither, so `createLeaseAuthorityClient()` returned undefined, `reportActivity` no-opped, and the
 * Computer Use bar never rendered. Cause: every CLI entry runs `sanitizeZCodeRuntimeEnvInPlace` before
 * dispatching `__zcode-plugin-host`, and that restore branch only put back the broker material.
 *
 * Run: mise exec -- node --import tsx --test apps/zcode-cli/packages/cli/test/cuaLeaseAuthorityRestore.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getCapturedZCodeCuaBrokerCredentials,
  resetCapturedZCodeCuaBrokerCredentialsForTest,
  sanitizeZCodeRuntimeEnvInPlace,
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  ZCODE_CUA_BROKER_TOKEN_ENV_KEY,
  ZCODE_CUA_LEASE_AUTHORITY_SOCKET_ENV_KEY,
  ZCODE_CUA_LEASE_AUTHORITY_TOKEN_ENV_KEY,
  ZCODE_CUA_NODE_REPL_HOST_ENV_KEY,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
} from "@zcode/shared/runtime-env";
import { ZCODE_CUA_OFFICIAL_PLUGIN_ID, ZCODE_PLUGIN_ID_ENV_KEY } from "@zcode/shared/mcp";
import { runPluginHostCommand } from "../src/plugin-host-command.js";

const BROKER_SOCKET = "/tmp/broker.sock";
const BROKER_CAPABILITY = "b".repeat(64);
const LEASE_SOCKET = "/tmp/authority.sock";
const LEASE_TOKEN = "lease-token";

const CREDENTIAL_KEYS = [
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  ZCODE_CUA_BROKER_TOKEN_ENV_KEY,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ZCODE_CUA_LEASE_AUTHORITY_SOCKET_ENV_KEY,
  ZCODE_CUA_LEASE_AUTHORITY_TOKEN_ENV_KEY,
] as const;

/**
 * Env as the Agent spawn composes it: complete broker tuple + complete lease pair.
 *
 * Absent keys are expressed by deleting them afterwards (see `applySpawnEnv`): assigning `undefined`
 * to `process.env.X` stores the literal string "undefined" in this runtime, which a
 * `Boolean(env.X?.trim())` reader — production or test — would see as present.
 */
function spawnEnv(overrides: Record<string, string> = {}) {
  return {
    [ZCODE_CUA_BROKER_SOCKET_ENV_KEY]: BROKER_SOCKET,
    [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: "packaged-cua",
    [ZCODE_CUA_BROKER_TOKEN_ENV_KEY]: BROKER_CAPABILITY,
    [ZCODE_CUA_LEASE_AUTHORITY_SOCKET_ENV_KEY]: LEASE_SOCKET,
    [ZCODE_CUA_LEASE_AUTHORITY_TOKEN_ENV_KEY]: LEASE_TOKEN,
    [ZCODE_CUA_NODE_REPL_HOST_ENV_KEY]: "1",
    [ZCODE_PLUGIN_ID_ENV_KEY]: ZCODE_CUA_OFFICIAL_PLUGIN_ID,
    PATH: "/usr/bin",
    ...overrides,
  };
}

/** Apply a spawn env and remove the named keys, so "absent" really means absent. */
function applySpawnEnv(absentKeys: readonly string[] = []): void {
  Object.assign(process.env, spawnEnv());
  for (const key of absentKeys) delete process.env[key];
}

const stubContext = { stderr: { write: () => true } } as never;

/**
 * Write a fixture that behaves like the sanctioned node_repl host: it records what the restore window
 * exposes and whether a real lease client can be constructed from it.
 */
async function writeHostedFixture(root: string): Promise<string> {
  const clientModule = new URL(
    "../../../../../packages/zcode-cua/lease-authority-client.js",
    import.meta.url,
  ).href;
  const reportPath = join(root, "report.json");
  const fixturePath = join(root, "node-repl-fixture.mjs");
  await writeFile(
    fixturePath,
    [
      `import { writeFileSync } from "node:fs";`,
      `import { createLeaseAuthorityClient } from ${JSON.stringify(clientModule)};`,
      `export async function main() {`,
      `  const leaseClient = createLeaseAuthorityClient(process.env);`,
      `  writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({`,
      `    brokerSocket: Boolean(process.env.ZCODE_CUA_PERMISSION_BROKER_SOCKET?.trim()),`,
      `    brokerCapability: Boolean(process.env.ZCODE_CUA_PERMISSION_BROKER_TOKEN?.trim()),`,
      `    leaseSocket: Boolean(process.env.ZCODE_CUA_LEASE_AUTHORITY_SOCKET?.trim()),`,
      `    leaseToken: Boolean(process.env.ZCODE_CUA_LEASE_AUTHORITY_TOKEN?.trim()),`,
      `    leaseClient: Boolean(leaseClient),`,
      `  }, null, 2));`,
      `}`,
    ].join("\n"),
  );
  return fixturePath;
}

test("the trusted plugin-host restore hands the lease pair to the sanctioned node_repl host", async () => {
  const root = await mkdtemp(join(tmpdir(), "cua-lease-restore-"));
  const saved = Object.fromEntries(CREDENTIAL_KEYS.map((key) => [key, process.env[key]]));
  const savedMarker = process.env[ZCODE_CUA_NODE_REPL_HOST_ENV_KEY];
  const savedPluginId = process.env[ZCODE_PLUGIN_ID_ENV_KEY];
  try {
    // 1-3. spawn env → CLI global sanitization: capture privately, strip ambient.
    applySpawnEnv();
    sanitizeZCodeRuntimeEnvInPlace(process.env);
    const captured = getCapturedZCodeCuaBrokerCredentials();
    assert.equal(captured.leaseAuthoritySocket, LEASE_SOCKET, "capture retains the lease socket");
    assert.equal(captured.leaseAuthorityToken, LEASE_TOKEN, "capture retains the lease token");
    for (const key of CREDENTIAL_KEYS) {
      assert.equal(process.env[key], undefined, `${key} must be stripped from the ambient env`);
    }

    // 4-6. trusted dispatch → restore → node_repl bootstrap can construct a lease client.
    const fixturePath = await writeHostedFixture(root);
    const exitCode = await runPluginHostCommand(stubContext, [fixturePath]);
    assert.equal(exitCode, 0, "the sanctioned host runs");

    const report = JSON.parse(await readFile(join(root, "report.json"), "utf8"));
    assert.equal(report.brokerSocket, true);
    assert.equal(report.brokerCapability, true);
    assert.equal(report.leaseSocket, true, "the lease socket reaches node_repl");
    assert.equal(report.leaseToken, true, "the lease token reaches node_repl");
    assert.equal(report.leaseClient, true, "node_repl can construct its lease client");

    // Model-readable safety: the restore is scoped to the bootstrap window. Cells run later, in
    // workers that inherit the current parent env, so the credentials must be gone once main() returns.
    for (const key of CREDENTIAL_KEYS) {
      if (saved[key] === undefined) {
        assert.equal(
          process.env[key],
          undefined,
          `${key} must be retracted after the host returns`,
        );
      }
    }
    assert.equal(process.env[ZCODE_CUA_LEASE_AUTHORITY_SOCKET_ENV_KEY], undefined);
    assert.equal(process.env[ZCODE_CUA_LEASE_AUTHORITY_TOKEN_ENV_KEY], undefined);
  } finally {
    for (const key of CREDENTIAL_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    if (savedMarker === undefined) delete process.env[ZCODE_CUA_NODE_REPL_HOST_ENV_KEY];
    else process.env[ZCODE_CUA_NODE_REPL_HOST_ENV_KEY] = savedMarker;
    if (savedPluginId === undefined) delete process.env[ZCODE_PLUGIN_ID_ENV_KEY];
    else process.env[ZCODE_PLUGIN_ID_ENV_KEY] = savedPluginId;
    resetCapturedZCodeCuaBrokerCredentialsForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test("a half lease pair is never restored", async () => {
  const root = await mkdtemp(join(tmpdir(), "cua-lease-half-"));
  const savedSocket = process.env[ZCODE_CUA_LEASE_AUTHORITY_SOCKET_ENV_KEY];
  const savedToken = process.env[ZCODE_CUA_LEASE_AUTHORITY_TOKEN_ENV_KEY];
  try {
    for (const missingKey of [
      ZCODE_CUA_LEASE_AUTHORITY_TOKEN_ENV_KEY,
      ZCODE_CUA_LEASE_AUTHORITY_SOCKET_ENV_KEY,
    ]) {
      applySpawnEnv([missingKey]);
      sanitizeZCodeRuntimeEnvInPlace(process.env);
      assert.equal(
        getCapturedZCodeCuaBrokerCredentials().leaseAuthorityToken,
        missingKey === ZCODE_CUA_LEASE_AUTHORITY_TOKEN_ENV_KEY ? undefined : LEASE_TOKEN,
        "capture mirrors exactly what the spawn env carried",
      );
      const fixturePath = await writeHostedFixture(root);
      const exitCode = await runPluginHostCommand(stubContext, [fixturePath]);
      assert.equal(exitCode, 0);
      const report = JSON.parse(await readFile(join(root, "report.json"), "utf8"));
      assert.equal(
        report.leaseSocket,
        false,
        `half pair (missing ${missingKey}) restores no socket`,
      );
      assert.equal(report.leaseToken, false, `half pair (missing ${missingKey}) restores no token`);
      assert.equal(report.leaseClient, false, "no half-configured lease client");
      assert.equal(process.env[ZCODE_CUA_LEASE_AUTHORITY_SOCKET_ENV_KEY], undefined);
      assert.equal(process.env[ZCODE_CUA_LEASE_AUTHORITY_TOKEN_ENV_KEY], undefined);
    }
  } finally {
    if (savedSocket === undefined) delete process.env[ZCODE_CUA_LEASE_AUTHORITY_SOCKET_ENV_KEY];
    else process.env[ZCODE_CUA_LEASE_AUTHORITY_SOCKET_ENV_KEY] = savedSocket;
    if (savedToken === undefined) delete process.env[ZCODE_CUA_LEASE_AUTHORITY_TOKEN_ENV_KEY];
    else process.env[ZCODE_CUA_LEASE_AUTHORITY_TOKEN_ENV_KEY] = savedToken;
    resetCapturedZCodeCuaBrokerCredentialsForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test("an untrusted host never receives the lease pair", async () => {
  const root = await mkdtemp(join(tmpdir(), "cua-lease-untrusted-"));
  const saved = Object.fromEntries(CREDENTIAL_KEYS.map((key) => [key, process.env[key]]));
  const savedMarker = process.env[ZCODE_CUA_NODE_REPL_HOST_ENV_KEY];
  const savedPluginId = process.env[ZCODE_PLUGIN_ID_ENV_KEY];
  try {
    // Same-name node_repl replacement: marker or official plugin provenance missing.
    applySpawnEnv();
    process.env[ZCODE_PLUGIN_ID_ENV_KEY] = "third-party";
    sanitizeZCodeRuntimeEnvInPlace(process.env);
    const captured = getCapturedZCodeCuaBrokerCredentials();
    assert.equal(
      captured.leaseAuthorityToken,
      LEASE_TOKEN,
      "capture still holds the pair privately",
    );
    const fixturePath = await writeHostedFixture(root);
    const exitCode = await runPluginHostCommand(stubContext, [fixturePath]);
    assert.equal(exitCode, 1, "an untrusted host is refused before the module is loaded");
    await assert.rejects(readFile(join(root, "report.json"), "utf8"), /ENOENT/);
    assert.equal(process.env[ZCODE_CUA_LEASE_AUTHORITY_SOCKET_ENV_KEY], undefined);
    assert.equal(process.env[ZCODE_CUA_LEASE_AUTHORITY_TOKEN_ENV_KEY], undefined);
  } finally {
    for (const key of CREDENTIAL_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    if (savedMarker === undefined) delete process.env[ZCODE_CUA_NODE_REPL_HOST_ENV_KEY];
    else process.env[ZCODE_CUA_NODE_REPL_HOST_ENV_KEY] = savedMarker;
    if (savedPluginId === undefined) delete process.env[ZCODE_PLUGIN_ID_ENV_KEY];
    else process.env[ZCODE_PLUGIN_ID_ENV_KEY] = savedPluginId;
    resetCapturedZCodeCuaBrokerCredentialsForTest();
    await rm(root, { recursive: true, force: true });
  }
});
