// ============================================================
// Capabilities - AceVra runtime capability descriptors (specs: core/specs/capability-runtime.md)
// ============================================================
// 能力层只是权威注册表（ToolRegistry / MCP / plugin catalog / skills / CUA surface / execution
// targets）的纯投影：这里只定义值对象形状，不持有任何可变状态，也不引入第二份注册表。

import type { JsonSchema, ModelToolSideEffectScope } from "../model/index.js";

export type CapabilitySource = "native" | "computer" | "mcp" | "plugin" | "execution_target";

export type CapabilityDomain =
  | "files"
  | "search"
  | "shell"
  | "web"
  | "computer"
  | "remote_computer"
  | "execution_targets"
  | "browser"
  | "agents"
  | "workflow"
  | "planning"
  | "skills"
  | "scheduling"
  | "mcp"
  | "other";

export type CapabilityAvailability = "available" | "unavailable";

/** 动作的调用方式：provider 工具名，或 node_repl 内的 Computer facade 表达式。 */
export type CapabilityInvocation =
  | { kind: "tool"; toolName: string }
  | { kind: "node_repl"; toolName: string; expression: string; mcpToolName?: string };

export interface CapabilityActionRisk {
  readOnly: boolean;
  destructive?: boolean;
  sideEffectScope?: ModelToolSideEffectScope;
  needsApproval?: boolean;
  /** Computer 动作的前后台分类（background 不抢用户前台）。 */
  foreground?: boolean;
}

export interface CapabilityAction {
  /** 唯一规范名；provider 拼写差异只出现在 invocation 中。 */
  canonicalName: string;
  invocation: CapabilityInvocation;
  description?: string;
  /** 紧凑参数形状（如 Computer surface 的 `{ pid: integer, text: string }`）。 */
  argsHint?: string;
  inputSchema?: JsonSchema;
  outputSummary?: string;
  availability: CapabilityAvailability;
  unavailableReason?: string;
  risk: CapabilityActionRisk;
}

export interface Capability {
  id: string;
  domain: CapabilityDomain;
  displayName: string;
  source: CapabilitySource;
  actions: CapabilityAction[];
  availability: CapabilityAvailability;
  unavailableReason?: string;
  /** 动作实际执行的位置：`this-device` 或 execution target id。 */
  executionTargets: string[];
  /** 讲"如何用好"的 Skill 名（qualifiedName 或 name）；本层从不注入 Skill 正文。 */
  relatedSkills: string[];
  /** 是否经 provider 工具表可见（node_repl facade 动作经 `js` 工具可见）。 */
  providerVisible: boolean;
  /** plugin 来源仅作 provenance；兼容标识（plugin id、mcp__ 名）原样保留。 */
  pluginId?: string;
  mcpServer?: string;
  /** 相关性选择用的确定性词表（小写）。 */
  keywords: string[];
  /** 能力级使用约束（一次说清，不靠失败发现）。 */
  limits?: string[];
}

export interface CapabilityTargetSummary {
  /** 本会话进程执行所在：本机或已绑定的另一台电脑。 */
  kind: "local" | "remote";
  targetId?: string;
  displayName?: string;
}

export interface CapabilitySnapshotDiagnostics {
  discoveryMs: number;
  capabilityCount: number;
  availableActionCount: number;
  /** listTargets 超时/失败时为 false：快照如实说明目标列表未知，绝不编造。 */
  targetListResolved: boolean;
}

export interface CapabilitySnapshot {
  target: CapabilityTargetSummary;
  capabilities: Capability[];
  diagnostics: CapabilitySnapshotDiagnostics;
}

export interface CapabilitySelectionEntry {
  capabilityId: string;
  /** 可解释、可测试的命中原因，如 `keyword:chrome`、`plugin_reference:x@y`。 */
  reasons: string[];
}

export interface CapabilitySelection {
  selected: CapabilitySelectionEntry[];
  omittedCount: number;
}

export type CapabilityErrorCode = "capability_unavailable" | "tool_not_found";

/** 模型调用了不存在/不可用的动作时的结构化错误：一次说清，无需探索性重试。 */
export interface CapabilityErrorPayload {
  code: CapabilityErrorCode;
  requested: string;
  capability?: string;
  reason: string;
  availableActions: string[];
  suggestions: string[];
}

/** 会话能力快照的只读查询端口（runtime 提供；Capabilities 工具与诊断消费）。 */
export interface CapabilityQueryPort {
  snapshot(): Promise<CapabilitySnapshot>;
}
