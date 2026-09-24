// Product CUA packaging boundary. Legacy native-addon exports remain fail-closed; the product
// Host is the hardened packaged Helper transport and never falls back to the legacy stable socket.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createProductCuaHelperHost,
  createCuaHelperInstaller,
  loadRealNativeAddon,
  resolvePackagedNativeAddonPath,
  resolveInTreeAddonPath,
  queryProductHelperPermissionStatus,
  waitForProductHelperAdmission,
  roleToKind,
} from "../broker-server.js";

test("legacy native resolution stays fail-closed", async () => {
  for (const call of [
    () => loadRealNativeAddon(),
    () => resolvePackagedNativeAddonPath(),
    () => resolveInTreeAddonPath(),
    () => roleToKind("AXButton"),
  ]) {
    assert.throws(call, /Computer Use is not available in this build/);
  }
  await assert.rejects(
    createCuaHelperInstaller().ensureInstalled(),
    /Computer Use is not available in this build/,
  );
});

test("product host is available and starts fail-closed without an installer", async () => {
  const host = createProductCuaHelperHost();
  assert.equal(host.running, false);
  assert.equal(host.socketPath, null);
  await assert.rejects(() => host.start(), /bundled|packaged|Helper/);
});

test("permission status uses the same admitted Helper transport", async () => {
  const calls = [];
  const report = await queryProductHelperPermissionStatus({
    helperConnected: true,
    async callMethod(method, params, options) {
      calls.push({ method, params, options });
      return {
        available: true,
        accessibility: "denied",
        screen_recording: "granted",
        grant_owner: "dev.acevra.cua-helper",
      };
    },
  });
  assert.equal(report.available, true);
  assert.equal(report.accessibility, "denied");
  assert.equal(report.screen_recording, "granted");
  assert.deepEqual(calls, [
    { method: "permission_status", params: undefined, options: { timeoutMs: 3_000 } },
  ]);
  await assert.rejects(
    () => queryProductHelperPermissionStatus({ helperConnected: false }),
    /Computer Use is not available/,
  );
});

test("product start waits for the admitted Helper transport", async () => {
  let admitted = false;
  const transport = {
    get helperConnected() {
      return admitted;
    },
  };
  setTimeout(() => {
    admitted = true;
  }, 10);
  const startedAt = Date.now();
  await waitForProductHelperAdmission(transport, 500);
  assert.equal(admitted, true);
  assert.ok(Date.now() - startedAt >= 5);
  await assert.rejects(
    () => waitForProductHelperAdmission({ helperConnected: false }, 5),
    /admission timed out/,
  );
});
test("product consumers import only declared package entrypoints", async () => {
  const consumers = [
    "packages/services/src/node.ts",
    "packages/services/src/cua-permission-broker/darwinCuaHelperTransport.ts",
    "packages/desktop/src/main/desktopCuaHelperInstaller.ts",
    "packages/desktop/src/main/desktopRuntimeEnv.ts",
  ];
  for (const relative of consumers) {
    const source = await readFile(new URL(`../../../${relative}`, import.meta.url), "utf8");
    const deepImports = [...source.matchAll(/@zcode\/zcode-cua\/([A-Za-z0-9._/-]+)["';]/g)].map(
      (match) => match[1],
    );
    for (const specifier of deepImports) {
      assert.ok(
        specifier.startsWith("broker/") ||
          specifier === "capability-contract" ||
          specifier === "broker",
        `${relative} imports a non-entrypoint CUA path: ${specifier}`,
      );
    }
  }
});
