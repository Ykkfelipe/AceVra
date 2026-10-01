/**
 * M2F：把 agent 启动的节点任务挂到发起它的对话卡片上（`session:<sessionId>`）。
 *
 * 事实源仍是 desktop main 的 `AgentTaskStarted` 推送；这里只写渲染端呈现状态
 * `executionTargetStore.tasksByScope`，绝不启动任务。整个 renderer 只保留一条订阅：
 * 多个调用方共享同一订阅（引用计数），最后一个 dispose 才退订，避免重复挂载导致重复订阅。
 */
import type { IAccountPlatform } from "@zcode/shared";
import { logger } from "@/logger.js";
import { executionScopeKey, useExecutionTargetStore } from "@/store/executionTargetStore.js";

export interface AgentTaskStartedNotice {
  sessionId: string;
  taskId: string;
  targetId: string;
}

const MAX_ID_LENGTH = 128;

const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;

export function parseAgentTaskStartedNotice(value: unknown): AgentTaskStartedNotice | null {
  if (typeof value !== "object" || value === null) return null;
  const { sessionId, taskId, targetId } = value as Record<string, unknown>;
  if (!isId(sessionId) || !isId(taskId) || !isId(targetId)) return null;
  return { sessionId, taskId, targetId };
}

let installed: { account: IAccountPlatform; off: () => void; refs: number } | null = null;

const NOOP = () => {};

export function installAgentTaskAttachBridge(account: IAccountPlatform | undefined): () => void {
  if (!account) return NOOP;
  if (installed && installed.account !== account) {
    // 平台实例被替换（只会出现在测试或热重载）：旧订阅不再有意义。
    installed.off();
    installed = null;
  }
  if (!installed) {
    const off = account.onAgentTaskStarted((raw) => {
      const notice = parseAgentTaskStartedNotice(raw);
      if (!notice) {
        logger.debug("[acevra-agent-task] 忽略格式不合法的 AgentTaskStarted 推送");
        return;
      }
      useExecutionTargetStore
        .getState()
        .attachTask(executionScopeKey({ workspacePath: "" }, notice.sessionId), notice.taskId);
    });
    installed = { account, off, refs: 0 };
  }
  const entry = installed;
  entry.refs += 1;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    entry.refs -= 1;
    if (entry.refs === 0 && installed === entry) {
      entry.off();
      installed = null;
    }
  };
}
