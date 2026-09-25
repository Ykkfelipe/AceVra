// Codex 侧的后端迁移桥（app 层，宿主内部，不经 RPC 暴露）。见 backend-migration.md
// 「zcode → codex」与 Amendment 3/4。
//
// 职责只有四个，全部是 Codex 协议语义，迁移状态机本身不在这里：
// 1. startMigrationThread：用 handoff 专用策略 thread/start 一个尚不属于任何 task 的 thread；
// 2. runHandoffTurn：在该 thread 上跑唯一一次上下文交接 turn/start，收集它的行、Codex turn id、
//    终态，并把任何工具/审批活动判定为「意外工具活动」（审批请求一律当场拒绝）；
// 3. readThreadRows：只读重建某个历史 thread 的行（不注册 runtime、不接受写入），行带 sourceTurnId；
// 4. abandonThread / releaseTaskRuntime：丢弃收集器 / 迁移提交或迁出后丢弃 task 的缓存 runtime。
//
// 为什么 handoff 用 untrusted + read-only：thread/start 的这两个字段已按 Codex App Server schema
// 验证过（codexPolicy.ts）。untrusted 让几乎所有命令都需要审批，而收集器对审批一律拒绝——这是
// 协议层能拿到的机械约束；只读沙箱兜底文件写入。提交后 task runtime 经 thread/resume 冷恢复，
// resume 会重申宿主策略，handoff 策略不会泄漏到后续真实轮次。
import type { CommandAck, ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { codexUnroutableApprovalResponse } from "#src/codex/domain/codexApprovals.js";
import type { CodexExecutionPolicy } from "#src/codex/domain/codexPolicy.js";
import { CodexThreadProjection } from "#src/codex/domain/codexProjection.js";
import { isToolItemKind } from "#src/codex/domain/codexRowLog.js";
import {
  CODEX_METHODS,
  parseCodexNotification,
  scrubCodexErrorDetail,
} from "#src/codex/domain/codexWire.js";
import type { CodexAppServerPort, CodexTaskIndexPort } from "./codexPorts.js";
import { extractCodexTurnId, normalizeHistoryItem, startCodexThread } from "./codexTaskRuntime.js";
import { MAX_HISTORY_PAGES, unwrapThreadItemsPage } from "./codexThreadItemsPage.js";

/** v4 命令拒绝原因：迁移进行中不接受新用户轮（spec Amendment 4「Normal turns during a migration」）。 */
export const BACKEND_TRANSITION_IN_PROGRESS_REASON = "backendTransitionInProgress"; // 与 zcode 栅栏同一拒绝码

/**
 * 迁移进行中：新用户轮既不能进旧后端也不能进目标后端（spec Amendment 4），
 * 返回带类型的拒绝，renderer 保留草稿。无 pending 返回 null。
 */
export async function rejectCodexSendDuringBackendTransition(params: {
  readonly taskIndex: Pick<CodexTaskIndexPort, "getTaskMeta">;
  readonly taskId: string;
  readonly commandId: string;
}): Promise<CommandAck | null> {
  const meta = await params.taskIndex.getTaskMeta({ taskId: params.taskId });
  if (!meta?.pendingBackendTransition) return null;
  return {
    commandId: params.commandId,
    status: "rejected",
    revisionAtDecision: 0,
    reasonCode: BACKEND_TRANSITION_IN_PROGRESS_REASON,
    message: "A backend switch is in progress for this task",
  };
}

/** 直接 API（sendTurn）版本：迁移进行中抛出带拒绝码的错误。 */
export async function assertNoCodexBackendTransition(
  taskIndex: Pick<CodexTaskIndexPort, "getTaskMeta">,
  taskId: string,
): Promise<void> {
  if (await rejectCodexSendDuringBackendTransition({ taskIndex, taskId, commandId: "" })) {
    throw new Error(BACKEND_TRANSITION_IN_PROGRESS_REASON);
  }
}

/** handoff 专用策略：审批全开 + 只读沙箱；收集器拒绝一切审批。 */
export const CODEX_HANDOFF_POLICY: CodexExecutionPolicy = {
  approvalPolicy: "untrusted",
  sandbox: "read-only",
};

const DEFAULT_HANDOFF_TIMEOUT_MS = 5 * 60_000;

export type CodexHandoffTerminal = "success" | "interrupted" | "failed" | "timeout";

export interface CodexHandoffTurnOutcome {
  /** Codex 原生 turn id；turn/start 未返回且通知也未给出时为 null。 */
  readonly turnId: string | null;
  readonly terminal: CodexHandoffTerminal;
  readonly rows: readonly ConversationRow[];
  readonly replyText: string;
  /** 任何工具 item 或审批请求出现即为 true——不是干净的上下文初始化。 */
  readonly toolActivity: boolean;
  readonly errorMessage: string | null;
}

export interface CodexMigrationBridge {
  startMigrationThread(params: {
    workspacePath: string;
    modelId?: string;
  }): Promise<{ threadId: string }>;
  runHandoffTurn(params: {
    threadId: string;
    prompt: string;
    timeoutMs?: number;
  }): Promise<CodexHandoffTurnOutcome>;
  abandonThread(threadId: string): void;
  /** 只读：按 thread/items/list 重建（先 thread/resume 以宿主策略加载）。读取失败抛错，绝不静默返回空段。 */
  readThreadRows(params: {
    threadId: string;
    policy: CodexExecutionPolicy;
  }): Promise<ConversationRow[]>;
  /** 迁移提交/迁出后丢弃 task 的缓存 runtime；下次访问按持久化绑定冷恢复。 */
  releaseTaskRuntime(taskId: string): void;
  /** 通知扇入钩子：属于在途 handoff thread 的通知/请求由这里独占处理，返回 true。 */
  handleNotification(
    method: string,
    params: unknown,
    rawRequest?: { method: string; params: unknown; rawId: number },
  ): boolean;
  dispose(): void;
}

interface HandoffCollector {
  readonly projection: CodexThreadProjection;
  turnId: string | null;
  toolActivity: boolean;
  settle: ((terminal: CodexHandoffTerminal, errorMessage: string | null) => void) | null;
}

function threadIdOf(params: unknown): string | null {
  const record =
    typeof params === "object" && params !== null ? (params as Record<string, unknown>) : null;
  const value = record?.threadId ?? record?.thread_id;
  return typeof value === "string" && value.trim() ? value : null;
}

export function createCodexMigrationBridge(deps: {
  readonly bridge: CodexAppServerPort;
  readonly now: () => number;
  readonly releaseTaskRuntime: (taskId: string) => void;
}): CodexMigrationBridge {
  const collectors = new Map<string, HandoffCollector>();

  function collectorFor(threadId: string): HandoffCollector {
    const existing = collectors.get(threadId);
    if (existing) return existing;
    const created: HandoffCollector = {
      projection: new CodexThreadProjection("codex-migration", deps.now),
      turnId: null,
      toolActivity: false,
      settle: null,
    };
    collectors.set(threadId, created);
    return created;
  }

  return {
    async startMigrationThread(params) {
      const report = await startCodexThread(deps.bridge, {
        workspacePath: params.workspacePath,
        policy: CODEX_HANDOFF_POLICY,
        ...(params.modelId ? { modelId: params.modelId } : {}),
      });
      // 先建收集器：thread/start 返回前后到达的通知都归它，不进 task 路由缓冲。
      collectorFor(report.threadId);
      return { threadId: report.threadId };
    },

    async runHandoffTurn(params) {
      const collector = collectorFor(params.threadId);
      const done = new Promise<{ terminal: CodexHandoffTerminal; errorMessage: string | null }>(
        (resolve) => {
          collector.settle = (terminal, errorMessage) => resolve({ terminal, errorMessage });
        },
      );
      collector.projection.beginUserTurn({
        text: params.prompt,
        turnId: "backend-handoff",
        commandId: `backend-handoff-${params.threadId}`,
      });
      let result: unknown;
      try {
        result = await deps.bridge.call(CODEX_METHODS.turnStart, {
          threadId: params.threadId,
          input: [{ type: "text", text: params.prompt }],
        });
      } catch (error) {
        collector.settle = null;
        throw new Error(scrubCodexErrorDetail(`codex_handoff_turn_start_failed: ${String(error)}`));
      }
      const startedTurnId = extractCodexTurnId(result);
      if (startedTurnId) {
        collector.turnId = startedTurnId;
        collector.projection.bindSourceTurnId(startedTurnId);
      }
      const timeoutMs = params.timeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<{ terminal: CodexHandoffTerminal; errorMessage: string | null }>(
        (resolve) => {
          timer = setTimeout(() => resolve({ terminal: "timeout", errorMessage: null }), timeoutMs);
        },
      );
      const settled = await Promise.race([done, timedOut]);
      if (timer) clearTimeout(timer);
      collector.settle = null;
      if (settled.terminal === "timeout" && collector.turnId) {
        // 超时的 handoff 轮必须停下，不能在一个将被放弃的 thread 上继续消耗。
        await deps.bridge
          .call(CODEX_METHODS.turnInterrupt, {
            threadId: params.threadId,
            turnId: collector.turnId,
          })
          .catch(() => undefined);
      }
      const rows = [...collector.projection.rows];
      const replyText = rows
        .filter((row) => row.kind === "assistantText")
        .map((row) => (row.kind === "assistantText" ? row.text : ""))
        .join("\n");
      return {
        turnId: collector.turnId,
        terminal: settled.terminal,
        rows,
        replyText,
        toolActivity: collector.toolActivity || rows.some((row) => row.kind === "toolCall"),
        errorMessage: settled.errorMessage,
      };
    },

    abandonThread(threadId) {
      // Codex 协议没有 thread 归档/删除方法；未被任何 task 引用的 thread 丢弃收集器即可。
      collectors.get(threadId)?.settle?.("interrupted", "abandoned");
      collectors.delete(threadId);
    },

    async readThreadRows(params) {
      await deps.bridge.call(CODEX_METHODS.threadResume, {
        threadId: params.threadId,
        approvalPolicy: params.policy.approvalPolicy,
        sandbox: params.policy.sandbox,
        excludeTurns: true,
      });
      const projection = new CodexThreadProjection("codex-history-read", deps.now);
      let cursor: string | null = null;
      for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
        const result = await deps.bridge.call(
          CODEX_METHODS.threadItemsList,
          cursor ? { threadId: params.threadId, cursor } : { threadId: params.threadId },
        );
        const { items, nextCursor } = unwrapThreadItemsPage(result);
        for (const entry of items) {
          const normalized = normalizeHistoryItem(entry);
          if (normalized) projection.replayCompletedItem(normalized.item, normalized.turnId);
        }
        cursor = nextCursor;
        if (!cursor) return [...projection.rows];
      }
      throw new Error(`codex_thread_history_paging_exceeded: ${params.threadId}`);
    },

    releaseTaskRuntime(taskId) {
      deps.releaseTaskRuntime(taskId);
    },

    handleNotification(method, params, rawRequest) {
      const threadId = threadIdOf(rawRequest?.params ?? params);
      if (!threadId) return false;
      const collector = collectors.get(threadId);
      if (!collector) return false;
      if (rawRequest) {
        // handoff 轮不允许任何动作：审批一律按 schema 真形拒绝，并记为意外工具活动。
        if (rawRequest.method.includes("requestApproval")) {
          collector.toolActivity = true;
          deps.bridge.respond(rawRequest.rawId, codexUnroutableApprovalResponse(rawRequest.method));
        }
        return true;
      }
      const notification = parseCodexNotification(method, params);
      if (notification.type === "turnStarted" && notification.turnId) {
        collector.turnId ??= notification.turnId;
      }
      if (
        (notification.type === "itemStarted" || notification.type === "itemCompleted") &&
        isToolItemKind(notification.item.kind)
      ) {
        collector.toolActivity = true;
      }
      collector.projection.applyNotification(notification);
      if (notification.type === "turnCompleted") {
        const terminal: CodexHandoffTerminal =
          notification.outcome === "success"
            ? "success"
            : notification.outcome === "interrupted"
              ? "interrupted"
              : "failed";
        collector.settle?.(
          terminal,
          notification.errorMessage ? scrubCodexErrorDetail(notification.errorMessage) : null,
        );
      }
      return true;
    },

    dispose() {
      for (const collector of collectors.values()) collector.settle?.("interrupted", "disposed");
      collectors.clear();
    },
  };
}
