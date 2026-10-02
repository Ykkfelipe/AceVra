// Capability runtime: 权威注册表的纯投影、确定性相关性选择、提醒渲染与结构化错误。
// 规范：core/specs/capability-runtime.md
export {
  buildCapabilitySnapshot,
  resolveNodeReplToolName,
  type CapabilityExecutionTargetSource,
  type CapabilityMcpServerSource,
  type CapabilityMcpToolSource,
  type CapabilitySkillSource,
  type CapabilitySources,
} from "./snapshot.js";
export {
  COMPUTER_CAPABILITY_ID,
  PROTECTED_FOREGROUND_REASON,
  computerMcpToolName,
} from "./computer.js";
export { NO_TARGETS_REASON } from "./snapshot-targets.js";
export {
  DEFAULT_MAX_SELECTED_CAPABILITIES,
  selectRelevantCapabilities,
  textMentions,
  type CapabilitySelectionInput,
} from "./select.js";
export { MAX_CAPABILITY_CONTEXT_BYTES, renderCapabilityContext } from "./render.js";
export { explainUnknownTool, formatActionInvocation, normalizeActionSpelling } from "./errors.js";
export { CAPABILITIES_TOOL } from "./domains.js";
export type { CapabilityRuntimeCache } from "./runtime-cache.js";
