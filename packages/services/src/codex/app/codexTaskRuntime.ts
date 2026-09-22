// Codex 任务运行时（app 层）：一个 harness task 对应一个 Codex thread runtime。
// 职责：thread 生命周期（start/resume）、bridge 通知归约、按需从 Codex 重建行日志。
// 代数（generation） fencing：runtime 记录创建时的 bridge generation，换代即 stale，
// stale runtime 不得再向旧进程语义投递，重建时以新代数重建投影（logEpoch 随之更换）。
import type { ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import { CodexThreadProjection } from "#src/codex/domain/codexProjection.js";
import type { CodexProjectionCommit } from "#src/codex/domain/codexProjection.js";
import type { CodexExecutionPolicy } from "#src/codex/domain/codexPolicy.js";
import {
  CODEX_METHODS,
  parseCodexNotification,
  parseCodexServerRequest,
  type CodexItem,
} from "#src/codex/domain/codexWire.js";
import type { CodexAppServerPort, CodexTaskIndexPort } from "./codexPorts.js";
import type { ITaskArtifactRegistry } from "#src/task-artifacts/contract.js";
import { scrubCodexErrorDetail } from "#src/codex/domain/codexWire.js";
import { reanchorRegisteredArtifactsAfterRebuild } from "./codexDeliveryIntegration.js";

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
  /**
   * Codex 侧活动 turn id（thread/start 不分配 turn；来自 turn/start 响应的
   * {turn:{id}} 或 turn/started 通知）。turn/interrupt 的 schema 要求 threadId+turnId
   * 双字段，未知时必须拒绝 stop 而不是发送缺字段的 payload。turn/completed 后清空。
   */
  codexTurnId: string | null = null;
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

/** 从 turn/start 响应中容错提取 Codex turn id（schema：{turn:{id,...}}）。 */
export function extractCodexTurnId(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const record = result as Record<string, unknown>;
  const direct = record.turnId ?? record.turn_id;
  if (typeof direct === "string" && direct.trim()) return direct;
  const turn = typeof record.turn === "object" && record.turn !== null ? (record.turn as Record<string, unknown>) : null;
  if (turn && typeof turn.id === "string" && turn.id.trim()) return turn.id;
  return null;
}

/** 启动一个新的 Codex thread（thread/start）；账号门禁在这里 fail closed。 */
export async function startCodexThread(
  bridge: CodexAppServerPort,
  params: { workspacePath: string; policy: CodexExecutionPolicy },
): Promise<string> {
  const account = (await bridge.call("account/read", {})) as {
    account?: unknown;
    requiresOpenaiAuth?: boolean;
  } | null;
  if (!account?.account) {
    throw new Error("codex_not_signed_in");
  }
  // 宿主执行策略显式下发（approvalPolicy + sandbox），不再依赖 Codex 自身默认
  // （E2E 观察到的默认是 approvalPolicy:"never" + dangerFullAccess，不可接受）。
  const result = await bridge.call(CODEX_METHODS.threadStart, {
    cwd: params.workspacePath,
    approvalPolicy: params.policy.approvalPolicy,
    sandbox: params.policy.sandbox,
  });
  const threadId = extractCodexThreadId(result);
  if (!threadId) throw new Error("codex_thread_start_missing_id");
  return threadId;
}

/** 恢复既有 thread（thread/resume）；返回 Codex 采纳的 thread id（取不到则沿用原 id）。 */
export async function resumeCodexThread(
  bridge: CodexAppServerPort,
  threadId: string,
  policy: CodexExecutionPolicy,
): Promise<string> {
  // excludeTurns:true 是 schema 文本明确推荐的用法（全量历史 hydration 已废弃，
  // 分页走 thread/items/list）；同时重申宿主策略，防止旧线程带着宽松策略复活。
  const result = await bridge.call(CODEX_METHODS.threadResume, {
    threadId,
    approvalPolicy: policy.approvalPolicy,
    sandbox: policy.sandbox,
    excludeTurns: true,
  });
  // resume 返回可能只是请求回显（E2E 观察 {}）；只在明确的 thread 字段出现时才采纳新 id。
  if (typeof result === "object" && result !== null) {
    const record = result as Record<string, unknown>;
    const thread = typeof record.thread === "object" && record.thread !== null ? (record.thread as Record<string, unknown>) : null;
    for (const candidate of [record.threadId, record.thread_id, thread?.id]) {
      if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
  }
  return threadId;
}

/** 冷恢复分页上限：防病态 cursor 循环；正常线程远小于此。 */
const MAX_HISTORY_PAGES = 50;

/**
 * 从 Codex 分页 items 重建投影（重启后 subscribe 的恢复路径）。
 * 按 nextCursor 翻页直到耗尽；接受数组 / {items} / {data} 形状，逐条落终态行。
 * 恢复失败不阻塞订阅：投影保持已恢复部分，turn 事件照常走。
 */
export async function rebuildProjectionFromCodex(
  bridge: CodexAppServerPort,
  threadId: string,
  projection: CodexThreadProjection,
): Promise<void> {
  let cursor: string | null = null;
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    let result: unknown;
    try {
      result = await bridge.call(
        CODEX_METHODS.threadItemsList,
        cursor ? { threadId, cursor } : { threadId },
      );
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
    const next = record?.nextCursor;
    cursor = typeof next === "string" && next.trim() ? next : null;
    if (!cursor) return;
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
        request.requestedPermissions,
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
  if (notification.type === "turnStarted") {
    // turn/interrupt 需要 Codex 侧 turnId；响应缺失时以通知兜底。
    if (notification.turnId) runtime.codexTurnId = notification.turnId;
    return null;
  }
  if (notification.type === "turnCompleted") {
    runtime.codexTurnId = null;
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

/** ensureRuntime 的可注入实现（宿主重启/换代后的冷恢复路径）。 */
export async function ensureRuntimeForTask(options: {
  bridge: CodexAppServerPort;
  taskIndex: CodexTaskIndexPort;
  policy: CodexExecutionPolicy;
  taskArtifacts?: ITaskArtifactRegistry;
  runtimes: Map<string, CodexTaskRuntime>;
  taskId: string;
  now: () => number;
}): Promise<CodexTaskRuntime> {
  const { bridge, taskIndex, policy, taskArtifacts, runtimes, taskId, now } = options;
  const existing = runtimes.get(taskId);
  if (existing && !existing.isStale(bridge)) return existing;
  try {
    const meta = await taskIndex.getTaskMeta({ taskId });
    if (!meta || meta.executionBackend !== "codex" || !meta.codexThreadId) {
      throw new Error("codex_task_not_found");
    }
    if (!bridge.installed) throw new Error("codex_not_installed");
    const generation = bridge.generation;
    const projection = new CodexThreadProjection(`codex-${generation}`, now);
    // resume / 重建先行，成功后才换入 runtime：中途失败不能把空投影永久写进缓存。
    const resumedThreadId = await resumeCodexThread(bridge, meta.codexThreadId, policy);
    await rebuildProjectionFromCodex(bridge, resumedThreadId, projection);
    await reanchorRegisteredArtifactsAfterRebuild({
      registry: taskArtifacts,
      taskId,
      projection,
    });
    const runtime =
      existing ??
      new CodexTaskRuntime(
        {
          taskId,
          workspacePath: meta.workspacePath,
          ...(meta.workspaceIdentity ? { workspaceIdentity: meta.workspaceIdentity } : {}),
          codexThreadId: resumedThreadId,
          bridgeGeneration: generation,
        },
        now,
      );
    runtime.bridgeGeneration = generation;
    runtime.projection = projection;
    runtime.codexThreadId = resumedThreadId;
    // 旧代进程的 turn 已随进程消失：换代重建后不允许拿旧 turnId 去打断新进程。
    runtime.codexTurnId = null;
    runtimes.set(taskId, runtime);
    return runtime;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "codex_task_not_found" || message === "codex_not_installed") throw error;
    throw new Error(scrubCodexErrorDetail(`codex_thread_resume_failed: ${message}`));
  }
}
