/**
 * M2F：CLI 侧执行目标端口（会话围栏、实时选择、失败映射）与 Run-on 选择写入。
 *
 * Run: mise exec -- node --import tsx --test apps/zcode-cli/packages/bootstrap/test/execution-target-port.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { zcodeProtocolMethods } from "@zcode/shared";
import { createProtocolExecutionTargetPort } from "../src/zcode-protocol/execution-target-port.js";
import { updateExecutionTargetPolicy } from "../src/zcode-protocol/execution-target-policy.js";
import { applySubmittedExecutionTarget } from "../src/zcode-protocol-v4/commands/handlers/execution-target-selection.js";

type Sent = { method: string; params: Record<string, unknown> };

function harness(respond: (params: Record<string, unknown>) => unknown) {
  const sent: Sent[] = [];
  const record = {
    app: { sessionId: "session-a" },
    workspace: { workspacePath: "/Users/me/repo" },
  } as Record<string, unknown> & { executionTarget?: { targetId: string; displayName?: string } };
  const context = {
    requestClient: async (method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
      return respond(params);
    },
    logger: { warn: () => undefined },
    appRuntimePreferences: { executionTargetsEnabled: false },
  };
  let open = true;
  const port = createProtocolExecutionTargetPort(context as never, () =>
    open ? (record as never) : undefined,
  );
  return { port, sent, record, context, close: () => (open = false) };
}

const runningTask = {
  id: "task-1",
  targetId: "node-1",
  state: "running",
  result: null,
  lastSequence: 0,
};

test("start 走 interaction/executionTarget，携带会话与本地 workspace；无关任务被会话围栏拒绝", async () => {
  const h = harness((params) =>
    params.op === "start"
      ? { op: "start", ok: true, taskId: "task-1", targetId: "node-1" }
      : { op: "read", ok: true, task: runningTask, events: [] },
  );
  const started = await h.port.startProcess(
    { targetId: "node-1", process: { executable: "ls", cwd: "/home/me" } },
    { turnId: "turn-1", toolCallId: "call-1" },
  );
  assert.deepEqual(started, { ok: true, taskId: "task-1", targetId: "node-1" });
  assert.equal(h.sent[0]!.method, zcodeProtocolMethods.interactionExecutionTarget);
  assert.equal(h.sent[0]!.params.sessionId, "session-a");
  assert.equal(h.sent[0]!.params.workspacePath, "/Users/me/repo");
  assert.equal(h.sent[0]!.params.toolCallId, "call-1");

  assert.equal((await h.port.readTask({ taskId: "task-1", after: 0 })).ok, true);
  assert.deepEqual(await h.port.readTask({ taskId: "other-task", after: 0 }), {
    ok: false,
    reason: "task_not_in_session",
  });
  assert.deepEqual(await h.port.cancelTask({ taskId: "other-task" }), {
    ok: false,
    reason: "task_not_in_session",
  });
  assert.equal(h.sent.length, 2, "围栏拒绝的请求不发往 host");
});

test("host 失败如实映射，绝不回落本机", async () => {
  const offline = harness(() => ({
    op: "start",
    ok: false,
    reason: "target_unavailable",
    detail: "target_offline",
  }));
  assert.deepEqual(
    await offline.port.startProcess({
      targetId: "node-1",
      process: { executable: "ls", cwd: "/" },
    }),
    { ok: false, reason: "target_unavailable", detail: "target_offline" },
  );

  const broken = harness(() => {
    throw new Error("Method not found");
  });
  assert.deepEqual(await broken.port.listTargets(), {
    ok: false,
    reason: "unavailable",
    detail: "host_request_failed",
  });

  const closed = harness(() => ({ op: "list", ok: true, targets: [] }));
  closed.close();
  assert.deepEqual(await closed.port.listTargets(), {
    ok: false,
    reason: "unavailable",
    detail: "session_closed",
  });
});

test("选择实时读自 record；输入命令的 executionTarget：target 写入、automatic 清除、缺省不变", () => {
  const h = harness(() => ({}));
  assert.equal(h.port.selectedTarget(), undefined);
  applySubmittedExecutionTarget(h.record as never, {
    kind: "target",
    targetId: "node-1",
    displayName: "Dell",
  });
  assert.deepEqual(h.port.selectedTarget(), { targetId: "node-1", displayName: "Dell" });
  applySubmittedExecutionTarget(h.record as never, undefined);
  assert.deepEqual(h.port.selectedTarget(), { targetId: "node-1", displayName: "Dell" });
  applySubmittedExecutionTarget(h.record as never, { kind: "automatic" });
  assert.equal(h.port.selectedTarget(), undefined);
});

test("workspace/updateExecutionTargetPolicy 设置工具面门禁", async () => {
  const h = harness(() => ({}));
  const result = await updateExecutionTargetPolicy(h.context as never, {
    workspace: { workspacePath: "/Users/me/repo", workspaceKey: "/Users/me/repo" },
    enabled: true,
  });
  assert.equal(result.enabled, true);
  assert.equal(h.context.appRuntimePreferences.executionTargetsEnabled, true);
  await assert.rejects(updateExecutionTargetPolicy(h.context as never, { enabled: "yes" }));
});

test("computer 走 interaction/executionTarget，返回屏幕尺寸与图片；暂停如实映射", async () => {
  const image = { base64: "AAAA", mimeType: "image/jpeg", width: 1366, height: 768 };
  const h = harness(() => ({ op: "computer", ok: true, screen: { width: 1366, height: 768 }, image }));
  const result = await h.port.computer(
    { targetId: "ssh:dell", action: { kind: "screenshot" } },
    { turnId: "turn-1", toolCallId: "call-2" },
  );
  assert.deepEqual(result, { ok: true, screen: { width: 1366, height: 768 }, image });
  assert.equal(h.sent[0]!.params.op, "computer");
  assert.equal(h.sent[0]!.params.sessionId, "session-a");
  assert.deepEqual(h.sent[0]!.params.action, { kind: "screenshot" });

  const paused = harness(() => ({
    op: "computer",
    ok: false,
    reason: "computer_paused",
    detail: "physical_input",
  }));
  assert.deepEqual(
    await paused.port.computer({ targetId: "ssh:dell", action: { kind: "type", text: "x" } }),
    { ok: false, reason: "computer_paused", detail: "physical_input" },
  );
});
