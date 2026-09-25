/**
 * 后端迁移状态机的纯函数测试——覆盖 packages/services/specs/backend-migration.md
 * 「State ownership and event order」「Restart-during-migration」两节的每条规则。
 *
 * Run: mise exec -- node --import tsx --test packages/services/test/backendTransitionStateMachine.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { PendingBackendTransition } from "@zcode/shared";
import {
  advanceBackendTransitionPhase,
  appendBackendTransitionRecord,
  assertCanStartBackendTransition,
  beginBackendTransition,
  commitBackendTransition,
  ConcurrentBackendTransitionError,
  failBackendTransition,
  InvalidBackendTransitionPhaseError,
  recoverPendingBackendTransitionOnLoad,
} from "../src/backend-migration/backendTransitionStateMachine.js";

test("assertCanStartBackendTransition allows starting when nothing is pending", () => {
  assert.doesNotThrow(() => assertCanStartBackendTransition(undefined));
});

test("assertCanStartBackendTransition rejects a second concurrent migration outright", () => {
  const pending: PendingBackendTransition = {
    phase: "handoffRunning",
    to: "codex",
    requestedAt: 1000,
  };
  assert.throws(() => assertCanStartBackendTransition(pending), ConcurrentBackendTransitionError);
});

test("beginBackendTransition writes phase=prepared without touching executionBackend", () => {
  const pending = beginBackendTransition({
    to: "codex",
    toProviderId: undefined,
    requestedAt: 1000,
    compacted: false,
  });
  assert.deepEqual(pending, {
    phase: "prepared",
    to: "codex",
    requestedAt: 1000,
    compacted: false,
  });
});

test("advanceBackendTransitionPhase moves forward exactly one step at a time", () => {
  let pending = beginBackendTransition({ to: "codex", requestedAt: 1000, compacted: false });
  pending = advanceBackendTransitionPhase(pending, "destinationCreated", {
    destinationExecutionRef: "codex-thread-1",
  });
  assert.equal(pending.phase, "destinationCreated");
  assert.equal(pending.destinationExecutionRef, "codex-thread-1");

  pending = advanceBackendTransitionPhase(pending, "handoffRunning", {
    handoffTurnId: "turn-1",
  });
  assert.equal(pending.phase, "handoffRunning");
  assert.equal(pending.handoffTurnId, "turn-1");
  // 之前写入的 destinationExecutionRef 不会被后续推进丢掉。
  assert.equal(pending.destinationExecutionRef, "codex-thread-1");

  pending = advanceBackendTransitionPhase(pending, "readyToCommit");
  assert.equal(pending.phase, "readyToCommit");
});

test("advanceBackendTransitionPhase rejects skipping a phase", () => {
  const pending = beginBackendTransition({ to: "codex", requestedAt: 1000, compacted: false });
  assert.throws(
    () => advanceBackendTransitionPhase(pending, "handoffRunning"),
    InvalidBackendTransitionPhaseError,
  );
});

test("advanceBackendTransitionPhase rejects going backward or staying in place", () => {
  let pending = beginBackendTransition({ to: "codex", requestedAt: 1000, compacted: false });
  pending = advanceBackendTransitionPhase(pending, "destinationCreated");
  assert.throws(
    () => advanceBackendTransitionPhase(pending, "prepared"),
    InvalidBackendTransitionPhaseError,
  );
  assert.throws(
    () => advanceBackendTransitionPhase(pending, "destinationCreated"),
    InvalidBackendTransitionPhaseError,
  );
});

test("advanceBackendTransitionPhase rejects being used to reach committed", () => {
  let pending = beginBackendTransition({ to: "codex", requestedAt: 1000, compacted: false });
  pending = advanceBackendTransitionPhase(pending, "destinationCreated");
  pending = advanceBackendTransitionPhase(pending, "handoffRunning");
  pending = advanceBackendTransitionPhase(pending, "readyToCommit");
  assert.throws(
    () => advanceBackendTransitionPhase(pending, "committed"),
    InvalidBackendTransitionPhaseError,
  );
});

test("commitBackendTransition only accepts a pending transition at readyToCommit", () => {
  const pending = beginBackendTransition({ to: "codex", requestedAt: 1000, compacted: false });
  assert.throws(
    () =>
      commitBackendTransition({
        pending,
        from: "zcode",
        committedAt: 2000,
      }),
    InvalidBackendTransitionPhaseError,
  );
});

test("commitBackendTransition writes executionBackend for the first time, clears pending, and records the timeline entry", () => {
  let pending = beginBackendTransition({
    to: "codex",
    requestedAt: 1000,
    compacted: true,
    transcriptRevision: "rev-abc",
  });
  pending = advanceBackendTransitionPhase(pending, "destinationCreated", {
    destinationExecutionRef: "codex-thread-1",
  });
  pending = advanceBackendTransitionPhase(pending, "handoffRunning", { handoffTurnId: "turn-1" });
  pending = advanceBackendTransitionPhase(pending, "readyToCommit");

  const result = commitBackendTransition({
    pending,
    from: "zcode",
    fromProviderId: "account:zai-individual-coding-plan",
    committedAt: 5000,
  });

  assert.equal(result.executionBackend, "codex");
  assert.equal(result.pendingBackendTransition, undefined);
  assert.deepEqual(result.transitionRecord, {
    startedAt: 1000,
    committedAt: 5000,
    from: "zcode",
    to: "codex",
    fromProviderId: "account:zai-individual-coding-plan",
    destinationExecutionRef: "codex-thread-1",
    status: "committed",
    transcriptRevision: "rev-abc",
    transcriptCompacted: true,
    handoffTurnId: "turn-1",
  });
});

test("failBackendTransition never writes executionBackend, only clears pending and records failure", () => {
  const pending = beginBackendTransition({ to: "codex", requestedAt: 1000, compacted: false });
  const result = failBackendTransition({
    pending,
    from: "zcode",
    fromProviderId: "azure-openai",
    failureReason: "handoff_turn_error",
    failedAt: 3000,
  });
  assert.equal(result.pendingBackendTransition, undefined);
  assert.equal(result.transitionRecord.status, "failed");
  assert.equal(result.transitionRecord.failureReason, "handoff_turn_error");
  assert.equal(result.transitionRecord.failedAt, 3000);
  assert.equal(
    "executionBackend" in result,
    false,
    "a failed transition result must not carry an executionBackend field at all",
  );
});

test("appendBackendTransitionRecord builds the timeline in order without mutating the input array", () => {
  const first = failBackendTransition({
    pending: beginBackendTransition({ to: "codex", requestedAt: 1000, compacted: false }),
    from: "zcode",
    failureReason: "handoff_turn_error",
    failedAt: 2000,
  }).transitionRecord;
  const timeline1 = appendBackendTransitionRecord(undefined, first);
  assert.deepEqual(timeline1, [first]);

  const second = commitBackendTransition({
    pending: advanceBackendTransitionPhase(
      advanceBackendTransitionPhase(
        advanceBackendTransitionPhase(
          beginBackendTransition({ to: "codex", requestedAt: 3000, compacted: false }),
          "destinationCreated",
        ),
        "handoffRunning",
      ),
      "readyToCommit",
    ),
    from: "zcode",
    committedAt: 4000,
  }).transitionRecord;
  const timeline2 = appendBackendTransitionRecord(timeline1, second);
  assert.deepEqual(timeline2, [first, second]);
  // 原数组没有被就地修改。
  assert.deepEqual(timeline1, [first]);
});

test("recoverPendingBackendTransitionOnLoad is a no-op when nothing was pending", () => {
  assert.equal(
    recoverPendingBackendTransitionOnLoad({
      pending: undefined,
      currentBackend: "zcode",
      recoveredAt: 9000,
    }),
    null,
  );
});

test("recoverPendingBackendTransitionOnLoad treats every resting phase as a failure, never as ownership evidence", () => {
  for (const phase of [
    "prepared",
    "destinationCreated",
    "handoffRunning",
    "readyToCommit",
  ] as const) {
    const pending: PendingBackendTransition = {
      phase,
      to: "codex",
      requestedAt: 1000,
      destinationExecutionRef: "codex-thread-orphaned",
    };
    const result = recoverPendingBackendTransitionOnLoad({
      pending,
      currentBackend: "zcode",
      currentProviderId: "azure-openai",
      recoveredAt: 9000,
    });
    assert.ok(result, `phase ${phase} must be recovered`);
    assert.equal(result!.pendingBackendTransition, undefined);
    assert.equal(result!.transitionRecord.status, "failed");
    assert.equal(result!.transitionRecord.failureReason, "restart");
    // 归属判断完全来自 currentBackend（调用方传入的 executionBackend），
    // 与 pending.to 或 destinationExecutionRef 是否存在无关——即使一个 Codex thread
    // 已经真实创建出来了，它也绝不会因为「存在」就变成权威后端。
    assert.equal(result!.transitionRecord.from, "zcode");
    assert.equal(result!.transitionRecord.to, "codex");
  }
});

test("the full destination selection travels from begin into the committed and failed records", () => {
  // Amendment 5：composer 在提交后只从记录重新投影，reasoning level 必须原样保留。
  let pending = beginBackendTransition({
    to: "zcode",
    toProviderId: "azure-openai",
    toModelSelection: "azure-openai/gpt-5-mini$low",
    requestedAt: 1000,
    compacted: false,
  });
  assert.equal(pending.toModelSelection, "azure-openai/gpt-5-mini$low");
  pending = advanceBackendTransitionPhase(pending, "destinationCreated", {
    destinationSeedLastRowId: 9,
  });
  pending = advanceBackendTransitionPhase(pending, "handoffRunning");
  pending = advanceBackendTransitionPhase(pending, "readyToCommit");
  const { transitionRecord } = commitBackendTransition({
    pending,
    from: "codex",
    committedAt: 2000,
  });
  assert.equal(transitionRecord.toProviderId, "azure-openai");
  assert.equal(transitionRecord.toModelSelection, "azure-openai/gpt-5-mini$low");

  const failed = failBackendTransition({
    pending,
    from: "codex",
    failureReason: "destination_not_ready",
    failedAt: 2000,
  }).transitionRecord;
  assert.equal(failed.toModelSelection, "azure-openai/gpt-5-mini$low");
});
