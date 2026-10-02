// Capabilities：只读查看"本会话此刻能做什么"（core/specs/capability-runtime.md）。
// 快照来自 runtime 的 CapabilityQueryPort（权威注册表的纯投影）；本工具只做过滤与序列化。
import {
  CAPABILITIES_TOOL_NAME,
  CapabilitiesInputJsonSchema,
  CapabilitiesInputSchema,
  CoreErrorType,
  createCoreError,
  type Capability,
  type CapabilitySnapshot,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_MODEL_BYTES = 48_000;
// 形状由 @zcode/contracts 的 Capability 类型定义；这里只声明顶层结构供 provider/UI 使用。
const CAPABILITIES_OUTPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    target: { type: "object" },
    capabilities: { type: "array", items: { type: "object" } },
    note: { type: "string" },
  },
  required: ["target", "capabilities", "note"],
};

function filterCapabilities(
  snapshot: CapabilitySnapshot,
  input: { domain?: string; capability?: string; includeUnavailable?: boolean },
): Capability[] {
  return snapshot.capabilities.filter(
    (capability) =>
      (input.domain === undefined || capability.domain === input.domain) &&
      (input.capability === undefined || capability.id === input.capability) &&
      (input.includeUnavailable !== false || capability.availability === "available"),
  );
}

const capabilitiesHandler: ToolHandler = async (input, context) => {
  const parsed = CapabilitiesInputSchema.parse(input);
  const port = context.capabilityQueryPort;
  if (!port) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `${CAPABILITIES_TOOL_NAME} is not available in this session`,
      {
        context: { toolCallId: context.toolCallId, toolName: CAPABILITIES_TOOL_NAME },
        recoverable: false,
      },
    );
  }
  const snapshot = await port.snapshot();
  const capabilities = filterCapabilities(snapshot, parsed);
  // 单个能力查询给完整 inputSchema；全量列表省略 schema（原生/MCP 的 schema 已在工具表里）。
  const detailed = parsed.capability !== undefined;
  return {
    target: snapshot.target,
    capabilities: capabilities.map((capability) => ({
      ...capability,
      actions: capability.actions.map((action) =>
        detailed ? action : { ...action, inputSchema: undefined },
      ),
    })),
    note: "Use exact canonical names. Unavailable items carry the real reason; tell the user instead of trying variants. Pass capability=<id> for full input schemas.",
  };
};

export const capabilitiesToolEntry: ToolEntry = {
  capability:
    "List what this agent can do right now, with exact names, argument shapes and availability",
  metadata: {
    name: CAPABILITIES_TOOL_NAME,
    description: [
      "Lists this session's live capabilities: exact canonical action names, argument shapes, where they execute (this Mac or another computer), related skills, and the real reason for anything unavailable.",
      "Use it only when the capability context you were given does not cover what you need; never probe tools or method names by trial and error.",
    ].join("\n"),
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 10_000,
    maxOutputBytes: MAX_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: capabilitiesHandler,
  inputSchema: CapabilitiesInputJsonSchema,
  outputSchema: CAPABILITIES_OUTPUT_JSON_SCHEMA,
  runtimeInputSchema: CapabilitiesInputSchema,
  formatModelContent: (output) => JSON.stringify(output),
  resultBudget: {
    maxInlineBytes: MAX_MODEL_BYTES,
    maxModelBytes: MAX_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_MODEL_BYTES, direction: "head" },
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
  permission: {
    permission: "capabilities.list",
    reason: "Capabilities only reads this session's capability registry",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  timeout: { defaultMs: 10_000, maxMs: 10_000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Capabilities was cancelled",
  },
};
