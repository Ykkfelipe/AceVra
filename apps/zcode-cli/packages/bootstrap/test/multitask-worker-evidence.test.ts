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

test("carried evidence counts only earlier lives of the same run and ask instance", async () => {
  const { carriedMultitaskEvidence, carriedEvidenceForAsk, schemaDeclaresPriorAttempts } =
    await import("../src/app/multitask-worker-evidence.js");
  // 只用到 listEvents：按 run 分桶的事件序列，sequence 即追加序。
  const buckets = new Map<string, { sequence: number; event: never }[]>();
  const journal = {
    appendEvent: (runId: string, event: never) => {
      const list = buckets.get(runId) ?? [];
      list.push({ sequence: list.length, event });
      buckets.set(runId, list);
    },
    listEvents: (runId: string) => buckets.get(runId) ?? [],
  };
  const ev = (world: number, files: string[] = []) => ({
    toolCalls: world,
    worldToolCalls: world,
    mutatingToolCalls: files.length,
    commandCalls: 0,
    filesChanged: files,
  });
  const b = { siteId: "ask#2", ordinal: 1 };
  const other = { siteId: "ask#1", ordinal: 1 };
  const progress = (instance: typeof b, world: number, files?: string[]) =>
    ({ type: "node-progress", instance, turn: 1, toolCalls: world, evidence: ev(world, files) }) as const;
  const started = { type: "run-started", runId: "r", caps: { maxConcurrency: 1 } } as const;
  for (const event of [
    started,
    progress(b, 1),
    progress(b, 2, ["x.ts"]), // life 1: last snapshot = 2
    progress(other, 9), // a different task of the run: never counted for b
    started,
    progress(b, 4, ["y.ts"]), // life 2 (also interrupted): last snapshot = 4
    started,
    progress(b, 7), // current life: this attempt, not carried
  ])
    journal.appendEvent("r", event as never);
  journal.appendEvent("other-run", started as never);
  journal.appendEvent("other-run", progress(b, 50) as never);

  assert.deepEqual(carriedMultitaskEvidence(journal, "r", b), {
    toolCalls: 6,
    worldToolCalls: 6,
    mutatingToolCalls: 2,
    commandCalls: 0,
    filesChanged: ["x.ts", "y.ts"],
  });
  assert.equal(carriedMultitaskEvidence(journal, "fresh-run", b), undefined);
  assert.equal(carriedMultitaskEvidence(journal, "other-run", b), undefined, "single life: nothing earlier");

  // 只有 Multitask worker 的 typed ask 才累计；普通 Workflow / untyped 原样不变。
  const message = { typed: true, schema: { properties: { evidence: { properties: {} } } } };
  assert.equal(carriedEvidenceForAsk({ journal, runId: "r" }, { multitaskWorker: false }, b, message), undefined);
  assert.equal(
    carriedEvidenceForAsk({ journal, runId: "r" }, { multitaskWorker: true }, b, { typed: false }),
    undefined,
  );
  // 修复之前铸的 run：schema 没声明 priorAttempts → 只累计总数，不写新键（否则校验会拒）。
  const legacy = carriedEvidenceForAsk({ journal, runId: "r" }, { multitaskWorker: true }, b, message);
  assert.equal(legacy?.declared, false);
  const stamped = stampMultitaskEvidence({ status: "done", result: "r" }, ev(0), legacy) as {
    evidence: Record<string, unknown>;
  };
  assert.equal(stamped.evidence.worldToolCalls, 6);
  assert.equal("priorAttempts" in stamped.evidence, false);
  assert.equal(
    schemaDeclaresPriorAttempts({
      properties: { evidence: { properties: { priorAttempts: { type: "object" } } } },
    }),
    true,
  );
});
