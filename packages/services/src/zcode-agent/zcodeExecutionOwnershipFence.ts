// zcode 写权限栅栏（backend-migration.md Amendment 4「Read vs write authority」「Normal turns
// during a migration」）：迁移进行中拒绝新用户轮；task 已归 Codex 时 zcode 会话只是历史读源，
// 不接受新轮——即使 renderer 的路由缓存还停在旧后端。草稿（尚无 task 行）不受影响。
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";

export const BACKEND_TRANSITION_IN_PROGRESS_REJECTION = "backendTransitionInProgress";
export const BACKEND_NOT_EXECUTION_OWNER_REJECTION = "backendNotExecutionOwner";

export async function rejectZCodeSendWithoutExecutionOwnership(params: {
  readonly envelope: CommandEnvelope;
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly getTaskMeta: (target: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }) => Promise<ZCodeTaskMeta | null>;
}): Promise<CommandAck | null> {
  const envelope = params.envelope;
  if (envelope.type !== "sendText" || !envelope.sessionId) return null;
  const meta = await params
    .getTaskMeta({
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      taskId: envelope.sessionId,
    })
    .catch(() => null);
  if (!meta) return null;
  if (meta.pendingBackendTransition) {
    return {
      commandId: envelope.commandId,
      status: "rejected",
      revisionAtDecision: 0,
      reasonCode: BACKEND_TRANSITION_IN_PROGRESS_REJECTION,
      message: "A backend switch is in progress for this task",
    };
  }
  if (meta.executionBackend === "codex") {
    return {
      commandId: envelope.commandId,
      status: "rejected",
      revisionAtDecision: 0,
      reasonCode: BACKEND_NOT_EXECUTION_OWNER_REJECTION,
      message: "This task is currently executed by another backend",
    };
  }
  return null;
}
