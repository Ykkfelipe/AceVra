import type { SubmissionExecutionTarget } from "@zcode/shared";

export interface SubmissionExecutionTargetContext {
  /** 与 Run-on 控件渲染条件一致：有桌面账号桥。 */
  hasAccountBridge: boolean;
  /** 远程 workspace（有 workspaceIdentity）不路由 agent 执行工具。 */
  workspaceIdentity?: string;
  /** 发送时读取 composer 当时展示的 scope 选择；只在需要时调用。 */
  resolve: () => SubmissionExecutionTarget;
}

/**
 * M2F：只给用户输入命令（`sendText`、带 firstInput 的 `createSession`）附带 `executionTarget`，
 * 且只在本地 workspace + 有账号桥时附带。已带该字段的 payload（恢复重放）保持原值不变。
 */
export function withSubmissionExecutionTarget(
  type: string,
  payload: Record<string, unknown>,
  context: SubmissionExecutionTargetContext,
): Record<string, unknown> {
  if (!context.hasAccountBridge || context.workspaceIdentity?.trim()) return payload;
  if (type === "sendText") {
    if (payload.executionTarget !== undefined) return payload;
    return { ...payload, executionTarget: context.resolve() };
  }
  if (type === "createSession") {
    const firstInput = payload.firstInput;
    if (typeof firstInput !== "object" || firstInput === null) return payload;
    if ((firstInput as Record<string, unknown>).executionTarget !== undefined) return payload;
    return { ...payload, firstInput: { ...firstInput, executionTarget: context.resolve() } };
  }
  return payload;
}
