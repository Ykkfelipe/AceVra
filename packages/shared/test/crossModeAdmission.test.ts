/**
 * M2 准入流程单测：确认快照 → 重新校验 → 经执行端口派发 → 状态记录（含进行中可见性）→
 * rejected 重试语义 → 返回摘要录入。执行端口使用确定性假实现，存储使用内存 store。
 *
 * Run: mise exec -- node --import tsx --test packages/shared/test/crossModeAdmission.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  HandoffFlowError,
  beginHandoffPreview,
  confirmHandoffPreview,
  createHandoffAdmissionService,
  createHandoffPacket,
  createHandoffReturnSummary,
  createInMemoryHandoffAdmissionStore,
  serializeHandoffPacket,
  type CreateHandoffPacketInput,
  type HandoffConfirmation,
  type HandoffExecutionOutcome,
  type HandoffExecutionPort,
  type HandoffObjectRef,
} from "../src/index.js";

function baseInput(): CreateHandoffPacketInput {
  return {
    sourceMode: "bot",
    destinationMode: "coding",
    objective: "Build the first Personal Bot settings surface",
    returnPolicy: "summary-and-artifacts",
    sourceRefs: [{ kind: "conversation", id: "bot-conv-1" }],
  };
}

function confirmationFor(): HandoffConfirmation {
  const draft = createHandoffPacket(baseInput());
  const result = confirmHandoffPreview(beginHandoffPreview(draft, 1000), 1500);
  if (!result.ok) {
    throw new Error("fixture packet should be confirmable");
  }
  return result.session.confirmation;
}

function acceptedPort(ref: HandoffObjectRef): HandoffExecutionPort {
  return { execute: async () => ({ status: "accepted", externalRef: ref }) };
}

function flowError(code: string) {
  return (error: unknown): boolean => error instanceof HandoffFlowError && error.code === code;
}

test("admit dispatches through the port and records an accepted handoff", async () => {
  const store = createInMemoryHandoffAdmissionStore();
  let clock = 5000;
  const service = createHandoffAdmissionService({
    execution: acceptedPort({ kind: "coding-session", id: "sess-9" }),
    store,
    now: () => (clock += 100),
  });

  const confirmation = confirmationFor();
  const record = await service.admit(confirmation);
  assert.equal(record.status, "accepted");
  assert.equal(record.attempts, 1);
  assert.deepEqual(record.externalRef, { kind: "coding-session", id: "sess-9" });
  assert.ok(record.resolvedAt !== null);
  assert.equal(record.objective, "Build the first Personal Bot settings surface");
  assert.equal(record.sourceMode, "bot");
  assert.equal(record.destinationMode, "coding");
  assert.equal(record.returnSummary, null);

  const stored = await store.read(confirmation.handoffId);
  assert.deepEqual(stored, record);
  assert.equal((await service.list()).length, 1);
});

test("the dispatched state is observable while the executor is still working", async () => {
  let resolveOutcome: (outcome: HandoffExecutionOutcome) => void = () => {};
  const gate = new Promise<HandoffExecutionOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const service = createHandoffAdmissionService({
    execution: { execute: () => gate },
  });

  const confirmation = confirmationFor();
  const promise = service.admit(confirmation);
  await new Promise((resolve) => setImmediate(resolve));

  const inFlight = await service.get(confirmation.handoffId);
  assert.equal(inFlight?.status, "dispatched");
  assert.equal(inFlight?.resolvedAt, null);
  assert.equal(inFlight?.externalRef, null);

  resolveOutcome({ status: "accepted", externalRef: { kind: "coding-session", id: "sess-10" } });
  const done = await promise;
  assert.equal(done.status, "accepted");
  assert.deepEqual(done.externalRef, { kind: "coding-session", id: "sess-10" });
});

test("rejected handoffs can be retried; other states cannot be re-admitted", async () => {
  let phase: "reject" | "accept" = "reject";
  const port: HandoffExecutionPort = {
    execute: async () =>
      phase === "reject"
        ? { status: "rejected", reason: "destination unavailable" }
        : { status: "accepted", externalRef: { kind: "coding-session", id: "sess-11" } },
  };
  const service = createHandoffAdmissionService({ execution: port });
  const confirmation = confirmationFor();

  const first = await service.admit(confirmation);
  assert.equal(first.status, "rejected");
  assert.equal(first.rejectionReason, "destination unavailable");
  assert.equal(first.attempts, 1);

  phase = "accept";
  const second = await service.admit(confirmation);
  assert.equal(second.status, "accepted");
  assert.equal(second.attempts, 2);
  assert.equal(second.rejectionReason, null);
  assert.equal((await service.list()).length, 1);

  await assert.rejects(
    () => service.admit(confirmation),
    flowError("handoff_flow_already_admitted"),
  );
});

test("invalid confirmation snapshots are rejected with typed flow errors", async () => {
  const service = createHandoffAdmissionService({
    execution: acceptedPort({ kind: "coding-session", id: "sess-13" }),
  });
  const confirmation = confirmationFor();

  await assert.rejects(
    () => service.admit({ ...confirmation, packetJson: "{}" }),
    flowError("handoff_flow_invalid_confirmation"),
  );
  await assert.rejects(
    () => service.admit({ ...confirmation, handoffId: "other-id" }),
    flowError("handoff_flow_invalid_confirmation"),
  );

  const blockedDraft = createHandoffPacket({
    sourceMode: "bot",
    destinationMode: "coding",
    objective: "blocked objective",
    returnPolicy: "none",
  });
  const blockedConfirmation: HandoffConfirmation = {
    handoffId: blockedDraft.handoffId,
    packetJson: serializeHandoffPacket(blockedDraft),
    confirmedAt: 1,
    warnings: [],
  };
  await assert.rejects(
    () => service.admit(blockedConfirmation),
    (error: unknown) =>
      error instanceof HandoffFlowError &&
      error.code === "handoff_flow_invalid_confirmation" &&
      error.issues.some((issue) => issue.code === "handoff_source_refs_required"),
  );
  assert.equal((await service.list()).length, 0);
});

test("returns attach to their admission record exactly once", async () => {
  const service = createHandoffAdmissionService({
    execution: acceptedPort({ kind: "multitask-run", id: "run-7" }),
  });
  const confirmation = confirmationFor();
  const admitted = await service.admit(confirmation);
  assert.equal(admitted.status, "accepted");

  const summary = createHandoffReturnSummary({
    handoffId: confirmation.handoffId,
    status: "completed",
    summary: "Settings surface implemented and verified.",
    changes: [{ text: "added the settings panel" }],
    verification: [{ text: "pnpm typecheck", outcome: "passed" }],
  });
  const returned = await service.recordReturn(summary);
  assert.equal(returned.status, "returned");
  assert.deepEqual(returned.returnSummary, summary);
  assert.deepEqual(returned.externalRef, { kind: "multitask-run", id: "run-7" });

  await assert.rejects(
    () => service.recordReturn(summary),
    flowError("handoff_flow_already_returned"),
  );

  const unknownReturn = createHandoffReturnSummary({
    handoffId: "no-such-handoff",
    status: "failed",
    summary: "orphan return",
  });
  await assert.rejects(
    () => service.recordReturn(unknownReturn),
    flowError("handoff_flow_unknown_handoff"),
  );
});
