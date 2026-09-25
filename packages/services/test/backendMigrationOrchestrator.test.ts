/**
 * 编排层测试：用假依赖跑通完整迁移时序，不需要真实 Codex/zcode-cli。
 * 覆盖 packages/services/specs/backend-migration.md 的验收场景，包括第 10 条的多跳链路。
 *
 * Run: mise exec -- node --import tsx --test packages/services/test/backendMigrationOrchestrator.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  BackendHandoffTranscript,
  BackendTransitionRecord,
  PendingBackendTransition,
} from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  BackendTransitionOwnershipLostError,
  ConcurrentBackendTransitionError,
} from "../src/backend-migration/backendTransitionStateMachine.js";
import {
  migrateBackend,
  type BackendMigrationDependencies,
  type BackendMigrationTaskState,
} from "../src/backend-migration/backendMigrationOrchestrator.js";

let nextRowId = 1;
function userRow(text: string, turnId: string): Extract<ConversationRow, { kind: "userInput" }> {
  const id = nextRowId++;
  return {
    rowId: id,
    turnId,
    kind: "userInput",
    text,
    origin: "realUser",
    createdAt: id,
    createdAtSeq: id,
  };
}
function assistantRow(
  text: string,
  turnId: string,
): Extract<ConversationRow, { kind: "assistantText" }> {
  const id = nextRowId++;
  return {
    rowId: id,
    turnId,
    kind: "assistantText",
    text,
    state: "complete",
    createdAt: id,
    createdAtSeq: id,
  };
}
/** 一套可复用的假依赖 + 一份被 writeTaskMetaPatch 持续更新的任务状态镜像。 */
function createHarness() {
  let rows: ConversationRow[] = [];
  let clock = 10_000;
  let taskState: BackendMigrationTaskState = { executionBackend: "zcode", providerId: "zai" };
  let codexThreadCounter = 0;
  let revisionCounter = 0;

  const codexCreateThreadCalls: string[] = [];
  const codexRunHandoffTurnCalls: string[] = [];
  const codexHandoffPrompts: string[] = [];
  const codexAbandonCalls: string[] = [];
  const zcodeSeedCalls: BackendHandoffTranscript[] = [];
  const zcodeDeleteCalls: string[] = [];

  let nextCodexOutcome: "ready" | "error" | "timeout" | "tool-activity" = "ready";
  let nextZCodeReady = true;
  let nextZCodeSeedShouldThrow = false;
  let nextCodexCreateShouldThrow = false;
  let failAdvanceAtPhase: PendingBackendTransition["phase"] | null = null;
  let commitWriteBehavior: "ok" | "throw-before-write" | "throw-after-write" = "ok";
  let beforeRunHandoff: (() => void) | null = null;
  const storeCalls: string[] = [];
  const handoffTurnIds = new Set<string>();

  const deps: BackendMigrationDependencies = {
    now: () => (clock += 1),
    generateTranscriptRevision: () => `rev-${(revisionCounter += 1)}`,
    // 模拟时间线组合器：handoff 轮（按 Codex turn id）与迁移种子行不属于规范历史。
    readSourceHistory: async () => {
      const canonical = rows.filter(
        (row) =>
          !(row.sourceTurnId !== undefined && handoffTurnIds.has(row.sourceTurnId)) &&
          row.turnId !== "seeded",
      );
      const live = canonical.filter((row) => row.kind !== "timelineMarker");
      return {
        rows: canonical,
        liveSegment: { firstRowId: live[0]?.rowId ?? null, lastRowId: live.at(-1)?.rowId ?? null },
      };
    },
    resolveDestinationBudget: () => ({ contextWindowTokens: 1_000_000 }),
    summarizePrefix: async () => "should not be needed for small test transcripts",
    workspacePath: "/workspace",
    taskTitle: "Test task",
    codex: {
      createThread: async (params) => {
        codexCreateThreadCalls.push(params.taskId);
        if (nextCodexCreateShouldThrow) throw new Error("thread/start failed");
        codexThreadCounter += 1;
        return { codexThreadId: `codex-thread-${codexThreadCounter}` };
      },
      runHandoffTurn: async (params) => {
        codexRunHandoffTurnCalls.push(params.codexThreadId);
        beforeRunHandoff?.();
        codexHandoffPrompts.push(params.prompt);
        if (nextCodexOutcome === "error") throw new Error("turn/start errored");
        const handoffTurnId = `turn-${codexRunHandoffTurnCalls.length}`;
        handoffTurnIds.add(handoffTurnId);
        const requestRow = {
          ...userRow(params.prompt, "handoff-turn"),
          sourceTurnId: handoffTurnId,
        };
        const toolActivity = nextCodexOutcome === "tool-activity";
        const handoffTurnRows: ConversationRow[] = toolActivity
          ? [
              requestRow,
              {
                rowId: nextRowId++,
                turnId: "handoff-turn",
                kind: "toolCall",
                toolCallId: "tc-unexpected",
                toolName: "Write",
                status: "success",
                inputText: "should not happen",
                createdAt: clock,
                createdAtSeq: clock,
              },
            ]
          : [
              requestRow,
              {
                ...assistantRow("ACEVRA_HANDOFF_READY", "handoff-turn"),
                sourceTurnId: handoffTurnId,
              },
            ];
        rows.push(...handoffTurnRows);
        return {
          turnId: handoffTurnId,
          reachedNormalTerminalState: nextCodexOutcome !== "timeout",
          handoffTurnRows,
          replyText: "ACEVRA_HANDOFF_READY",
        };
      },
      abandonThread: async (id) => {
        codexAbandonCalls.push(id);
      },
    },
    zcode: {
      seedHistory: async (params) => {
        zcodeSeedCalls.push(params.transcript);
        if (nextZCodeSeedShouldThrow) throw new Error("seed write failed");
        for (const entry of params.transcript.entries) {
          rows.push(
            entry.role === "assistant"
              ? assistantRow(entry.content, "seeded")
              : userRow(entry.content, "seeded"),
          );
        }
        return { seedLastRowId: rows.at(-1)?.rowId ?? null };
      },
      startAndConfirmReady: async () => ({ ready: nextZCodeReady }),
      deleteSeededHistory: async (taskId) => {
        zcodeDeleteCalls.push(taskId);
      },
    },
    ownerInstanceId: "host-test:boot-1",
    store: {
      begin: async (_taskId, pending) => {
        storeCalls.push(`begin:${pending.phase}`);
        if (taskState.pendingBackendTransition) {
          throw new ConcurrentBackendTransitionError(taskState.pendingBackendTransition);
        }
        taskState = { ...taskState, pendingBackendTransition: pending };
      },
      advance: async (taskId, pending) => {
        storeCalls.push(`advance:${pending.phase}`);
        assertOwned(taskId, pending);
        if (failAdvanceAtPhase === pending.phase) throw new Error("sqlite write failed");
        taskState = { ...taskState, pendingBackendTransition: pending };
      },
      finish: async (taskId, pending, outcome) => {
        storeCalls.push(`finish:${outcome.commit ? "commit" : "fail"}`);
        assertOwned(taskId, pending);
        if (outcome.commit && commitWriteBehavior === "throw-before-write") {
          throw new Error("sqlite commit failed");
        }
        taskState = {
          ...taskState,
          pendingBackendTransition: undefined,
          backendTransitions: [...(taskState.backendTransitions ?? []), outcome.record],
          ...(outcome.commit
            ? {
                executionBackend: outcome.commit.executionBackend,
                providerId:
                  outcome.commit.executionBackend === "zcode"
                    ? outcome.record.toProviderId
                    : undefined,
                sourceExecutionRef: outcome.commit.codexThreadId,
              }
            : {}),
        };
        if (outcome.commit && commitWriteBehavior === "throw-after-write") {
          throw new Error("connection dropped after commit");
        }
      },
      read: async () => taskState,
    },
  };

  function assertOwned(taskId: string, pending: PendingBackendTransition): void {
    const current = taskState.pendingBackendTransition;
    if (
      !current ||
      current.requestedAt !== pending.requestedAt ||
      current.ownerInstanceId !== pending.ownerInstanceId
    ) {
      throw new BackendTransitionOwnershipLostError(taskId);
    }
  }

  return {
    deps,
    get taskState() {
      return taskState;
    },
    setTaskState: (next: BackendMigrationTaskState) => {
      taskState = next;
    },
    pushRow: (row: ConversationRow) => rows.push(row),
    get rows() {
      return rows;
    },
    codexCreateThreadCalls,
    codexRunHandoffTurnCalls,
    codexHandoffPrompts,
    codexAbandonCalls,
    zcodeSeedCalls,
    zcodeDeleteCalls,
    setCodexOutcome: (v: typeof nextCodexOutcome) => (nextCodexOutcome = v),
    setCodexCreateShouldThrow: (v: boolean) => (nextCodexCreateShouldThrow = v),
    setZCodeReady: (v: boolean) => (nextZCodeReady = v),
    setZCodeSeedShouldThrow: (v: boolean) => (nextZCodeSeedShouldThrow = v),
    setFailAdvanceAtPhase: (v: typeof failAdvanceAtPhase) => (failAdvanceAtPhase = v),
    setCommitWriteBehavior: (v: typeof commitWriteBehavior) => (commitWriteBehavior = v),
    setBeforeRunHandoff: (fn: (() => void) | null) => (beforeRunHandoff = fn),
    storeCalls,

    getTaskState: () => taskState,
    setTaskStateDirect: (fn: (s: BackendMigrationTaskState) => BackendMigrationTaskState) => {
      taskState = fn(taskState);
    },
  };
}

test("zcode -> codex: a clean handoff commits, marks the destination, and appends one timeline record", async () => {
  nextRowId = 1;
  const h = createHarness();
  h.pushRow(userRow("please refactor auth.ts", "t1"));
  h.pushRow(assistantRow("done refactoring", "t1"));

  const result = await migrateBackend(
    h.getTaskState(),
    { taskId: "task-1", sessionId: "task-1", to: "codex" },
    h.deps,
  );

  assert.equal(result.outcome, "committed");
  assert.equal(h.getTaskState().executionBackend, "codex");
  assert.equal(h.getTaskState().pendingBackendTransition, undefined);
  assert.equal(h.getTaskState().backendTransitions?.length, 1);
  assert.equal(h.getTaskState().backendTransitions?.[0]?.status, "committed");
  assert.equal(h.codexCreateThreadCalls.length, 1);
  assert.equal(h.codexRunHandoffTurnCalls.length, 1);
  assert.equal(
    h.codexAbandonCalls.length,
    0,
    "a successful migration never abandons its own thread",
  );
});

test("codex -> zcode: a clean handoff seeds history, confirms readiness, and commits", async () => {
  nextRowId = 1;
  const h = createHarness();
  h.setTaskState({ executionBackend: "codex", sourceExecutionRef: "codex-thread-old" });
  h.pushRow(userRow("keep going", "t1"));
  h.pushRow(assistantRow("working on it", "t1"));

  const result = await migrateBackend(
    h.getTaskState(),
    { taskId: "task-1", sessionId: "task-1", to: "zcode", toProviderId: "azure-openai" },
    h.deps,
  );

  assert.equal(result.outcome, "committed");
  assert.equal(h.getTaskState().executionBackend, "zcode");
  assert.equal(h.zcodeSeedCalls.length, 1);
  assert.ok(h.zcodeSeedCalls[0]!.entries.some((e) => e.content === "keep going"));
  assert.equal(h.getTaskState().backendTransitions?.[0]?.sourceExecutionRef, "codex-thread-old");
});

test("a concurrent migration attempt is rejected outright, not queued or started", async () => {
  nextRowId = 1;
  const h = createHarness();
  const pending: PendingBackendTransition = {
    phase: "handoffRunning",
    to: "codex",
    requestedAt: 1,
  };
  h.setTaskState({ executionBackend: "zcode", pendingBackendTransition: pending });

  await assert.rejects(
    () =>
      migrateBackend(
        h.getTaskState(),
        { taskId: "task-1", sessionId: "task-1", to: "codex" },
        h.deps,
      ),
    ConcurrentBackendTransitionError,
  );
  // 拒绝发生在任何外部调用之前。
  assert.equal(h.codexCreateThreadCalls.length, 0);
});

test("zcode -> codex failure: thread/start rejecting leaves the original backend untouched", async () => {
  nextRowId = 1;
  const h = createHarness();
  h.setCodexCreateShouldThrow(true);
  h.pushRow(userRow("hi", "t1"));

  const result = await migrateBackend(
    h.getTaskState(),
    { taskId: "task-1", sessionId: "task-1", to: "codex" },
    h.deps,
  );

  assert.equal(result.outcome, "failed");
  assert.equal(result.record.failureReason, "destination_create_failed");
  assert.equal(h.getTaskState().executionBackend, "zcode", "original backend must be untouched");
  assert.equal(h.getTaskState().pendingBackendTransition, undefined);
});

test("zcode -> codex failure: the handoff turn erroring is a failure, and the orphaned thread is abandoned", async () => {
  nextRowId = 1;
  const h = createHarness();
  h.setCodexOutcome("error");
  h.pushRow(userRow("hi", "t1"));

  const result = await migrateBackend(
    h.getTaskState(),
    { taskId: "task-1", sessionId: "task-1", to: "codex" },
    h.deps,
  );

  assert.equal(result.outcome, "failed");
  assert.equal(result.record.failureReason, "handoff_turn_error");
  assert.equal(h.getTaskState().executionBackend, "zcode");
  assert.equal(
    h.codexAbandonCalls.length,
    1,
    "the thread created before the failed turn must be abandoned",
  );
});

test("zcode -> codex failure: a timed-out handoff turn is a failure even without an exception", async () => {
  nextRowId = 1;
  const h = createHarness();
  h.setCodexOutcome("timeout");
  h.pushRow(userRow("hi", "t1"));

  const result = await migrateBackend(
    h.getTaskState(),
    { taskId: "task-1", sessionId: "task-1", to: "codex" },
    h.deps,
  );

  assert.equal(result.outcome, "failed");
  assert.equal(result.record.failureReason, "handoff_turn_timeout");
  assert.equal(h.getTaskState().executionBackend, "zcode");
});

test("zcode -> codex failure: unexpected tool activity during the handoff turn fails the migration even though the turn 'succeeded'", async () => {
  nextRowId = 1;
  const h = createHarness();
  h.setCodexOutcome("tool-activity");
  h.pushRow(userRow("hi", "t1"));

  const result = await migrateBackend(
    h.getTaskState(),
    { taskId: "task-1", sessionId: "task-1", to: "codex" },
    h.deps,
  );

  assert.equal(result.outcome, "failed");
  assert.equal(result.record.failureReason, "unexpected_tool_activity_in_handoff");
  assert.equal(h.getTaskState().executionBackend, "zcode");
  assert.equal(h.codexAbandonCalls.length, 1);
});

test("codex -> zcode failure: destination not ready rolls back the seeded history and leaves Codex authoritative", async () => {
  nextRowId = 1;
  const h = createHarness();
  h.setTaskState({ executionBackend: "codex", sourceExecutionRef: "codex-thread-old" });
  h.setZCodeReady(false);
  h.pushRow(userRow("hi", "t1"));

  const result = await migrateBackend(
    h.getTaskState(),
    { taskId: "task-1", sessionId: "task-1", to: "zcode", toProviderId: "azure-openai" },
    h.deps,
  );

  assert.equal(result.outcome, "failed");
  assert.equal(result.record.failureReason, "destination_not_ready");
  assert.equal(h.getTaskState().executionBackend, "codex");
  assert.equal(h.zcodeDeleteCalls.length, 1, "the seeded rows must be rolled back on failure");
});

test("chain: Agent(Z.ai) -> Agent(Command Code) -> Codex -> Agent(Azure) -> Codex stays on one task id with a clean timeline", async () => {
  nextRowId = 1;
  const h = createHarness();
  const taskId = "task-chain-1";

  // Hop 1: Z.ai -> Command Code. Provider-only switch inside zcode — already-shipped behavior,
  // not migrateBackend at all (see spec "already shipped, unaffected"). No transcript, no
  // backendTransitions entry — just the provider bookkeeping the composer already owns.
  h.setTaskStateDirect((s) => ({ ...s, providerId: "command-code" }));
  h.pushRow(userRow("start the migration task", "t1"));
  h.pushRow(assistantRow("On it via Command Code", "t1"));

  // Hop 2: Command Code (zcode) -> Codex.
  const hop2 = await migrateBackend(
    h.getTaskState(),
    { taskId, sessionId: taskId, to: "codex" },
    h.deps,
  );
  assert.equal(hop2.outcome, "committed");
  assert.equal(h.getTaskState().executionBackend, "codex");
  h.pushRow(assistantRow("Continuing on Codex now", "t2"));

  // Hop 3: Codex -> Agent(Azure).
  h.setTaskStateDirect((s) => ({ ...s, sourceExecutionRef: "codex-thread-1" }));
  const hop3 = await migrateBackend(
    h.getTaskState(),
    { taskId, sessionId: taskId, to: "zcode", toProviderId: "azure-openai" },
    h.deps,
  );
  assert.equal(hop3.outcome, "committed");
  assert.equal(h.getTaskState().executionBackend, "zcode");
  // 提交时就该把新 provider 写进去，不能让 composer 继续显示迁移前的旧 provider。
  assert.equal(h.getTaskState().providerId, "azure-openai");
  h.pushRow(assistantRow("Azure here, wrapping up", "t3"));

  // Hop 4: Agent(Azure) -> Codex again — the SECOND crossing into Codex.
  const rowsBeforeHop4 = h.rows.length;
  const hop4 = await migrateBackend(
    h.getTaskState(),
    { taskId, sessionId: taskId, to: "codex" },
    h.deps,
  );
  assert.equal(hop4.outcome, "committed");
  assert.equal(h.getTaskState().executionBackend, "codex");
  assert.ok(h.rows.length > rowsBeforeHop4, "the second handoff turn appended its own rows");

  // -- Assertions from acceptance scenario 10 --
  // Three backend crossings happen in this chain: Command Code->Codex, Codex->Azure,
  // Azure->Codex. The Z.ai->Command Code hop is provider-only (already-shipped path) and
  // produces no timeline entry — that's the only hop excluded, not "every other hop".
  const timeline = h.getTaskState().backendTransitions ?? [];
  assert.equal(
    timeline.length,
    3,
    "every backend-crossing hop produces exactly one timeline entry",
  );
  assert.deepEqual(
    timeline.map((t: BackendTransitionRecord) => [t.from, t.to]),
    [
      ["zcode", "codex"],
      ["codex", "zcode"],
      ["zcode", "codex"],
    ],
  );
  assert.ok(timeline.every((t: BackendTransitionRecord) => t.status === "committed"));
  assert.equal(
    h.codexCreateThreadCalls.length,
    2,
    "each Codex crossing creates its own fresh thread",
  );

  // Canonical-history rule: hop 4's transcript must not carry hop 2's own handoff exchange
  // as ordinary history. hop 2's request row's text IS hop 2's entire prompt — a very
  // distinctive string — so if it leaked into hop 4's transcript as a regular history entry,
  // hop 4's own prompt would contain hop 2's *entire* prompt text nested inside it.
  assert.equal(h.codexHandoffPrompts.length, 2, "exactly two Codex handoff turns were run");
  const [hop2Prompt, hop4Prompt] = h.codexHandoffPrompts;
  assert.ok(
    !hop4Prompt!.includes(hop2Prompt!),
    "hop 4's prompt must not contain hop 2's entire handoff prompt nested inside it",
  );
  // And hop 2's own reply text ("ACEVRA_HANDOFF_READY" from the fake) must not appear as a
  // *history* line in hop 4's transcript either — it legitimately reappears once, inside hop
  // 4's own boilerplate instructions asking Codex to reply with that marker, so the assertion
  // is about it not appearing as part of the transferred "--- Prior task context ---" body
  // beyond that one legitimate instruction occurrence.
  const priorContextSection = hop4Prompt!.split("--- Prior task context ---")[1] ?? "";
  assert.ok(
    !priorContextSection.includes("ACEVRA_HANDOFF_READY"),
    "hop 2's handoff acknowledgement must not resurface inside hop 4's transferred history",
  );
  // The two real conversation turns that happened on the intermediate backends are preserved.
  assert.ok(priorContextSection.includes("Continuing on Codex now"));
  assert.ok(priorContextSection.includes("Azure here, wrapping up"));
});

test("persistence failing at an intermediate phase ends the attempt and cleans up the destination", async () => {
  nextRowId = 1;
  const h = createHarness();
  h.pushRow(userRow("hi", "t1"));
  h.setFailAdvanceAtPhase("handoffRunning");

  const result = await migrateBackend(
    h.getTaskState(),
    { taskId: "task-1", sessionId: "task-1", to: "codex" },
    h.deps,
  );

  assert.equal(result.outcome, "failed");
  assert.equal(result.record.failureReason, "persistence_failed");
  assert.equal(h.getTaskState().executionBackend, "zcode");
  assert.equal(h.getTaskState().pendingBackendTransition, undefined);
  assert.equal(h.codexRunHandoffTurnCalls.length, 0, "no handoff turn after an unpersisted phase");
  assert.deepEqual(h.codexAbandonCalls, ["codex-thread-1"]);
});

test("commit write that throws before writing is resolved by re-reading: not committed, destination cleaned", async () => {
  nextRowId = 1;
  const h = createHarness();
  h.pushRow(userRow("hi", "t1"));
  h.setCommitWriteBehavior("throw-before-write");

  const result = await migrateBackend(
    h.getTaskState(),
    { taskId: "task-1", sessionId: "task-1", to: "codex" },
    h.deps,
  );

  assert.equal(result.outcome, "failed");
  assert.equal(result.record.failureReason, "persistence_failed");
  assert.equal(h.getTaskState().executionBackend, "zcode");
  assert.equal(h.getTaskState().backendTransitions?.[0]?.status, "failed");
  assert.deepEqual(h.codexAbandonCalls, ["codex-thread-1"]);
});

test("commit write that throws after the row was written is resolved by re-reading: committed", async () => {
  nextRowId = 1;
  const h = createHarness();
  h.pushRow(userRow("hi", "t1"));
  h.setCommitWriteBehavior("throw-after-write");

  const result = await migrateBackend(
    h.getTaskState(),
    { taskId: "task-1", sessionId: "task-1", to: "codex" },
    h.deps,
  );

  assert.equal(result.outcome, "committed");
  assert.equal(h.getTaskState().executionBackend, "codex");
  assert.equal(h.codexAbandonCalls.length, 0, "a committed destination is never abandoned");
});

test("losing ownership mid-flight (restart recovery by another host) never commits and cleans up", async () => {
  nextRowId = 1;
  const h = createHarness();
  h.pushRow(userRow("hi", "t1"));
  // 模拟另一个 Host 的重启恢复在 handoff turn 期间把 pending 判定为 restart 失败。
  h.setBeforeRunHandoff(() =>
    h.setTaskStateDirect((s) => ({ ...s, pendingBackendTransition: undefined })),
  );

  const result = await migrateBackend(
    h.getTaskState(),
    { taskId: "task-1", sessionId: "task-1", to: "codex" },
    h.deps,
  );

  assert.equal(result.outcome, "failed");
  assert.equal(h.getTaskState().executionBackend, "zcode");
  assert.deepEqual(h.codexAbandonCalls, ["codex-thread-1"]);
  assert.ok(
    !h.storeCalls.includes("finish:commit") || h.getTaskState().executionBackend === "zcode",
  );
});

test("leaving zcode records the closed Agent segment's row range on the committed record", async () => {
  nextRowId = 1;
  const h = createHarness();
  h.pushRow(userRow("first", "t1"));
  h.pushRow(assistantRow("second", "t1"));
  const result = await migrateBackend(
    h.getTaskState(),
    { taskId: "task-1", sessionId: "task-1", to: "codex" },
    h.deps,
  );
  assert.equal(result.outcome, "committed");
  assert.equal(result.record.sourceFirstRowId, 1);
  assert.equal(result.record.sourceLastRowId, 2);
  assert.equal(result.record.handoffTurnId, "turn-1");
});

test("entering zcode records the seed boundary so seeded replicas never render", async () => {
  nextRowId = 1;
  const h = createHarness();
  h.setTaskState({ executionBackend: "codex", sourceExecutionRef: "codex-thread-old" });
  h.pushRow(userRow("from codex", "t1"));
  const result = await migrateBackend(
    h.getTaskState(),
    { taskId: "task-1", sessionId: "task-1", to: "zcode", toProviderId: "azure-openai" },
    h.deps,
  );
  assert.equal(result.outcome, "committed");
  assert.equal(result.record.destinationSeedLastRowId, h.rows.at(-1)?.rowId);
  assert.equal(
    result.record.sourceLastRowId,
    undefined,
    "no zcode source range when leaving Codex",
  );
});

test("every phase is persisted in order before the commit", async () => {
  nextRowId = 1;
  const h = createHarness();
  h.pushRow(userRow("hi", "t1"));
  await migrateBackend(
    h.getTaskState(),
    { taskId: "task-1", sessionId: "task-1", to: "codex" },
    h.deps,
  );
  assert.deepEqual(h.storeCalls, [
    "begin:prepared",
    "advance:prepared",
    "advance:destinationCreated",
    "advance:handoffRunning",
    "advance:readyToCommit",
    "finish:commit",
  ]);
  assert.equal(h.getTaskState().backendTransitions?.[0]?.handoffTurnId, "turn-1");
});
