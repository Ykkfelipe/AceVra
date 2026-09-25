// 后端迁移的共享契约（phase 11，见 packages/services/specs/backend-migration.md）。
//
// SECURITY BOUNDARY：与 codex-execution.ts 同一边界——这里描述的是任务级迁移状态和归一化
// transcript 的形状，不是凭据。sourceExecutionRef/destinationExecutionRef 只是不透明标识
// （如 codexThreadId），绝不允许塞入 token、auth.json 内容或原始 server-request 信封。
//
// 状态机只有 5 个阶段，"committed" 从不作为静止态被读到——commit 写入与清空
// pendingBackendTransition 是同一次 syncTaskMeta 调用；持久层要么看到前 4 个阶段之一
// （迁移进行中或中途崩溃），要么看到 pendingBackendTransition 缺失 + 新的
// backendTransitions 记录（迁移已经有结果）。
import { z } from "zod";
import { ZCODE_EXECUTION_BACKENDS, type ZCodeExecutionBackend } from "./codex-execution.js";

/** 与 ZCodeExecutionBackend 的字面量联合保持同步；联合类型改动时这里会编译报错。 */
export const zcodeExecutionBackendSchema: z.ZodType<ZCodeExecutionBackend> = z.enum(
  ZCODE_EXECUTION_BACKENDS as [ZCodeExecutionBackend, ...ZCodeExecutionBackend[]],
);

export const BACKEND_TRANSITION_PHASES = [
  "prepared",
  "destinationCreated",
  "handoffRunning",
  "readyToCommit",
  "committed",
] as const;
export type BackendTransitionPhase = (typeof BACKEND_TRANSITION_PHASES)[number];
export const backendTransitionPhaseSchema = z.enum(BACKEND_TRANSITION_PHASES);

export const BACKEND_HANDOFF_ENTRY_ROLES = [
  "user",
  "assistant",
  "tool_summary",
  "task_note",
] as const;
export type BackendHandoffEntryRole = (typeof BACKEND_HANDOFF_ENTRY_ROLES)[number];
export const backendHandoffEntryRoleSchema = z.enum(BACKEND_HANDOFF_ENTRY_ROLES);

/** 归一化 transcript 的一条条目。tool_summary 只携带一行结果描述，绝不携带原始 tool 输出。 */
export interface BackendHandoffEntry {
  readonly role: BackendHandoffEntryRole;
  readonly content: string;
  readonly timestamp?: number;
}
export const backendHandoffEntrySchema = z.object({
  role: backendHandoffEntryRoleSchema,
  content: z.string(),
  timestamp: z.number().int().nonnegative().optional(),
});

/** 跨后端边界传递的唯一产物；两个方向的转换器都以此为目标/来源形状。 */
export interface BackendHandoffTranscript {
  readonly taskId: string;
  readonly generatedAt: number;
  readonly sourceBackend: ZCodeExecutionBackend;
  readonly entries: readonly BackendHandoffEntry[];
  readonly compacted: boolean;
}
export const backendHandoffTranscriptSchema = z.object({
  taskId: z.string().min(1),
  generatedAt: z.number().int().nonnegative(),
  sourceBackend: zcodeExecutionBackendSchema,
  entries: z.array(backendHandoffEntrySchema),
  compacted: z.boolean(),
});

export const BACKEND_TRANSITION_STATUSES = ["committed", "failed"] as const;
export type BackendTransitionStatus = (typeof BACKEND_TRANSITION_STATUSES)[number];
export const backendTransitionStatusSchema = z.enum(BACKEND_TRANSITION_STATUSES);

/** 迁移完成后追加进 ZCodeTaskMeta.backendTransitions 的一条只读时间线记录。 */
export interface BackendTransitionRecord {
  readonly startedAt: number;
  readonly committedAt?: number;
  readonly failedAt?: number;
  readonly from: ZCodeExecutionBackend;
  readonly to: ZCodeExecutionBackend;
  readonly fromProviderId?: string;
  readonly toProviderId?: string;
  /**
   * 进入 zcode 时：提交写入的完整模型选择（picker 值，含 reasoning level）。composer 在布局变化时
   * 据此重新投影已有 task 的 Agent 选择（Amendment 5）；不能用 meta.model 代替——同步写入的值会丢掉
   * reasoning level，而 Azure 等 provider 必须带它。
   */
  readonly toModelSelection?: string;
  readonly sourceExecutionRef?: string;
  readonly destinationExecutionRef?: string;
  readonly status: BackendTransitionStatus;
  readonly failureReason?: string;
  readonly transcriptRevision?: string;
  readonly transcriptCompacted: boolean;
  /** 目标是 Codex 时：handoff 轮的 Codex 原生 turn id（稳定，重启后仍可识别）。 */
  readonly handoffTurnId?: string;
  /**
   * 离开 zcode 时：被关闭的 Agent 段在 zcode 会话里的首/末 rowId（含）。zcode rowId 是持久事件
   * 日志的确定性函数，重启后不变，因此可以作为段边界（Amendment 4）。null = 该段没有行。
   */
  readonly sourceFirstRowId?: number | null;
  readonly sourceLastRowId?: number | null;
  /**
   * 进入 zcode 时：种子历史写完后 zcode 会话的最后 rowId。≤ 它的行要么属于更早的 Agent 段，
   * 要么是迁移种子（上下文输入，不是可见副本）；新 Agent 段严格从它之后开始。
   */
  readonly destinationSeedLastRowId?: number | null;
}
export const backendTransitionRecordSchema = z.object({
  startedAt: z.number().int().nonnegative(),
  committedAt: z.number().int().nonnegative().optional(),
  failedAt: z.number().int().nonnegative().optional(),
  from: zcodeExecutionBackendSchema,
  to: zcodeExecutionBackendSchema,
  fromProviderId: z.string().optional(),
  toProviderId: z.string().optional(),
  toModelSelection: z.string().optional(),
  sourceExecutionRef: z.string().optional(),
  destinationExecutionRef: z.string().optional(),
  status: backendTransitionStatusSchema,
  failureReason: z.string().optional(),
  transcriptRevision: z.string().optional(),
  transcriptCompacted: z.boolean(),
  handoffTurnId: z.string().optional(),
  sourceFirstRowId: z.number().nullable().optional(),
  sourceLastRowId: z.number().nullable().optional(),
  destinationSeedLastRowId: z.number().nullable().optional(),
});

/**
 * 迁移进行中的唯一权威标记；出现即代表 executionBackend 尚未变更。
 * 见 backend-migration.md「Restart-during-migration」：读取顺序永远是先看 executionBackend，
 * pendingBackendTransition 只用来在崩溃后把「进行中」判定为「失败」，从不用来判定归属。
 */
export interface PendingBackendTransition {
  readonly phase: BackendTransitionPhase;
  readonly to: ZCodeExecutionBackend;
  readonly toProviderId?: string;
  /** 与 BackendTransitionRecord.toModelSelection 同义；begin 时写入，commit/fail 时原样进入记录。 */
  readonly toModelSelection?: string;
  readonly requestedAt: number;
  readonly transcriptRevision?: string;
  readonly compacted?: boolean;
  readonly destinationExecutionRef?: string;
  readonly handoffTurnId?: string;
  /** 与 BackendTransitionRecord 同名字段同义；一旦知道就随阶段落盘，commit 时原样进入记录。 */
  readonly sourceFirstRowId?: number | null;
  readonly sourceLastRowId?: number | null;
  readonly destinationSeedLastRowId?: number | null;
  /**
   * 发起迁移的 Host 实例（`<pid>:<bootUuid>`）。tasks-index 由多个窗口 Host 共享：
   * 重启恢复只允许清理「所有者已不存活」的 pending，绝不能从另一个存活 Host 手里抢走在途迁移
   * （见 spec Amendment 3）。旧数据缺省视为所有者未知 → 按孤儿处理。
   */
  readonly ownerInstanceId?: string;
}
export const pendingBackendTransitionSchema = z.object({
  phase: backendTransitionPhaseSchema,
  to: zcodeExecutionBackendSchema,
  toProviderId: z.string().optional(),
  toModelSelection: z.string().optional(),
  requestedAt: z.number().int().nonnegative(),
  transcriptRevision: z.string().optional(),
  compacted: z.boolean().optional(),
  destinationExecutionRef: z.string().optional(),
  handoffTurnId: z.string().optional(),
  sourceFirstRowId: z.number().nullable().optional(),
  sourceLastRowId: z.number().nullable().optional(),
  destinationSeedLastRowId: z.number().nullable().optional(),
  ownerInstanceId: z.string().optional(),
});

/** Codex handoff turn 的可识别就绪标记；作为强信号，而非唯一判据（见 spec）。 */
export const BACKEND_HANDOFF_READY_MARKER = "ACEVRA_HANDOFF_READY";

export const BACKEND_TRANSITION_FAILURE_REASONS = [
  "destination_create_failed",
  "handoff_turn_error",
  "handoff_turn_timeout",
  "unexpected_tool_activity_in_handoff",
  "compaction_failed",
  "destination_not_ready",
  "restart",
  "concurrent_transition",
  "persistence_failed",
  "turn_in_progress",
  "source_read_failed",
] as const;
export type BackendTransitionFailureReason = (typeof BACKEND_TRANSITION_FAILURE_REASONS)[number];

// ── 迁移应用服务的 RPC 契约（backend-migration.md Amendment 4「Read vs write authority」）──
// UI 只能发起「把这个 task 切到目标后端/provider」这一个写操作，并观察持久化的迁移结果；
// executionBackend / providerId / codexThreadId / 迁移元数据都只由服务端事务写入。
// 视图里不含 Codex thread id：历史段由 Host 按段下标从持久化 meta 解析读源，UI 无法指定任意 thread。

export interface BackendMigrationTaskTarget {
  readonly taskId: string;
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly remoteSessionId?: string;
}

export interface SwitchTaskBackendParams extends BackendMigrationTaskTarget {
  readonly to: ZCodeExecutionBackend;
  /** 迁往 zcode 时必填：完整模型选择 picker 值（`provider/model[:reasoning]`）。 */
  readonly toModelSelection?: string;
}

/** 公开安全的迁移记录视图（无 thread id / 源 rowId / transcript 内容）。 */
export interface BackendTransitionView {
  readonly index: number;
  readonly from: ZCodeExecutionBackend;
  readonly to: ZCodeExecutionBackend;
  readonly fromProviderId?: string;
  readonly toProviderId?: string;
  /** 进入 zcode 时提交的完整模型选择（picker 值）；composer 重新投影的唯一来源。 */
  readonly toModelSelection?: string;
  readonly status: BackendTransitionStatus;
  readonly failureReason?: string;
  readonly startedAt: number;
  readonly committedAt?: number;
  readonly failedAt?: number;
  readonly transcriptCompacted: boolean;
  /** Codex 方向且 handoff 轮已跑过：可展开「Show handoff details」。 */
  readonly hasHandoffDetails: boolean;
}

export const SWITCH_TASK_BACKEND_REJECTIONS = [
  "task_not_found",
  "same_backend",
  "turn_in_progress",
  "concurrent_transition",
  "destination_unavailable",
  "invalid_destination",
] as const;
export type SwitchTaskBackendRejection = (typeof SWITCH_TASK_BACKEND_REJECTIONS)[number];

export type SwitchTaskBackendResult =
  | {
      readonly outcome: "committed";
      readonly transition: BackendTransitionView;
      readonly layoutVersion: number;
    }
  | {
      readonly outcome: "failed";
      readonly transition: BackendTransitionView;
      readonly recordPersisted: boolean;
    }
  | { readonly outcome: "inDoubt" }
  | { readonly outcome: "rejected"; readonly reason: SwitchTaskBackendRejection };

/** 段的可见性规则（与 BackendTimelineSegmentSource 同义，但 Codex 段不暴露 thread id）。 */
export type BackendTimelineSegmentVisibility =
  | { readonly kind: "zcode"; readonly afterRowId?: number; readonly throughRowId?: number }
  | { readonly kind: "codex"; readonly hiddenSourceTurnIds: readonly string[] };

export interface BackendTimelineSegmentView {
  readonly index: number;
  readonly backend: ZCodeExecutionBackend;
  readonly providerId?: string;
  readonly live: boolean;
  readonly openedByTransitionIndex?: number;
  readonly visibility: BackendTimelineSegmentVisibility;
}

export interface TaskTimelineView {
  readonly taskId: string;
  /** 写权限：只有它接受新轮次。 */
  readonly executionBackend: ZCodeExecutionBackend;
  readonly layoutVersion: number;
  /**
   * 组合时间线全序第一行的 rowId（layoutVersion > 0 时由 Host 给出）。store 用「窗口首行是否等于
   * firstRowId」判定是否还能向上翻页，必须精确，不能用下界估计（否则永远显示「加载更早」）。
   */
  readonly firstComposedRowId?: number;
  readonly segments: readonly BackendTimelineSegmentView[];
  readonly transitions: readonly BackendTransitionView[];
  readonly pending?: {
    readonly phase: BackendTransitionPhase;
    readonly to: ZCodeExecutionBackend;
    readonly toProviderId?: string;
    readonly requestedAt: number;
  };
}

export interface ReadTimelineSegmentRowsParams extends BackendMigrationTaskTarget {
  /** 调用方持有的布局版本；与服务端不一致时拒绝（布局已被新的提交改变）。 */
  readonly layoutVersion: number;
  readonly segmentIndex: number;
  readonly beforeSourceRowId?: number;
  readonly limit: number;
}

export interface ReadHandoffDetailsParams extends BackendMigrationTaskTarget {
  readonly transitionIndex: number;
}

/** 任务后端归属/迁移状态变化（开始、阶段推进、提交、失败、恢复）；UI 据此刷新布局与路由。 */
export interface TaskBackendChangedEvent {
  readonly taskId: string;
  readonly workspaceKey: string;
  readonly layoutVersion: number;
  readonly executionBackend: ZCodeExecutionBackend;
  readonly pendingPhase: BackendTransitionPhase | null;
}

export function toBackendTransitionView(
  record: BackendTransitionRecord,
  index: number,
): BackendTransitionView {
  return {
    index,
    from: record.from,
    to: record.to,
    ...(record.fromProviderId === undefined ? {} : { fromProviderId: record.fromProviderId }),
    ...(record.toProviderId === undefined ? {} : { toProviderId: record.toProviderId }),
    ...(record.toModelSelection === undefined ? {} : { toModelSelection: record.toModelSelection }),
    status: record.status,
    ...(record.failureReason === undefined ? {} : { failureReason: record.failureReason }),
    startedAt: record.startedAt,
    ...(record.committedAt === undefined ? {} : { committedAt: record.committedAt }),
    ...(record.failedAt === undefined ? {} : { failedAt: record.failedAt }),
    transcriptCompacted: record.transcriptCompacted,
    hasHandoffDetails: record.to === "codex" && record.handoffTurnId !== undefined,
  };
}
