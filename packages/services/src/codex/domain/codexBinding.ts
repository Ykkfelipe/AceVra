// Codex 任务绑定映射（domain，纯函数）：ZCodeTaskMeta → 通道允许下发的脱敏绑定。
// 只携带任务元信息（id/workspace/backend/threadId/title/createdAt），不含任何会话正文
// 或 Codex 本机材料；shared 的 CodexTaskBinding 是该映射的类型上限。
import type { CodexTaskBinding, ZCodeTaskMeta } from "@zcode/shared";

export function toCodexTaskBinding(meta: ZCodeTaskMeta): CodexTaskBinding {
  return {
    taskId: meta.taskId,
    workspacePath: meta.workspacePath,
    ...(meta.workspaceIdentity ? { workspaceIdentity: meta.workspaceIdentity } : {}),
    executionBackend: "codex",
    codexThreadId: meta.codexThreadId ?? "",
    title: meta.title,
    createdAt: meta.createdAt,
  };
}
