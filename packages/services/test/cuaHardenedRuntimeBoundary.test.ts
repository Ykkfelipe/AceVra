// 集成 CUA runtime 的 fail-closed 回归边界。
//
// Run: mise exec -- node --import tsx --test packages/services/test/cuaHardenedRuntimeBoundary.test.ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const nodeSource = await readFile(new URL("../src/node.ts", import.meta.url), "utf8");

test("hardened session failure has no legacy CUA fallback in the integrated runtime", () => {
  assert.match(nodeSource, /startHardenedCuaHelperSession/);
  assert.doesNotMatch(nodeSource, /probeStableCuaHelperSocket/);
  assert.doesNotMatch(nodeSource, /callBrokerMethod/);
  assert.doesNotMatch(nodeSource, /resolveBrokerSocketPath/);
  assert.doesNotMatch(nodeSource, /launchStandaloneCuaHelperForStatus/);
  assert.match(nodeSource, /hardened CUA session not started/);
  assert.match(nodeSource, /hardened Helper can start/);
});
