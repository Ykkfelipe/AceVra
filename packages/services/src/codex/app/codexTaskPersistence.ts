// Codex 任务 meta 持久化旁路（app 层小工具）。
// 从 codexExecutionServiceImpl 抽出，保持该文件在 400 行上限内；只做 fire-and-forget 写回，
// 失败仅 warn（持久化失败不得回滚已接受的 turn）。
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { CodexModelOverride } from "#src/codex/domain/codexPolicy.js";
import type { CodexTaskIndexPort } from "./codexPorts.js";
import type { CodexTaskRuntime } from "./codexTaskRuntime.js";

interface PersistenceContext {
  readonly taskIndex: CodexTaskIndexPort;
  now(): number;
  warn(message: string): void;
}

function patchTarget(runtime: CodexTaskRuntime): {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
} {
  return {
    workspacePath: runtime.workspacePath,
    ...(runtime.workspaceIdentity ? { workspaceIdentity: runtime.workspaceIdentity } : {}),
    taskId: runtime.taskId,
  };
}

export function persistCodexStatus(
  context: PersistenceContext,
  runtime: CodexTaskRuntime,
  status: ZCodeTaskMeta["status"],
): void {
  void context.taskIndex
    .updateTaskState({ ...patchTarget(runtime), patch: { status, updatedAt: context.now() } })
    .catch((error) => context.warn(`codex task status write failed: ${String(error)}`));
}

/** turn 级覆盖被 Codex 接受后：同步 runtime 读数并持久化（UI 与快照据此显示真实生效值）。 */
export function persistCodexTurnOverride(
  context: PersistenceContext,
  runtime: CodexTaskRuntime,
  override: CodexModelOverride,
): void {
  if (override.modelId) runtime.codexModelId = override.modelId;
  if (override.effort) runtime.codexEffort = override.effort;
  const patch: { codexModelId?: string; codexEffort?: string; updatedAt: number } = {
    updatedAt: context.now(),
  };
  if (override.modelId) patch.codexModelId = override.modelId;
  if (override.effort) patch.codexEffort = override.effort;
  void context.taskIndex
    .updateTaskState({ ...patchTarget(runtime), patch })
    .catch((error) => context.warn(`codex turn override persist failed: ${String(error)}`));
}
