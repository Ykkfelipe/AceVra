// 后端迁移编排（phase 11）。把状态机、transcript 转换/压缩、Codex handoff turn 三层
// 纯逻辑接成一次完整迁移；所有触碰外部世界的步骤都是注入依赖，好处两个：
// 1) 这个文件本身可以用假依赖完整跑通「5-hop 链路」这类场景测试，不需要真实 Codex/zcode-cli；
// 2) 真实的 TaskIndexRepo/Codex bridge/zcode-cli 接线是单独一层薄适配器，出问题时改的是
//    适配器，不用碰这里的时序/状态机逻辑。
//
// 见 packages/services/specs/backend-migration.md 全文，尤其「State ownership and event
// order」的 mermaid 时序图与 Amendment 3（栅栏写入、提交结果不确定时回读）。
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type {
  BackendHandoffTranscript,
  BackendTransitionFailureReason,
  BackendTransitionRecord,
  PendingBackendTransition,
} from "@zcode/shared";
import {
  advanceBackendTransitionPhase,
  assertCanStartBackendTransition,
  BackendTransitionOwnershipLostError,
  beginBackendTransition,
  commitBackendTransition,
  failBackendTransition,
} from "./backendTransitionStateMachine.js";
import { buildHandoffTranscript } from "./backendHandoffTranscript.js";
import { compactHandoffTranscriptIfNeeded } from "./backendHandoffCompaction.js";
import type {
  BackendMigrationCommitFields,
  BackendMigrationDependencies,
  BackendMigrationResult,
  BackendMigrationTaskState,
  BackendMigrationRequest,
  CodexDestinationDependencies,
} from "./backendMigrationPorts.js";
import {
  buildCodexHandoffPrompt,
  detectUnexpectedToolActivityInHandoffTurn,
  isCodexHandoffAcknowledged,
} from "./codexHandoffTurn.js";

export type {
  BackendMigrationCommitFields,
  BackendMigrationDependencies,
  BackendMigrationRequest,
  BackendMigrationResult,
  BackendMigrationTaskState,
  BackendMigrationTaskStore,
  CodexDestinationDependencies,
  ZCodeDestinationDependencies,
} from "./backendMigrationPorts.js";

type CleanupFn = () => Promise<void>;

interface FailOptions {
  readonly cleanup?: CleanupFn;
  /** handoff turn 已经跑过（哪怕失败）时带上 turn id，失败记录仍可检查那次真实交接。 */
  readonly handoffTurnId?: string;
}

async function runCleanup(cleanup: CleanupFn | undefined): Promise<void> {
  if (!cleanup) return;
  try {
    await cleanup();
  } catch {
    // best-effort：清理失败不覆盖真正的失败原因，也不重新抛出。
  }
}

/**
 * 一次完整迁移：prepared → destinationCreated → handoffRunning → readyToCommit → commit，
 * 任何一步失败都走同一条失败出口——旧后端从始至终没有被写过 executionBackend，
 * 只有失败记录追加进时间线。
 */
export async function migrateBackend(
  state: BackendMigrationTaskState,
  request: BackendMigrationRequest,
  deps: BackendMigrationDependencies,
): Promise<BackendMigrationResult> {
  assertCanStartBackendTransition(state.pendingBackendTransition);

  const requestedAt = deps.now();
  let pending = beginBackendTransition({
    to: request.to,
    ...(request.toProviderId === undefined ? {} : { toProviderId: request.toProviderId }),
    // 修复（Amendment 5）：完整目标选择随记录持久化，composer 在提交后据此重新投影；否则已有
    // task 的草稿继续持有迁移前 provider，下一轮提交会把 runtime 改回旧 provider。
    ...(request.toModelSelection === undefined
      ? {}
      : { toModelSelection: request.toModelSelection }),
    requestedAt,
    compacted: false,
    ownerInstanceId: deps.ownerInstanceId,
  });
  // 持久层准入：库内已有 pending（包括另一个 Host 发起的）时这里抛出，不产生任何失败记录——
  // 这次尝试从未拥有过迁移，不应在别人的迁移时间线上留痕。
  await deps.store.begin(request.taskId, pending);

  const failureRecord = (
    reason: BackendTransitionFailureReason,
    handoffTurnId?: string,
  ): BackendTransitionRecord =>
    failBackendTransition({
      pending: handoffTurnId === undefined ? pending : { ...pending, handoffTurnId },
      from: state.executionBackend,
      ...(state.providerId === undefined ? {} : { fromProviderId: state.providerId }),
      failureReason: reason,
      failedAt: deps.now(),
    }).transitionRecord;

  const fail = async (
    reason: BackendTransitionFailureReason,
    options?: FailOptions,
  ): Promise<BackendMigrationResult> => {
    const record = failureRecord(reason, options?.handoffTurnId);
    // 先清理目标端再落失败记录：失败记录写入本身也可能失败，但孤儿目标端不能因此留下。
    await runCleanup(options?.cleanup);
    let recordPersisted = true;
    try {
      await deps.store.finish(request.taskId, pending, { record });
    } catch {
      recordPersisted = false;
    }
    return { outcome: "failed", record, recordPersisted };
  };

  /** 中间态落盘：任何写入失败（含所有权丢失）都终止本次尝试，不带着未落盘的阶段继续前进。 */
  const persistPhase = async (
    next: PendingBackendTransition,
    cleanup?: CleanupFn,
  ): Promise<BackendMigrationResult | null> => {
    try {
      await deps.store.advance(request.taskId, next);
      pending = next;
      return null;
    } catch (error) {
      if (error instanceof BackendTransitionOwnershipLostError) {
        // 别人（重启恢复）已经替这次迁移写了失败记录；只清理目标端，不再写任何东西。
        await runCleanup(cleanup);
        return { outcome: "failed", record: failureRecord("restart"), recordPersisted: false };
      }
      return fail("persistence_failed", cleanup ? { cleanup } : undefined);
    }
  };

  let transcript: BackendHandoffTranscript;
  let liveSegment: { readonly firstRowId: number | null; readonly lastRowId: number | null };
  let rows: readonly ConversationRow[];
  try {
    const source = await deps.readSourceHistory(request);
    rows = source.rows;
    liveSegment = source.liveSegment;
  } catch {
    // 历史读不出来就无法交接上下文——失败，旧后端保持权威（不是「压缩失败」）。
    return fail("source_read_failed");
  }
  try {
    const rawTranscript = buildHandoffTranscript({
      taskId: request.taskId,
      sourceBackend: state.executionBackend,
      rows,
      generatedAt: requestedAt,
    });
    transcript = await compactHandoffTranscriptIfNeeded({
      transcript: rawTranscript,
      budget: deps.resolveDestinationBudget(request),
      summarizePrefix: deps.summarizePrefix,
      now: deps.now,
    });
  } catch {
    return fail("compaction_failed");
  }

  const transcriptRevision = deps.generateTranscriptRevision(transcript);
  const aborted = await persistPhase({
    ...pending,
    transcriptRevision,
    compacted: transcript.compacted,
    // 离开 zcode：被关闭 Agent 段的行边界随 prepared 一起落盘，commit 时进入记录，
    // 之后时间线组合器据此把同一 zcode 会话里的段切开（Amendment 4）。
    ...(state.executionBackend === "zcode"
      ? { sourceFirstRowId: liveSegment.firstRowId, sourceLastRowId: liveSegment.lastRowId }
      : {}),
  });
  if (aborted) return aborted;

  const context: DirectionContext = { state, request, deps, transcript, fail, persistPhase };
  if (request.to === "codex") {
    return migrateToCodex(context, () => pending);
  }
  return migrateToZCode(context, () => pending);
}

interface DirectionContext {
  readonly state: BackendMigrationTaskState;
  readonly request: BackendMigrationRequest;
  readonly deps: BackendMigrationDependencies;
  readonly transcript: BackendHandoffTranscript;
  readonly fail: (
    reason: BackendTransitionFailureReason,
    options?: FailOptions,
  ) => Promise<BackendMigrationResult>;
  readonly persistPhase: (
    next: PendingBackendTransition,
    cleanup?: CleanupFn,
  ) => Promise<BackendMigrationResult | null>;
}

/**
 * readyToCommit 已落盘之后的提交：一次栅栏写入同时写归属字段、追加 committed 记录、清空
 * pending。写入抛错时结果不确定——回读真实状态再决定，绝不假设成功或失败。
 * 可见 marker 由时间线组合器从这条记录合成，不写任何后端自己的行日志（Amendment 4）。
 */
async function commitTransition(
  context: DirectionContext,
  pending: PendingBackendTransition,
  commit: BackendMigrationCommitFields,
  cleanup: CleanupFn,
): Promise<BackendMigrationResult> {
  const { state, request, deps } = context;
  const { transitionRecord } = commitBackendTransition({
    pending,
    from: state.executionBackend,
    ...(state.providerId === undefined ? {} : { fromProviderId: state.providerId }),
    ...(state.sourceExecutionRef === undefined
      ? {}
      : { sourceExecutionRef: state.sourceExecutionRef }),
    committedAt: deps.now(),
  });
  try {
    await deps.store.finish(request.taskId, pending, { record: transitionRecord, commit });
  } catch (error) {
    const resolved = await resolveInDoubtCommit(context, pending, transitionRecord, cleanup, error);
    if (resolved.outcome !== "committed") return resolved;
  }
  return { outcome: "committed", record: transitionRecord };
}

async function resolveInDoubtCommit(
  context: DirectionContext,
  pending: PendingBackendTransition,
  record: BackendTransitionRecord,
  cleanup: CleanupFn,
  error: unknown,
): Promise<BackendMigrationResult> {
  const { request, deps } = context;
  if (error instanceof BackendTransitionOwnershipLostError) {
    // 栅栏拒绝意味着什么都没写：迁移被别人判定失败，归属仍是旧后端。
    await runCleanup(cleanup);
    return { outcome: "failed", record, recordPersisted: false };
  }
  let persisted: BackendMigrationTaskState;
  try {
    persisted = await deps.store.read(request.taskId);
  } catch {
    return { outcome: "inDoubt", record };
  }
  const committed = persisted.backendTransitions?.some(
    (entry) =>
      entry.status === "committed" &&
      entry.startedAt === record.startedAt &&
      entry.to === record.to,
  );
  if (committed) return { outcome: "committed", record };
  const stillOurs =
    persisted.pendingBackendTransition?.requestedAt === pending.requestedAt &&
    persisted.pendingBackendTransition.ownerInstanceId === pending.ownerInstanceId;
  if (stillOurs) return context.fail("persistence_failed", { cleanup });
  await runCleanup(cleanup);
  return { outcome: "failed", record, recordPersisted: false };
}

async function migrateToCodex(
  context: DirectionContext,
  currentPending: () => PendingBackendTransition,
): Promise<BackendMigrationResult> {
  const { request, deps, transcript, fail, persistPhase } = context;
  let codexThreadId: string;
  try {
    const created = await deps.codex.createThread({
      taskId: request.taskId,
      title: deps.taskTitle,
      workspacePath: deps.workspacePath,
    });
    codexThreadId = created.codexThreadId;
  } catch {
    return fail("destination_create_failed");
  }
  const abandon = () => deps.codex.abandonThread(codexThreadId);
  let aborted = await persistPhase(
    advanceBackendTransitionPhase(currentPending(), "destinationCreated", {
      destinationExecutionRef: codexThreadId,
    }),
    abandon,
  );
  if (aborted) return aborted;
  aborted = await persistPhase(
    advanceBackendTransitionPhase(currentPending(), "handoffRunning"),
    abandon,
  );
  if (aborted) return aborted;

  let handoffResult: Awaited<ReturnType<CodexDestinationDependencies["runHandoffTurn"]>>;
  try {
    handoffResult = await deps.codex.runHandoffTurn({
      codexThreadId,
      prompt: buildCodexHandoffPrompt(transcript),
    });
  } catch {
    return fail("handoff_turn_error", { cleanup: abandon });
  }
  if (
    !isCodexHandoffAcknowledged({
      reachedNormalTerminalState: handoffResult.reachedNormalTerminalState,
    })
  ) {
    return fail(handoffResult.timedOut === false ? "handoff_turn_error" : "handoff_turn_timeout", {
      cleanup: abandon,
      handoffTurnId: handoffResult.turnId,
    });
  }
  if (
    handoffResult.unexpectedToolActivity === true ||
    detectUnexpectedToolActivityInHandoffTurn(handoffResult.handoffTurnRows)
  ) {
    return fail("unexpected_tool_activity_in_handoff", {
      cleanup: abandon,
      handoffTurnId: handoffResult.turnId,
    });
  }

  aborted = await persistPhase(
    advanceBackendTransitionPhase(currentPending(), "readyToCommit", {
      handoffTurnId: handoffResult.turnId,
    }),
    abandon,
  );
  if (aborted) return aborted;

  return commitTransition(
    context,
    currentPending(),
    // Codex 任务不携带细粒度 providerId（那是 zcode family 内部的概念）；zcode 侧最后的
    // modelSelection 原样保留，以后迁回 zcode 时由请求显式给出新的选择。
    { executionBackend: "codex", codexThreadId },
    abandon,
  );
}

async function migrateToZCode(
  context: DirectionContext,
  currentPending: () => PendingBackendTransition,
): Promise<BackendMigrationResult> {
  const { request, deps, transcript, fail, persistPhase } = context;
  const toProviderId = request.toProviderId;
  if (!toProviderId) return fail("destination_not_ready");

  const rollback = () => deps.zcode.deleteSeededHistory(request.taskId);
  let seedLastRowId: number | null;
  try {
    ({ seedLastRowId } = await deps.zcode.seedHistory({ taskId: request.taskId, transcript }));
  } catch {
    // seed 写入可能部分成功；回滚同样是 best-effort，不留下重复历史。
    return fail("destination_create_failed", { cleanup: rollback });
  }
  // 种子边界一旦知道就落盘：新 Agent 段严格从它之后开始（Amendment 4）。
  let aborted = await persistPhase(
    advanceBackendTransitionPhase(currentPending(), "destinationCreated", {
      destinationSeedLastRowId: seedLastRowId,
    }),
    rollback,
  );
  if (aborted) return aborted;
  aborted = await persistPhase(
    advanceBackendTransitionPhase(currentPending(), "handoffRunning"),
    rollback,
  );
  if (aborted) return aborted;

  let ready: boolean;
  try {
    const result = await deps.zcode.startAndConfirmReady({
      taskId: request.taskId,
      providerId: toProviderId,
    });
    ready = result.ready;
  } catch {
    return fail("destination_create_failed", { cleanup: rollback });
  }
  if (!ready) {
    return fail("destination_not_ready", { cleanup: rollback });
  }

  aborted = await persistPhase(
    advanceBackendTransitionPhase(currentPending(), "readyToCommit"),
    rollback,
  );
  if (aborted) return aborted;

  return commitTransition(
    context,
    currentPending(),
    {
      executionBackend: "zcode",
      codexThreadId: undefined,
      ...(request.toModelSelection === undefined
        ? {}
        : { modelSelection: request.toModelSelection }),
    },
    rollback,
  );
}
