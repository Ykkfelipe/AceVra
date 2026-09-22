// Codex 任务运行时（app 层）：一个 harness task 对应一个 Codex thread runtime。
// 职责：thread 生命周期（start/resume）、bridge 通知归约、按需从 Codex 重建行日志。
// 代数（generation） fencing：runtime 记录创建时的 bridge generation，换代即 stale，
// stale runtime 不得再向旧进程语义投递，重建时以新代数重建投影（logEpoch 随之更换）。
import type { ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import { CodexThreadProjection } from "#src/codex/domain/codexProjection.js";
import type { CodexProjectionCommit } from "#src/codex/domain/codexProjection.js";
import {
  CODEX_METHODS,
  parseCodexNotification,
  parseCodexServerRequest,
  type CodexItem,
} from "#src/codex/domain/codexWire.js";
import type { CodexAppServerPort } from "./codexPorts.js";

interface CodexTaskRuntimeParams {
  readonly taskId: string;
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly codexThreadId: string;
  readonly bridgeGeneration: number;
}

export class CodexTaskRuntime {
  readonly taskId: string;
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  codexThreadId: string;
  /** 创建/重建时的 bridge generation；与 bridge.generation 不等即 stale。 */
  bridgeGeneration: number;
  projection: CodexThreadProjection;
  /** 服务器请求 id → interactionId 的反查表（仅活订阅期）。 */
  turnCounter = 0;

  constructor(params: CodexTaskRuntimeParams, now: () => number) {
    this.taskId = params.taskId;
    this.workspacePath = params.workspacePath;
    this.workspaceIdentity = params.workspaceIdentity;
    this.codexThreadId = params.codexThreadId;
    this.bridgeGeneration = params.bridgeGeneration;
    this.projection = new CodexThreadProjection(this.logEpochFor(params.bridgeGeneration), now);
  }

  logEpochFor(generation: number): string {
    return `codex-${generation}`;
  }

  isStale(bridge: CodexAppServerPort): boolean {
    return this.bridgeGeneration !== bridge.generation;
  }

  buildFrame(params: {
    subscriptionId: string;
    payload: ConversationTopicFrame["payload"];
    /** 区间记账 (fromSeq, toSeq]；snapshot 帧固定 0，deltas 帧 = commit 前水位。 */
    fromSeq: number;
    toSeq: number;
  }): ConversationTopicFrame {
    return {
      topic: `conversation/${this.taskId}`,
      subscriptionId: params.subscriptionId,
      fromSeq: params.fromSeq,
      toSeq: params.toSeq,
      sentAt: Date.now(),
      payload: params.payload,
    };
  }
}

/** 从 thread/start、thread/resume 的返回中容错提取 thread id。 */
function extractCodexThreadId(result: unknown): string | null {
  if (typeof result !== "object" || result === null) {
    return typeof result === "string" && result.trim() ? result : null;
  }
  const record = result as Record<string, unknown>;
  const candidates = [record.threadId, record.thread_id, record.id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  const thread = record.thread;
  if (typeof thread === "object" && thread !== null) {
    const nested = thread as Record<string, unknown>;
    for (const candidate of [nested.id, nested.threadId, nested.thread_id]) {
      if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
  }
  return null;
}

/** 启动一个新的 Codex thread（thread/start）；账号门禁在这里 fail closed。 */
export async function startCodexThread(
  bridge: CodexAppServerPort,
  params: { workspacePath: string },
): Promise<string> {
  const account = (await bridge.call("account/read", {})) as {
    account?: unknown;
    requiresOpenaiAuth?: boolean;
  } | null;
  if (!account?.account) {
    throw new Error("codex_not_signed_in");
  }
  // thread/start 的参数面在 E2E 前无法完全确认；最小面 + cwd，模型走 Codex 自身默认。
  const result = await bridge.call(CODEX_METHODS.threadStart, { cwd: params.workspacePath });
  const threadId = extractCodexThreadId(result);
  if (!threadId) throw new Error("codex_thread_start_missing_id");
  return threadId;
}

/** 恢复既有 thread（thread/resume）；返回 Codex 采纳的 thread id（取不到则沿用原 id）。 */
export async function resumeCodexThread(
  bridge: CodexAppServerPort,
  threadId: string,
): Promise<string> {
  const result = await bridge.call(CODEX_METHODS.threadResume, { threadId });
  // resume 返回可能只是请求回显；只在明确的 thread 字段出现时才采纳新 id。
  if (typeof result === "object" && result !== null) {
    const record = result as Record<string, unknown>;
    const thread = typeof record.thread === "object" && record.thread !== null ? (record.thread as Record<string, unknown>) : null;
    for (const candidate of [record.threadId, record.thread_id, thread?.id]) {
      if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
  }
  return threadId;
}

/**
 * 从 Codex 分页 items 重建投影（重启后 subscribe 的恢复路径）。
 * 形状未在 E2E 前确认：接受数组 / {items} / {data}，逐条落终态行。
 * 恢复失败不阻塞订阅：投影保持已恢复部分，turn 事件照常走。
 */
export async function rebuildProjectionFromCodex(
  bridge: CodexAppServerPort,
  threadId: string,
  projection: CodexThreadProjection,
): Promise<void> {
  let result: unknown;
  try {
    result = await bridge.call(CODEX_METHODS.threadItemsList, { threadId });
  } catch {
    return;
  }
  const record = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : null;
  const items: unknown[] = Array.isArray(result)
    ? result
    : Array.isArray(record?.items)
      ? (record?.items as unknown[])
      : Array.isArray(record?.data)
        ? (record?.data as unknown[])
        : [];
  for (const entry of items) {
    const item = normalizeHistoryItem(entry);
    if (!item) continue;
    // 冷恢复直接落终态行：不要求先出现过 itemStarted。
    projection.replayCompletedItem(item);
  }
}

function normalizeHistoryItem(entry: unknown): CodexItem | null {
  // E2E 观察：thread/items/list 的条目是 {turnId, item:{type,…}} 包装；容错回退裸 item。
  const record = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : null;
  const unwrapped = record?.item ?? entry;
  const parsed = parseCodexNotification("item/completed", { item: unwrapped });
  if (parsed.type !== "itemCompleted") return null;
  return parsed.item;
}

/** 解析并路由一条 bridge 通知；返回归约结果供服务层发帧。 */
export function routeCodexNotification(
  runtime: CodexTaskRuntime,
  method: string,
  params: unknown,
  rawRequest: { method: string; params: unknown; rawId: number } | undefined,
): { commit: CodexProjectionCommit; approval: { rawId: number; interactionId: string } | null } | null {
  if (rawRequest) {
    const request = parseCodexServerRequest(rawRequest.method, rawRequest.params, rawRequest.rawId);
    if (request.type === "approval") {
      const info = request.info;
      const { commit, record } = runtime.projection.registerApproval(
        { kind: info.kind, toolName: info.toolName, summary: info.summary },
        request.rawId,
      );
      return { commit, approval: { rawId: request.rawId, interactionId: record.interactionId } };
    }
    return null; // 未支持的 server request：不回包（Codex 侧按超时处理），不静默放行
  }
  const notification = parseCodexNotification(method, params);
  if (notification.type === "threadStarted") {
    // thread/start 的返回缺 id 时，以通知兜底。
    runtime.codexThreadId = notification.threadId;
    return null;
  }
  const commit = runtime.projection.applyNotification(notification);
  return commit ? { commit, approval: null } : null;
}

/** 在候选 runtime 中定位通知目标：有 threadId 精确匹配；缺 threadId 只在唯一候选时路由。 */
export function selectRuntimeForNotification(
  candidates: readonly CodexTaskRuntime[],
  threadId: string | null,
): CodexTaskRuntime | null {
  if (threadId) {
    return candidates.find((candidate) => candidate.codexThreadId === threadId) ?? null;
  }
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}
