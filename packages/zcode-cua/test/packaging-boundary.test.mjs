// Packaged CUA boundary: the placeholder runtime stays fail-closed and consumers stay on the
// declared public entrypoints.
//
// Run: mise exec -- node scripts/mise-run.mjs node --test packages/zcode-cua/test/packaging-boundary.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createProductCuaHelperHost,
  createCuaHelperInstaller,
  loadRealNativeAddon,
  resolvePackagedNativeAddonPath,
  resolveInTreeAddonPath,
  roleToKind,
} from "../broker-server.js";

test("placeholder native resolution stays fail-closed", async () => {
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

test("the product host factory does not silently report a running Helper", () => {
  const host = createProductCuaHelperHost();
  assert.equal(host.running, false);
  assert.equal(host.socketPath, null);
  assert.equal(host.pluginAuthority, null);
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
