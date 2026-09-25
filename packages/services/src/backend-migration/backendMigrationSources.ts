// 迁移服务的真实读源与目标端适配器（phase 11，backend-migration.md Amendment 3/4）。
//
// - 段读取器：zcode 段经本连接可信的 Agent scope 做 v4 rows/range（范围由组合器裁剪）；
//   Codex 段经 CodexMigrationBridge 只读重建整个 thread（Codex 只提供正向分页）。
// - Codex 目标端：thread/start + 唯一一次 handoff turn/start，协议语义全部留在 codex 模块。
// - zcode 目标端：确保 task 同 id 的 zcode 会话存在并加载 → 写 model-only 上下文种子 →
//   记录种子边界 → setModel 作为就绪确认（同时生效新 provider）。
import { createHash } from "node:crypto";
import {
  parseModelPickerValue,
  type BackendHandoffEntry,
  type BackendHandoffTranscript,
  type BackendMigrationTaskTarget,
  type BackendTimelineSegmentReader,
} from "@zcode/shared";
import { PROTOCOL_V4_LIMITS, type ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { CodexExecutionPolicy, CodexMigrationBridge } from "#src/codex/contract.js";
import type { IZCodeAgentService } from "#src/zcode-agent/zcodeAgent.js";
import type {
  CodexDestinationDependencies,
  ZCodeDestinationDependencies,
} from "./backendMigrationPorts.js";

export type BackendMigrationAgentService = Pick<
  IZCodeAgentService,
  | "conversationRowsRangeV4"
  | "resumeSession"
  | "createSession"
  | "setModel"
  | "seedBackendHandoff"
  | "removeBackendHandoffSeed"
  | "generateWorkspaceText"
>;

export function agentTargetFor(target: BackendMigrationTaskTarget) {
  return {
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
  };
}

/** 段读取器；Codex thread 在一次读取器生命周期内只重建一次（同一次迁移/同一页请求内复用）。 */
export function createSegmentReader(params: {
  readonly target: BackendMigrationTaskTarget;
  readonly agent: Pick<BackendMigrationAgentService, "conversationRowsRangeV4">;
  readonly codex: Pick<CodexMigrationBridge, "readThreadRows">;
  readonly codexPolicy: CodexExecutionPolicy;
}): BackendTimelineSegmentReader {
  const threadCache = new Map<string, Promise<ConversationRow[]>>();
  return {
    async readBefore({ segment, beforeSourceRowId, limit }) {
      if (segment.source.kind === "codex") {
        const threadId = segment.source.threadId;
        if (!threadId) throw new Error("backend_timeline_codex_segment_without_thread");
        let rows = threadCache.get(threadId);
        if (!rows) {
          rows = params.codex.readThreadRows({ threadId, policy: params.codexPolicy });
          threadCache.set(threadId, rows);
        }
        return { rows: await rows, hasMore: false };
      }
      const result = await params.agent.conversationRowsRangeV4({
        ...agentTargetFor(params.target),
        sessionId: segment.source.sessionId,
        ...(beforeSourceRowId === undefined ? {} : { beforeRowId: beforeSourceRowId }),
        limit: Math.min(Math.max(1, limit), PROTOCOL_V4_LIMITS.rowsRangeMaxLimit),
      });
      return { rows: result.rows, hasMore: result.hasMore };
    },
  };
}

export function hashHandoffTranscript(transcript: BackendHandoffTranscript): string {
  return createHash("sha256")
    .update(JSON.stringify({ entries: transcript.entries, compacted: transcript.compacted }))
    .digest("hex")
    .slice(0, 32);
}

function formatSeedEntry(entry: BackendHandoffEntry): string {
  const label =
    entry.role === "user"
      ? "User"
      : entry.role === "assistant"
        ? "Assistant"
        : entry.role === "tool_summary"
          ? "Action"
          : "Note";
  return `${label}: ${entry.content}`;
}

/**
 * Agent 种子文本：明确这是另一个执行后端上的既有历史，只作上下文，不是新请求。
 * 与 Codex handoff prompt 不同，这里没有模型调用，也就不需要「只回复就绪」的约束。
 */
export function renderAgentSeedText(transcript: BackendHandoffTranscript): string {
  return [
    "<backend_handoff_context>",
    "The following is the prior history of this same task while it was handled by another",
    "execution backend (Codex). It is context only: it is not a new request. Continue the task",
    "from here when the user sends their next message.",
    "",
    ...transcript.entries.map(formatSeedEntry),
    "</backend_handoff_context>",
  ].join("\n");
}

export function createCodexDestination(params: {
  readonly codex: Pick<
    CodexMigrationBridge,
    "startMigrationThread" | "runHandoffTurn" | "abandonThread"
  >;
  readonly handoffTimeoutMs?: number;
}): CodexDestinationDependencies {
  return {
    async createThread({ workspacePath }) {
      const { threadId } = await params.codex.startMigrationThread({ workspacePath });
      return { codexThreadId: threadId };
    },
    async runHandoffTurn({ codexThreadId, prompt }) {
      const outcome = await params.codex.runHandoffTurn({
        threadId: codexThreadId,
        prompt,
        ...(params.handoffTimeoutMs === undefined ? {} : { timeoutMs: params.handoffTimeoutMs }),
      });
      // 没有 Codex 原生 turn id 就无法在重启后把 handoff 轮从时间线里稳定排除——不能提交。
      if (!outcome.turnId) throw new Error("codex_handoff_turn_id_missing");
      return {
        turnId: outcome.turnId,
        reachedNormalTerminalState: outcome.terminal === "success",
        handoffTurnRows: outcome.rows,
        replyText: outcome.replyText,
        unexpectedToolActivity: outcome.toolActivity,
        timedOut: outcome.terminal === "timeout",
      };
    },
    async abandonThread(codexThreadId) {
      params.codex.abandonThread(codexThreadId);
    },
  };
}

export function createZCodeDestination(params: {
  readonly target: BackendMigrationTaskTarget;
  readonly agent: Omit<BackendMigrationAgentService, "generateWorkspaceText">;
  readonly toModelSelection: string;
  /** 与迁移尝试一一对应（requestedAt）；回滚按它删除，重复写同一 seedId 幂等。 */
  readonly seedId: string;
}): ZCodeDestinationDependencies {
  const base = agentTargetFor(params.target);
  // 惰性解析：迁往 Codex 时这组依赖不会被调用，也就不存在 zcode 模型选择。
  const model = () => parseModelPickerValue(params.toModelSelection);
  return {
    async seedHistory({ taskId, transcript }) {
      // task id 就是 zcode sessionId：已存在则加载，不存在（Codex 起源的 task）则按同 id 创建。
      try {
        await params.agent.resumeSession({ ...base, sessionId: taskId });
      } catch {
        await params.agent.createSession({ ...base, sessionId: taskId, model: model() });
      }
      await params.agent.seedBackendHandoff({
        ...base,
        sessionId: taskId,
        seedId: params.seedId,
        text: renderAgentSeedText(transcript),
        // 种子写在 setModel 之前：显式按目标选择标注，避免任务行按种子回退成旧 provider（Amendment 5）。
        model: model(),
      });
      const tail = await params.agent.conversationRowsRangeV4({
        ...base,
        sessionId: taskId,
        limit: 1,
      });
      return { seedLastRowId: tail.rows.at(-1)?.rowId ?? null };
    },
    async startAndConfirmReady({ taskId }) {
      // setModel 返回快照即就绪：会话已加载、目标 provider/model 可用并已生效。
      await params.agent.setModel({ ...base, sessionId: taskId, model: model() });
      return { ready: true };
    },
    async deleteSeededHistory(taskId) {
      await params.agent.removeBackendHandoffSeed({
        ...base,
        sessionId: taskId,
        seedId: params.seedId,
      });
    },
  };
}
