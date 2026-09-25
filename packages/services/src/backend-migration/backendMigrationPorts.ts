// 后端迁移编排的依赖端口与结果类型（phase 11）。与编排逻辑分文件：编排时序在
// backendMigrationOrchestrator.ts，这里只声明它依赖外部世界的形状——真实适配器（TaskIndexRepo、
// Codex bridge、zcode-cli）实现这些端口，测试用假实现替换。见 backend-migration.md Amendment 3。
import type {
  BackendHandoffTranscript,
  BackendTransitionRecord,
  PendingBackendTransition,
  ZCodeExecutionBackend,
} from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type {
  HandoffCompactionBudget,
  SummarizeHandoffPrefix,
} from "./backendHandoffCompaction.js";

export interface BackendMigrationTaskState {
  readonly executionBackend: ZCodeExecutionBackend;
  readonly providerId?: string;
  /** 当前 executionBackend 侧的执行标识（如离开 Codex 时正在使用的 codexThreadId）。 */
  readonly sourceExecutionRef?: string;
  readonly pendingBackendTransition?: PendingBackendTransition;
  readonly backendTransitions?: readonly BackendTransitionRecord[];
}

export interface BackendMigrationRequest {
  readonly taskId: string;
  readonly sessionId: string;
  readonly to: ZCodeExecutionBackend;
  readonly toProviderId?: string;
  /** 迁往 zcode 时的完整模型选择（picker 值 `provider/model[:reasoning]`）；commit 时写入。 */
  readonly toModelSelection?: string;
}

/** 目标是 Codex 时才需要的依赖；目标是 zcode 时才需要的依赖——迁移方向决定用哪一组。 */
export interface CodexDestinationDependencies {
  readonly createThread: (params: {
    taskId: string;
    title: string;
    workspacePath: string;
  }) => Promise<{ codexThreadId: string }>;
  readonly runHandoffTurn: (params: { codexThreadId: string; prompt: string }) => Promise<{
    turnId: string;
    reachedNormalTerminalState: boolean;
    handoffTurnRows: readonly ConversationRow[];
    replyText: string;
    /** 协议层观察到的工具/审批活动（审批请求被拒绝时不一定留下 toolCall 行）。 */
    unexpectedToolActivity?: boolean;
    /** 非正常终态是否为超时（否则按 handoff_turn_error 记）。 */
    timedOut?: boolean;
  }>;
  /** best-effort：失败/异常都只记日志，绝不让清理本身的失败掩盖真正的迁移失败原因。 */
  readonly abandonThread: (codexThreadId: string) => Promise<void>;
}

export interface ZCodeDestinationDependencies {
  /**
   * 把归一化 transcript 作为上下文种子写进该 task 的 zcode 会话，返回写完后会话的最后 rowId。
   * ≤ 它的行在可见时间线里一律不渲染（种子是上下文输入，不是可见副本，Amendment 4）。
   */
  readonly seedHistory: (params: {
    taskId: string;
    transcript: BackendHandoffTranscript;
  }) => Promise<{ seedLastRowId: number | null }>;
  readonly startAndConfirmReady: (params: {
    taskId: string;
    providerId: string;
  }) => Promise<{ ready: boolean }>;
  /** 失败回滚：删掉这次失败尝试写入的 seed 行，不留下重复的历史。 */
  readonly deleteSeededHistory: (taskId: string) => Promise<void>;
}

/** 提交时写入的后端归属字段；只有 finish(commit) 会携带。 */
export interface BackendMigrationCommitFields {
  readonly executionBackend: ZCodeExecutionBackend;
  /** 迁入 Codex：新 thread id；迁出 Codex：undefined（不再指向任何 thread）。 */
  readonly codexThreadId: string | undefined;
  /** 迁往 zcode 时的新模型选择；迁往 Codex 时省略（保留 zcode 侧最后的选择）。 */
  readonly modelSelection?: string;
}

/**
 * 任务行的迁移写入端口（spec Amendment 3）。真实实现是 TaskIndexRepo 的栅栏写入：
 * - begin：库内已有 pending 时抛 ConcurrentBackendTransitionError（跨 Host 生效）；
 * - advance/finish：库内 pending 已不是这次迁移（requestedAt + ownerInstanceId）时抛
 *   BackendTransitionOwnershipLostError，且不写任何东西；
 * - finish 的时间线追加在持久层事务内基于库内当前列表完成，这里只给出新记录。
 */
export interface BackendMigrationTaskStore {
  readonly begin: (taskId: string, pending: PendingBackendTransition) => Promise<void>;
  readonly advance: (taskId: string, pending: PendingBackendTransition) => Promise<void>;
  readonly finish: (
    taskId: string,
    pending: PendingBackendTransition,
    outcome: { record: BackendTransitionRecord; commit?: BackendMigrationCommitFields },
  ) => Promise<void>;
  /** 提交写入抛错（结果不确定）时回读真实落盘状态。 */
  readonly read: (taskId: string) => Promise<BackendMigrationTaskState>;
}

export interface BackendMigrationDependencies {
  readonly now: () => number;
  /** 本 Host 实例身份，写进 pending 作为栅栏的一半（另一半是 requestedAt）。 */
  readonly ownerInstanceId: string;
  readonly generateTranscriptRevision: (transcript: BackendHandoffTranscript) => string;
  /**
   * 读取 task 的规范可见时间线（跨全部已提交段组合，handoff 轮与种子已排除），并给出 live 段
   * 在源后端里的行边界——离开 zcode 时它就是被关闭 Agent 段的 [first, last]（Amendment 4）。
   */
  readonly readSourceHistory: (request: BackendMigrationRequest) => Promise<{
    readonly rows: readonly ConversationRow[];
    readonly liveSegment: { readonly firstRowId: number | null; readonly lastRowId: number | null };
  }>;
  readonly resolveDestinationBudget: (request: BackendMigrationRequest) => HandoffCompactionBudget;
  readonly summarizePrefix: SummarizeHandoffPrefix;
  readonly codex: CodexDestinationDependencies;
  readonly zcode: ZCodeDestinationDependencies;
  readonly workspacePath: string;
  readonly taskTitle: string;
  readonly store: BackendMigrationTaskStore;
}

export type BackendMigrationResult =
  | { readonly outcome: "committed"; readonly record: BackendTransitionRecord }
  | {
      readonly outcome: "failed";
      readonly record: BackendTransitionRecord;
      /** 失败记录是否确认落盘；持久化本身失败或所有权已丢失时为 false。 */
      readonly recordPersisted: boolean;
    }
  | {
      /** 提交写入抛错且回读也失败：不清理目标端，交给重启恢复按栅栏确定性收敛。 */
      readonly outcome: "inDoubt";
      readonly record: BackendTransitionRecord;
    };
