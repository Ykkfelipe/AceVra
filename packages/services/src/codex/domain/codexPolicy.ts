// Codex 执行策略（domain，纯数据 + 校验）。
//
// 字段名与枚举值取自已安装 Codex 自带的 App Server JSON Schema
// （codex-cli 0.155.0-alpha.9.2，`codex app-server generate-json-schema`）：
// - thread/start `approvalPolicy`: AskForApproval 字符串变体 = "untrusted" | "on-request" | "never"
// - thread/start `sandbox`: SandboxMode = "read-only" | "workspace-write" | "danger-full-access"
// thread/resume 接受同一组字段（可在恢复时重申宿主策略）。turn/start 的 per-turn 覆盖
// 用的是另一种形状（SandboxPolicy 对象），本策略刻意不在 turn 级别传沙箱，避免双写。
// 但 turn/start 的 `model` / `effort` 是顶层字符串覆盖（schema 0.155.0-alpha.16.4 复核：
// “Override the model/effort for this turn and subsequent turns”），由
// resolveCodexModelOverride 统一做 allow-list 校验后透传。
//
// 安全姿态：普通路径一律 safeInteractive（审批开启 + 只读沙箱）；unrestricted 仅作为
// 显式宿主级预设保留（ZCODE_CODEX_EXECUTION_POLICY 环境变量显式指名），绝不允许成为
// 默认值。未知名称 fail closed 回落到默认策略。
import { isCodexEffortOption, isCodexModelOptionId, type CodexEffortOption } from "@zcode/shared";

/** thread/turn 级模型/effort 覆盖（allow-list 校验后的透传形状）。 */
export interface CodexModelOverride {
  readonly modelId?: string;
  readonly effort?: CodexEffortOption;
}

/**
 * 校验 thread/start 与 turn/start 的模型/effort 覆盖。
 * 空白 = 不覆盖（沿用 Codex 应用/thread 当前设置）；非 allow-list 值 fail loud
 * （抛 codex_model_not_allowed / codex_effort_not_allowed），绝不静默透传自由文本。
 */
export function resolveCodexModelOverride(params: {
  modelId?: string | null;
  effort?: string | null;
}): CodexModelOverride {
  const modelId = params.modelId?.trim() ? params.modelId.trim() : undefined;
  const effort = params.effort?.trim() ? params.effort.trim() : undefined;
  if (modelId && !isCodexModelOptionId(modelId)) {
    throw new Error(`codex_model_not_allowed: ${modelId}`);
  }
  if (effort && !isCodexEffortOption(effort)) {
    throw new Error(`codex_effort_not_allowed: ${effort}`);
  }
  return {
    ...(modelId ? { modelId } : {}),
    ...(effort ? { effort: effort as CodexEffortOption } : {}),
  };
}

/** AskForApproval 的字符串变体（granular 对象变体本后端不使用）。 */
export type CodexAskForApproval = "untrusted" | "on-request" | "never";

/** thread/start · thread/resume 的 sandbox 字段（SandboxMode 字符串枚举）。 */
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexExecutionPolicy {
  readonly approvalPolicy: CodexAskForApproval;
  readonly sandbox: CodexSandboxMode;
}

export const CODEX_EXECUTION_POLICY_PRESETS = {
  /** 交互默认：Codex 主动请求审批（经 pendingInteraction 远程审批），沙箱只读。 */
  safeInteractive: { approvalPolicy: "on-request", sandbox: "read-only" },
  /** 次选：工作区可写，越界写入/网络仍走审批。 */
  workspaceWrite: { approvalPolicy: "on-request", sandbox: "workspace-write" },
  /** 高级显式预设：不审批 + 全权访问。只允许宿主环境显式指名，绝不是默认。 */
  unrestricted: { approvalPolicy: "never", sandbox: "danger-full-access" },
} as const satisfies Record<string, CodexExecutionPolicy>;

export type CodexExecutionPolicyPresetName = keyof typeof CODEX_EXECUTION_POLICY_PRESETS;

export const DEFAULT_CODEX_EXECUTION_POLICY: CodexExecutionPolicy =
  CODEX_EXECUTION_POLICY_PRESETS.safeInteractive;

const PRESET_NAMES: readonly string[] = Object.keys(CODEX_EXECUTION_POLICY_PRESETS);

/**
 * 按预设名解析策略；未知/空白名称一律回落默认（fail closed）。
 * 返回值带 adoptedDefault 标记，宿主可据此告警配置错误而不是静默吞掉。
 */
export function resolveCodexExecutionPolicy(name: string | null | undefined): {
  policy: CodexExecutionPolicy;
  adoptedDefault: boolean;
} {
  const key = typeof name === "string" ? name.trim() : "";
  if (key && (PRESET_NAMES as readonly string[]).includes(key)) {
    return { policy: CODEX_EXECUTION_POLICY_PRESETS[key as CodexExecutionPolicyPresetName], adoptedDefault: false };
  }
  return { policy: DEFAULT_CODEX_EXECUTION_POLICY, adoptedDefault: Boolean(key) };
}
