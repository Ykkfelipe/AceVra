import { AUTOMATIC_SUBMISSION_TARGET } from "@/store/executionTargetStore.js";

export interface SubmissionExecutionTargetContext {
  /** 有桌面账号桥（agent 才可能拥有其它电脑）。 */
  hasAccountBridge: boolean;
  /** 远程 workspace（有 workspaceIdentity）不路由 agent 执行工具。 */
  workspaceIdentity?: string;
}

/**
 * 只给用户输入命令（`sendText`、带 firstInput 的 `createSession`）附带 `executionTarget`，
 * 且只在本地 workspace + 有账号桥时附带。值总是 `automatic`（见 AUTOMATIC_SUBMISSION_TARGET）。
 * 已带该字段的 payload（恢复重放）保持原值不变。
 */
export function withSubmissionExecutionTarget(
  type: string,
  payload: Record<string, unknown>,
  context: SubmissionExecutionTargetContext,
): Record<string, unknown> {
  if (!context.hasAccountBridge || context.workspaceIdentity?.trim()) return payload;
  if (type === "sendText") {
    if (payload.executionTarget !== undefined) return payload;
    return { ...payload, executionTarget: AUTOMATIC_SUBMISSION_TARGET };
  }
  if (type === "createSession") {
    const firstInput = payload.firstInput;
    if (typeof firstInput !== "object" || firstInput === null) return payload;
    if ((firstInput as Record<string, unknown>).executionTarget !== undefined) return payload;
    return {
      ...payload,
      firstInput: { ...firstInput, executionTarget: AUTOMATIC_SUBMISSION_TARGET },
    };
  }
  return payload;
}
