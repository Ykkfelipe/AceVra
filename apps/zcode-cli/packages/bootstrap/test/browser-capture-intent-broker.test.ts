/**
 * broker 仅在运行时内部生产者设置 captureIntent 时转发该字段，且结果符合严格的
 * interaction/browserExecute 协议 schema（只接受 "observation" 字面量）。
 *
 * Run: mise exec -- node --import tsx --test apps/zcode-cli/packages/bootstrap/test/browser-capture-intent-broker.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { zcodeBrowserExecuteParamsSchema } from "@zcode/shared";
import { createProtocolBrowserControlBroker } from "../src/zcode-protocol/browser-control-broker.js";

test("broker forwards captureIntent only when an internal producer set it, and the strict schema accepts it", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const context = {
    sessions: new Map([
      ["sess-1", { workspace: { workspacePath: "/tmp/ws" }, deliveryKind: "desktop-continuous" }],
    ]),
    async requestClient(_method: string, params: Record<string, unknown>) {
      sent.push(params);
      return { ok: true };
    },
  };
  const broker = createProtocolBrowserControlBroker(context as never);
  const base = {
    browserId: "iab:x",
    browserGeneration: 1,
    sessionId: "sess-1",
    turnId: "turn-1",
    command: { method: "screenshot" as const },
  };
  await broker.execute(base as never);
  await broker.execute({ ...base, captureIntent: "observation" } as never);

  assert.equal("captureIntent" in sent[0]!, false, "explicit screenshots carry no intent flag");
  assert.equal(sent[1]!.captureIntent, "observation");
  for (const params of sent) {
    assert.equal(zcodeBrowserExecuteParamsSchema.safeParse(params).success, true);
  }
  assert.equal(
    zcodeBrowserExecuteParamsSchema.safeParse({ ...sent[0], captureIntent: "deliverable" }).success,
    false,
    "only the observation literal is a valid intent",
  );
});
