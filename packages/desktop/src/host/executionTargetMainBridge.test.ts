import assert from "node:assert/strict";
import test from "node:test";
import { HostResponseTypes } from "@zcode/shared";
import { createExecutionTargetMainBridge } from "./executionTargetMainBridge.js";

const BASE = { requestId: "agent-req", sessionId: "s1", workspacePath: "/w" } as const;

test("forwards a request to main and resolves with the result matched by bridge request id", async () => {
  const posted: Array<{ type: string; requestId: string; request: { op: string } }> = [];
  const bridge = createExecutionTargetMainBridge({ postToMain: (m) => posted.push(m) });
  const pending = bridge.execute({ ...BASE, op: "list" });
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.type, HostResponseTypes.ExecutionTargetRequest);
  assert.notEqual(posted[0]!.requestId, BASE.requestId);
  bridge.handleResult({ requestId: "unknown", result: { op: "list", ok: true, targets: [] } });
  bridge.handleResult({
    requestId: posted[0]!.requestId,
    result: { op: "list", ok: true, targets: [] },
  });
  assert.deepEqual(await pending, { op: "list", ok: true, targets: [] });
});

test("times out truthfully; a start timeout says the task may have started", async () => {
  const bridge = createExecutionTargetMainBridge({ postToMain: () => {}, timeoutMs: 5 });
  assert.deepEqual(
    await bridge.execute({
      ...BASE,
      op: "start",
      targetId: "dev_node",
      process: { executable: "x", cwd: "/" },
    }),
    { op: "start", ok: false, reason: "timeout", detail: "task_may_have_started" },
  );
  assert.deepEqual(await bridge.execute({ ...BASE, op: "read", taskId: "t-1", after: 0 }), {
    op: "read",
    ok: false,
    reason: "timeout",
  });
});

test("transport failure and dispose settle pending calls as unavailable", async () => {
  const broken = createExecutionTargetMainBridge({
    postToMain: () => {
      throw new Error("no parentPort");
    },
  });
  assert.deepEqual(await broken.execute({ ...BASE, op: "list" }), {
    op: "list",
    ok: false,
    reason: "unavailable",
  });
  const bridge = createExecutionTargetMainBridge({ postToMain: () => {} });
  const pending = bridge.execute({ ...BASE, op: "cancel", taskId: "t-1" });
  bridge.dispose();
  assert.deepEqual(await pending, {
    op: "cancel",
    ok: false,
    reason: "unavailable",
    detail: "host_disposed",
  });
});
