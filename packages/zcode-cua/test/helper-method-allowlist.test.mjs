// The runtime broker allowlist (broker.js BROKER_METHOD_KINDS) and the Helper's own gate
// (native/cua-helper/Observe.swift supportedBrokerMethods) must name exactly the same methods.
// 回归（2026-10-03 实测）：renew_lease 只登记在 JS 侧，Helper 以 not_authorized 拒绝每次心跳，
// 独占租约在 15 s 软窗口静默死亡；两侧任何漂移都会以同样的静默方式出现。
//
// Run: node --test packages/zcode-cua/test/helper-method-allowlist.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const read = (relative) => readFile(new URL(relative, import.meta.url), "utf8");

async function swiftSupportedMethods() {
  const source = await read("../native/cua-helper/Observe.swift");
  const block = source.match(/let supportedBrokerMethods: Set<String> = \[([\s\S]*?)\]/);
  assert.ok(block, "supportedBrokerMethods literal not found");
  return new Set([...block[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]));
}

async function jsBrokerMethods() {
  const source = await read("../broker.js");
  const block = source.match(/const BROKER_METHOD_KINDS = Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert.ok(block, "BROKER_METHOD_KINDS literal not found");
  return new Set([...block[1].matchAll(/^\s*([a-z_]+):/gm)].map((match) => match[1]));
}

async function swiftDispatchedMethods() {
  const source = await read("../native/cua-helper/BrokerServer.swift");
  return new Set(
    [...source.matchAll(/case "([a-z_]+)"(?:, "([a-z_]+)")*:/g)].flatMap((m) =>
      m.slice(1).filter(Boolean),
    ),
  );
}

describe("runtime ↔ Helper broker method allowlist", () => {
  it("names exactly the same methods on both sides", async () => {
    const [swift, js] = await Promise.all([swiftSupportedMethods(), jsBrokerMethods()]);
    assert.deepEqual(
      {
        jsOnly: [...js].filter((m) => !swift.has(m)),
        swiftOnly: [...swift].filter((m) => !js.has(m)),
      },
      { jsOnly: [], swiftOnly: [] },
    );
  });

  it("every allowed method has a Helper dispatch case", async () => {
    const [swift, dispatched] = await Promise.all([
      swiftSupportedMethods(),
      swiftDispatchedMethods(),
    ]);
    assert.deepEqual(
      [...swift].filter((m) => !dispatched.has(m)),
      [],
    );
  });
});
