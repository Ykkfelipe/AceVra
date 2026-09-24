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

/**
 * Codex 后端的策划模型 allow-list（exact allow-list，不做 family matcher）。
 *
 * id 会原样作为 thread/start 的 `model` 参数发给 Codex app-server；label 仅用于展示。
 * `undefined`/`null` 是 Default 哨兵：表示沿用 Codex 应用自身设置，不发送 model 字段。
 * 新增模型必须走契约变更（本文件），不允许 UI 自由输入，也不读取 ~/.codex/config.toml。
 */
export interface CodexModelOption {
  readonly id: string;
  readonly label: string;
  readonly reasoningEfforts: readonly CodexEffortOption[];
}

export const CODEX_EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type CodexEffortOption = (typeof CODEX_EFFORT_OPTIONS)[number];

export const CODEX_MODEL_OPTIONS: readonly CodexModelOption[] = [
  {
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    id: "gpt-6-sol",
    label: "GPT-6 Sol",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    id: "gpt-6-luna",
    label: "GPT-6 Luna",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
  { id: "gpt-5.5", label: "GPT-5.5", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
];

const CODEX_MODEL_IDS = new Set(CODEX_MODEL_OPTIONS.map((option) => option.id));

export function isCodexModelOptionId(value: unknown): value is string {
  return typeof value === "string" && CODEX_MODEL_IDS.has(value);
}

/** 已知 id 的展示名；未知 id 原样返回（容错旧草稿，不抛错）。 */
export function codexModelOptionLabel(id: string): string {
  return CODEX_MODEL_OPTIONS.find((option) => option.id === id)?.label ?? id;
}

/** Return the advertised, curated effort tiers for a selected model. */
export function codexModelReasoningEfforts(
  modelId: string | null | undefined,
): readonly CodexEffortOption[] {
  return (
    CODEX_MODEL_OPTIONS.find((option) => option.id === modelId)?.reasoningEfforts ??
    CODEX_EFFORT_OPTIONS
  );
}

export function isCodexEffortOption(value: unknown): value is CodexEffortOption {
  return typeof value === "string" && (CODEX_EFFORT_OPTIONS as readonly string[]).includes(value);
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
  /** Codex 回报的当前生效模型（thread/start 响应）；null = 沿用应用默认。 */
  readonly model?: string | null;
  /** Codex 回报的当前生效 reasoning effort；null = 未确认。 */
  readonly effort?: string | null;
}

export interface CodexExecutionCreateTaskParams {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  /** 首条用户输入；携带时服务端创建任务后立即 start 首个 turn。 */
  readonly firstInput?: string;
  /** 可选标题；缺省由首条输入截取。 */
  readonly title?: string;
  /** Codex 模型选择；缺省/空 = Default 哨兵，沿用 Codex 应用自身设置。 */
  readonly modelId?: string;
  /** 首个 turn 的 reasoning effort 覆盖（`CODEX_EFFORT_OPTIONS`）；缺省 = 不覆盖。 */
  readonly effort?: CodexEffortOption;
}

export interface CodexExecutionCreateTaskResult {
  readonly task: CodexTaskBinding;
}

/**
 * Codex 任务当前生效的模型/effort 读数（来自 thread/start 响应或 turn/start 覆盖）。
 * model/effort 为 Codex 回报的原值；null = 未确认（沿用 Codex 应用默认）。
 */
export interface CodexTaskModelState {
  readonly model: string | null;
  readonly effort: string | null;
}

export interface CodexExecutionSendTurnParams {
  readonly taskId: string;
  readonly content: string;
  /** v4 command envelope 的 commandId，供 ACK 对账；缺省由服务端生成。 */
  readonly commandId?: string;
  /**
   * turn 级模型/effort 覆盖（Codex schema：「Override the model/effort for this turn and
   * subsequent turns」）。只接受策划 allow-list 内的值；缺省 = 本次不覆盖。
   */
  readonly modelId?: string;
  readonly effort?: CodexEffortOption;
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
