// 后端迁移状态机（phase 11，纯函数，无 IO/无时钟）。见
// packages/services/specs/backend-migration.md「State ownership and event order」
// 「Restart-during-migration」两节——本文件就是那两节的可执行版本。
//
// 只负责计算下一份 ZCodeTaskMeta 补丁；写盘（syncTaskMeta，一次整行写入）、创建目标端
// （Codex thread / zcode-cli 进程）都由调用方负责，本文件不触碰任何外部世界。
import {
  BACKEND_TRANSITION_PHASES,
  type BackendTransitionFailureReason,
  type BackendTransitionPhase,
  type BackendTransitionRecord,
  type PendingBackendTransition,
  type ZCodeExecutionBackend,
} from "@zcode/shared";

export class ConcurrentBackendTransitionError extends Error {
  constructor(readonly pending: PendingBackendTransition) {
    super(
      `任务已经有一个进行中的后端迁移（phase=${pending.phase}, to=${pending.to}），` +
        "拒绝并发发起第二个迁移。",
    );
    this.name = "ConcurrentBackendTransitionError";
  }
}

/**
 * 持久层栅栏拒绝了本次写入：pending 已不再属于这次迁移（例如另一个 Host 的重启恢复已把它
 * 判定为失败）。收到它的编排者必须放弃提交，只做目标端清理（spec Amendment 3）。
 */
export class BackendTransitionOwnershipLostError extends Error {
  constructor(readonly taskId: string) {
    super(`task ${taskId} 的后端迁移已不再归本次尝试所有，放弃提交。`);
    this.name = "BackendTransitionOwnershipLostError";
  }
}

export class InvalidBackendTransitionPhaseError extends Error {
  constructor(
    readonly from: BackendTransitionPhase,
    readonly to: BackendTransitionPhase,
  ) {
    super(`后端迁移阶段不能从 ${from} 推进到 ${to}：每次只能前进恰好一步，不能后退或跳步。`);
    this.name = "InvalidBackendTransitionPhaseError";
  }
}

/** 发起迁移前必须先调用；已有 pendingBackendTransition 时拒绝并发发起。 */
export function assertCanStartBackendTransition(
  pending: PendingBackendTransition | undefined,
): void {
  if (pending) throw new ConcurrentBackendTransitionError(pending);
}

export interface BeginBackendTransitionParams {
  readonly to: ZCodeExecutionBackend;
  readonly toProviderId?: string;
  readonly requestedAt: number;
  readonly transcriptRevision?: string;
  readonly compacted: boolean;
  readonly ownerInstanceId?: string;
}

/** 迁移的第一次落盘：phase="prepared"，此时旧 executionBackend 完全未变。 */
export function beginBackendTransition(
  params: BeginBackendTransitionParams,
): PendingBackendTransition {
  return {
    phase: "prepared",
    to: params.to,
    ...(params.toProviderId === undefined ? {} : { toProviderId: params.toProviderId }),
    requestedAt: params.requestedAt,
    ...(params.transcriptRevision === undefined
      ? {}
      : { transcriptRevision: params.transcriptRevision }),
    compacted: params.compacted,
    ...(params.ownerInstanceId === undefined ? {} : { ownerInstanceId: params.ownerInstanceId }),
  };
}

/** 随阶段落盘、commit/fail 时原样进入时间线记录的事实字段（不含 phase/owner 等控制字段）。 */
type PendingTransitionFactKey =
  | "destinationExecutionRef"
  | "handoffTurnId"
  | "sourceFirstRowId"
  | "sourceLastRowId"
  | "destinationSeedLastRowId";

const PENDING_TRANSITION_FACT_KEYS: readonly PendingTransitionFactKey[] = [
  "destinationExecutionRef",
  "handoffTurnId",
  "sourceFirstRowId",
  "sourceLastRowId",
  "destinationSeedLastRowId",
];

function definedFacts(
  source: Partial<Pick<PendingBackendTransition, PendingTransitionFactKey>>,
): Partial<Pick<PendingBackendTransition, PendingTransitionFactKey>> {
  const facts: Record<string, unknown> = {};
  for (const key of PENDING_TRANSITION_FACT_KEYS) {
    if (source[key] !== undefined) facts[key] = source[key];
  }
  return facts as Partial<Pick<PendingBackendTransition, PendingTransitionFactKey>>;
}

const PHASE_ORDER = new Map<BackendTransitionPhase, number>(
  BACKEND_TRANSITION_PHASES.map((phase, index) => [phase, index]),
);

/**
 * 阶段单调前进（prepared → destinationCreated → handoffRunning → readyToCommit）；
 * 可选附带目标端标识（如 Codex thread id）或 handoff turn id，一旦知道就立刻落盘，
 * 不等到 commit 才补——这样即使在这一步之后崩溃，重启也能在失败记录里看到迁移走到了哪。
 */
export function advanceBackendTransitionPhase(
  pending: PendingBackendTransition,
  nextPhase: BackendTransitionPhase,
  patch: Partial<Pick<PendingBackendTransition, PendingTransitionFactKey>> = {},
): PendingBackendTransition {
  const currentIndex = PHASE_ORDER.get(pending.phase)!;
  const nextIndex = PHASE_ORDER.get(nextPhase)!;
  // 只允许恰好前进一步：既堵住后退/原地不动，也堵住跳步——跳步会让 destinationCreated/
  // handoffRunning 这类「目标端已创建但还没确认就绪」的中间态永远不会被落盘，
  // 一旦在跳过的那一步崩溃，重启就没有证据能说明目标端到底建到了哪。
  if (nextIndex !== currentIndex + 1) {
    throw new InvalidBackendTransitionPhaseError(pending.phase, nextPhase);
  }
  if (nextPhase === "committed") {
    // "committed" 从不作为静止态被写入；提交必须走 commitBackendTransition，
    // 那个函数在同一次补丁里清空 pendingBackendTransition 并追加时间线记录。
    throw new InvalidBackendTransitionPhaseError(pending.phase, nextPhase);
  }
  return { ...pending, phase: nextPhase, ...definedFacts(patch) };
}

export interface CommitBackendTransitionParams {
  readonly pending: PendingBackendTransition;
  readonly from: ZCodeExecutionBackend;
  readonly fromProviderId?: string;
  readonly sourceExecutionRef?: string;
  readonly committedAt: number;
}

/**
 * 迁移成功时要写入 meta_json 的补丁：executionBackend 只在这里第一次出现，
 * pendingBackendTransition 在同一次补丁里清空，backendTransitions 追加一条 committed 记录。
 * 调用方必须用单次 syncTaskMeta 整行写入这份补丁，不能拆成两次写。
 */
export function commitBackendTransition(params: CommitBackendTransitionParams): {
  readonly executionBackend: ZCodeExecutionBackend;
  readonly pendingBackendTransition: undefined;
  readonly transitionRecord: BackendTransitionRecord;
} {
  if (params.pending.phase !== "readyToCommit") {
    throw new InvalidBackendTransitionPhaseError(params.pending.phase, "committed");
  }
  const record: BackendTransitionRecord = {
    startedAt: params.pending.requestedAt,
    committedAt: params.committedAt,
    from: params.from,
    to: params.pending.to,
    ...(params.fromProviderId === undefined ? {} : { fromProviderId: params.fromProviderId }),
    ...(params.pending.toProviderId === undefined
      ? {}
      : { toProviderId: params.pending.toProviderId }),
    ...(params.sourceExecutionRef === undefined
      ? {}
      : { sourceExecutionRef: params.sourceExecutionRef }),
    ...definedFacts(params.pending),
    status: "committed",
    ...(params.pending.transcriptRevision === undefined
      ? {}
      : { transcriptRevision: params.pending.transcriptRevision }),
    transcriptCompacted: params.pending.compacted ?? false,
  };
  return {
    executionBackend: params.pending.to,
    pendingBackendTransition: undefined,
    transitionRecord: record,
  };
}

export interface FailBackendTransitionParams {
  readonly pending: PendingBackendTransition;
  readonly from: ZCodeExecutionBackend;
  readonly fromProviderId?: string;
  readonly failureReason: BackendTransitionFailureReason;
  readonly failedAt: number;
}

/**
 * 迁移失败（任何阶段）：executionBackend 完全不写，只清空 pendingBackendTransition 并
 * 追加一条 failed 记录。旧后端从始至终没有被动过，调用方只需要做目标端的 best-effort 清理。
 */
export function failBackendTransition(params: FailBackendTransitionParams): {
  readonly pendingBackendTransition: undefined;
  readonly transitionRecord: BackendTransitionRecord;
} {
  const record: BackendTransitionRecord = {
    startedAt: params.pending.requestedAt,
    failedAt: params.failedAt,
    from: params.from,
    to: params.pending.to,
    ...(params.fromProviderId === undefined ? {} : { fromProviderId: params.fromProviderId }),
    ...(params.pending.toProviderId === undefined
      ? {}
      : { toProviderId: params.pending.toProviderId }),
    ...definedFacts(params.pending),
    status: "failed",
    failureReason: params.failureReason,
    ...(params.pending.transcriptRevision === undefined
      ? {}
      : { transcriptRevision: params.pending.transcriptRevision }),
    transcriptCompacted: params.pending.compacted ?? false,
  };
  return { pendingBackendTransition: undefined, transitionRecord: record };
}

export function appendBackendTransitionRecord(
  existing: BackendTransitionRecord[] | undefined,
  record: BackendTransitionRecord,
): BackendTransitionRecord[] {
  return existing ? [...existing, record] : [record];
}

/**
 * 任务加载时（含应用重启）调用一次。存在 pendingBackendTransition 就说明迁移在提交前
 * 中断——按失败处理，绝不凭「Codex thread 是否存在」推断归属，executionBackend 从始至终
 * 就是权威答案（见 spec「Restart-during-migration」）。没有 pending 时返回 null，
 * 调用方不需要写任何东西。
 */
export function recoverPendingBackendTransitionOnLoad(params: {
  readonly pending: PendingBackendTransition | undefined;
  readonly currentBackend: ZCodeExecutionBackend;
  readonly currentProviderId?: string;
  readonly recoveredAt: number;
}): {
  readonly pendingBackendTransition: undefined;
  readonly transitionRecord: BackendTransitionRecord;
} | null {
  if (!params.pending) return null;
  return failBackendTransition({
    pending: params.pending,
    from: params.currentBackend,
    ...(params.currentProviderId === undefined ? {} : { fromProviderId: params.currentProviderId }),
    failureReason: "restart",
    failedAt: params.recoveredAt,
  });
}
