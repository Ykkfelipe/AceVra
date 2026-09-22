// Codex 执行后端的共享契约（phase 10）。
//
// SECURITY BOUNDARY：本文件是 codex-execution 通道允许跨进程（含 /fork relay）传输的
// 全部形状。任何来自 Codex 的 token、OAuth 材料、auth.json 内容、codexHome 路径或原始
// server-request 信封都不得进入这些类型；会话内容只经 v4 conversation 投影传输
// （见 zcode-protocol-v4），本文件只描述任务绑定与通道参数。
//
// Codex 保持自己的 agent loop（thread/turn/item），不进入 ZCode model adapter。

/** 新任务的执行后端。本阶段只有 ZCode agent 与 Codex；Claude 后端尚未加入。 */
export type ZCodeExecutionBackend = "zcode" | "codex";

export const ZCODE_EXECUTION_BACKENDS: readonly ZCodeExecutionBackend[] = ["zcode", "codex"];

export function isZCodeExecutionBackend(value: unknown): value is ZCodeExecutionBackend {
  return value === "zcode" || value === "codex";
}

/** createTask 结果：任务绑定元信息（不含任何会话正文）。 */
export interface CodexTaskBinding {
  readonly taskId: string;
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly executionBackend: "codex";
  readonly codexThreadId: string;
  readonly title: string;
  readonly createdAt: number;
}

export interface CodexExecutionCreateTaskParams {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  /** 首条用户输入；携带时服务端创建任务后立即 start 首个 turn。 */
  readonly firstInput?: string;
  /** 可选标题；缺省由首条输入截取。 */
  readonly title?: string;
}

export interface CodexExecutionCreateTaskResult {
  readonly task: CodexTaskBinding;
}

export interface CodexExecutionSendTurnParams {
  readonly taskId: string;
  readonly content: string;
  /** v4 command envelope 的 commandId，供 ACK 对账；缺省由服务端生成。 */
  readonly commandId?: string;
}

export interface CodexExecutionApprovalDecision {
  readonly taskId: string;
  /** interactionId = 服务端在 pendingInteraction 里下发的 `codex-approval-<n>`。 */
  readonly interactionId: string;
  readonly decision: "approved" | "denied";
}

export interface CodexExecutionApprovalRequestInfo {
  readonly interactionId: string;
  readonly kind: "commandExecution" | "fileChange" | "permissions";
  readonly toolName: string;
  readonly summary: string;
}

export interface CodexTaskThreadInfo {
  readonly taskId: string;
  readonly codexThreadId: string | null;
  readonly executionBackend: "codex" | "zcode";
}

export interface CodexExecutionReadTaskParams {
  readonly taskId: string;
  readonly workspacePath?: string;
  readonly workspaceIdentity?: string;
}

/** 任务清单读取范围；与其它 task 面一致按 workspace 身份收敛。 */
export interface CodexExecutionListTasksParams {
  readonly workspacePath?: string;
  readonly workspaceIdentity?: string;
}

export interface CodexExecutionListTasksResult {
  readonly tasks: readonly CodexTaskBinding[];
}
