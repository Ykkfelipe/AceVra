// Codex 通知 → runtime 路由（app 层）。
//
// 为什么需要缓冲：thread/start 返回到 runtime 注册之间存在窗口，Codex 的首个
// item/turn 通知可能先到。旧实现对“找不到 runtime”的通知直接丢弃，turn/completed
// 一旦落进这个窗口，投影会永久停在 running（composer 永远显示“agent 正在工作”）。
// 这里按 threadId 暂存无主通知（仅通知，不缓冲需要即时应答的 server request），
// runtime 注册时立即回放。
import type { CodexProjectionCommit } from "#src/codex/domain/codexProjection.js";
import { routeCodexNotification, selectRuntimeForNotification } from "./codexTaskRuntime.js";
import type { CodexTaskRuntime } from "./codexTaskRuntime.js";

export interface CodexRoutedNotification {
  readonly taskId: string;
  readonly commit: CodexProjectionCommit;
}

interface BufferedNotification {
  readonly method: string;
  readonly params: unknown;
}

const MAX_BUFFERED_THREADS = 16;
const MAX_BUFFERED_PER_THREAD = 32;

export function createCodexNotificationRouter(params: {
  runtimes: Map<string, CodexTaskRuntime>;
  emitCommit(taskId: string, commit: CodexProjectionCommit): void;
  /** 无法路由的 server request（如审批）必须 fail closed 即时回拒。 */
  onUnroutableServerRequest(rawRequest: { method: string; rawId: number }): void;
}) {
  const buffered = new Map<string, BufferedNotification[]>();

  function buffer(threadId: string, method: string, notificationParams: unknown): void {
    // 超限时丢最旧（事件流语义下新事件更有价值）。
    if (!buffered.has(threadId) && buffered.size >= MAX_BUFFERED_THREADS) {
      const oldest = buffered.keys().next().value;
      if (oldest !== undefined) buffered.delete(oldest);
    }
    const queue = buffered.get(threadId) ?? [];
    queue.push({ method, params: notificationParams });
    if (queue.length > MAX_BUFFERED_PER_THREAD) queue.shift();
    buffered.set(threadId, queue);
  }

  function deliver(
    runtime: CodexTaskRuntime,
    method: string,
    notificationParams: unknown,
    rawRequest?: { method: string; params: unknown; rawId: number },
  ): CodexRoutedNotification | null {
    // rawRequest 必须透传：服务器请求（审批）由 routeCodexNotification 登记并回包。
    const routed = routeCodexNotification(runtime, method, notificationParams, rawRequest);
    if (!routed) return null;
    params.emitCommit(runtime.taskId, routed.commit);
    return { taskId: runtime.taskId, commit: routed.commit };
  }

  return {
    handle(
      method: string,
      notificationParams: unknown,
      rawRequest?: { method: string; params: unknown; rawId: number },
    ): CodexRoutedNotification | null {
      const record =
        typeof notificationParams === "object" && notificationParams !== null
          ? (notificationParams as Record<string, unknown>)
          : null;
      const threadId =
        typeof record?.threadId === "string"
          ? record.threadId
          : typeof record?.thread_id === "string"
            ? record.thread_id
            : null;
      const runtime = selectRuntimeForNotification([...params.runtimes.values()], threadId);
      if (runtime) return deliver(runtime, method, notificationParams, rawRequest);
      if (rawRequest) {
        // 审批类请求无法延迟：fail closed 回拒（routeCodexNotification 的既有语义）。
        params.onUnroutableServerRequest(rawRequest);
        return null;
      }
      if (threadId) buffer(threadId, method, notificationParams);
      return null;
    },

    /** runtime 注册后回放该 thread 的暂存通知（createTask / 冷恢复两条路径都要调用）。 */
    attachRuntime(runtime: CodexTaskRuntime): void {
      const queue = buffered.get(runtime.codexThreadId);
      if (!queue) return;
      buffered.delete(runtime.codexThreadId);
      for (const entry of queue) deliver(runtime, entry.method, entry.params);
    },
  };
}
