import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import {
  isMultitaskWorkerPersona,
  stampMultitaskEvidence,
} from "../src/app/multitask-worker-evidence.js";
import { createActorToolActivity } from "../src/app/workflow-driver-tool-activity.js";

/** 只实现 subscribeEvents 的最小 runtime：测试直接往订阅者推会话事件。 */
function fakeRuntime() {
  let listener: ((event: SessionEvent) => void) | undefined;
  const runtime = {
    subscribeEvents: (handlers: { onSessionEvent: (event: SessionEvent) => void }) => {
      listener = handlers.onSessionEvent;
      return () => (listener = undefined);
    },
  } as unknown as AgentRuntime;
  let seq = 0;
  const call = (
    toolName: string,
    input: Record<string, unknown>,
    capability: { readOnly?: boolean; sideEffectScope?: string },
  ) => {
    const toolCallId = `call-${++seq}`;
    listener?.({
      sessionId: "s",
      type: SessionEventType.ToolCallScheduled,
      payload: { toolCallId, toolName, input },
    } as unknown as SessionEvent);
    listener?.({
      sessionId: "s",
      type: SessionEventType.ToolCallStarted,
      payload: { toolCallId, toolName, startedAt: new Date(), ...capability },
    } as unknown as SessionEvent);
  };
  return { runtime, call };
}

test("tool activity counts objective evidence per ask and resets between asks", () => {
  let mutatingReports = 0;
  let started = 0;
  const activity = createActorToolActivity({
    onMutating: () => mutatingReports++,
    // 每次工具开跑都通知：Multitask worker 据此报进行中的进度（卡上的当前动作不再停在旧值）。
    onToolStarted: () => started++,
  });
  const { runtime, call } = fakeRuntime();
  activity.observe(runtime, "s" as never);
  call("Read", { file_path: "/w/cart.mjs" }, { readOnly: true, sideEffectScope: "none" });
  call("Edit", { file_path: "/w/cart.mjs" }, { readOnly: false, sideEffectScope: "workspace" });
  call("Edit", { file_path: "/w/cart.mjs" }, { readOnly: false, sideEffectScope: "workspace" });
  call("Write", { file_path: "/w/new.mjs" }, { readOnly: false, sideEffectScope: "workspace" });
  call("Bash", { command: "node --test" }, { readOnly: false, sideEffectScope: "workspace" });
  call("submit_result", { result: {} }, { readOnly: false, sideEffectScope: "session" });
  assert.deepEqual(activity.counts(), {
    toolCalls: 6,
    worldToolCalls: 5,
    mutatingToolCalls: 4,
    commandCalls: 1,
    filesChanged: ["/w/cart.mjs", "/w/new.mjs"],
  });
  assert.equal(mutatingReports, 1, "cache-closing signal still fires once per ask");
  assert.equal(started, 6);
  assert.deepEqual(activity.lastTool(), { name: "submit_result" });
  activity.reset();
  assert.deepEqual(activity.counts(), {
    toolCalls: 0,
    worldToolCalls: 0,
    mutatingToolCalls: 0,
    commandCalls: 0,
    filesChanged: [],
  });
});

test("only Multitask workers are stamped, and model-authored evidence is overwritten", () => {
  assert.equal(isMultitaskWorkerPersona({ system: "normal Workflow actor" }), false);
  assert.equal(isMultitaskWorkerPersona({ worker: { profile: "p", access: "read" } }), true);
  const counts = {
    toolCalls: 3,
    worldToolCalls: 2,
    mutatingToolCalls: 1,
    commandCalls: 1,
    filesChanged: ["a.ts"],
  };
  const stamped = stampMultitaskEvidence(
    {
      status: "done",
      result: "edited",
      evidence: { toolCalls: 99, worldToolCalls: 99, mutatingToolCalls: 99, commandCalls: 99, filesChanged: ["x"] },
    },
    counts,
  );
  assert.deepEqual(stamped, { status: "done", result: "edited", evidence: counts });
  // 非对象载荷原样交给引擎，由 schema 校验与 repair 通道照常拒绝。
  assert.equal(stampMultitaskEvidence("done", counts), "done");
});
