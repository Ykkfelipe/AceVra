// 未知 / 不可用动作的结构化解释：一次给出原因与正确的规范调用，免去探索性重试。
// 纯函数；输入是当前快照，输出是 CapabilityErrorPayload。
import type {
  Capability,
  CapabilityAction,
  CapabilityErrorPayload,
  CapabilitySnapshot,
} from "@zcode/contracts";
import { COMPUTER_FOREGROUND_ALTERNATIVES } from "./computer.js";

const MAX_SUGGESTIONS = 5;
const MIN_SIMILARITY = 0.6;
const COMPUTER_PREFIXES = [
  "mcp__computer-use__",
  "mcp__computer_use__",
  "agent.computeruse.",
  "computeruse.",
];

interface IndexedAction {
  capability: Capability;
  action: CapabilityAction;
  keys: string[];
}

/** 规范化拼写：大小写、前缀与分隔符差异不构成不同动作。 */
export function normalizeActionSpelling(name: string): string {
  let value = name.trim().toLowerCase();
  for (const prefix of COMPUTER_PREFIXES) {
    if (value.startsWith(prefix)) value = value.slice(prefix.length);
  }
  return value
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .replace(/^computer_/u, "");
}

function actionKeys(action: CapabilityAction): string[] {
  const keys = [action.canonicalName, action.invocation.toolName];
  if (action.invocation.kind === "node_repl" && action.invocation.mcpToolName) {
    keys.push(action.invocation.mcpToolName);
  }
  // node_repl 宿主工具名（js）是执行面，不是动作本身的拼写。
  if (action.invocation.kind === "node_repl") keys.splice(1, 1);
  return [...new Set(keys.map(normalizeActionSpelling))];
}

function indexActions(snapshot: CapabilitySnapshot): IndexedAction[] {
  return snapshot.capabilities.flatMap((capability) =>
    capability.actions.map((action) => ({ capability, action, keys: actionKeys(action) })),
  );
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j]!;
      previous[j] = Math.min(
        above + 1,
        previous[j - 1]! + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length]!;
}

function similarity(requested: string, key: string): number {
  if (requested === key) return 3;
  const tokensA = new Set(requested.split("_").filter(Boolean));
  const tokensB = new Set(key.split("_").filter(Boolean));
  const shared = [...tokensA].filter((token) => tokensB.has(token)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  const jaccard = union === 0 ? 0 : shared / union;
  const contains = key.includes(requested) || requested.includes(key) ? 0.5 : 0;
  const distance = levenshtein(requested, key);
  const close = distance <= 2 ? 1 - distance / 4 : 0;
  return jaccard + contains + close;
}

export function formatActionInvocation(action: CapabilityAction): string {
  if (action.invocation.kind === "tool") return action.invocation.toolName;
  return `${action.invocation.toolName}: ${action.invocation.expression}`;
}

function availableIn(capability: Capability): string[] {
  return capability.actions
    .filter((action) => action.availability === "available")
    .map((action) => action.canonicalName);
}

function rankSimilar(requested: string, index: readonly IndexedAction[]): IndexedAction[] {
  return index
    .filter((item) => item.action.availability === "available")
    .map((item) => ({
      item,
      score: Math.max(...item.keys.map((key) => similarity(requested, key))),
    }))
    .filter((entry) => entry.score >= MIN_SIMILARITY)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.item);
}

function alternativesFor(canonicalName: string, index: readonly IndexedAction[]): IndexedAction[] {
  const names = COMPUTER_FOREGROUND_ALTERNATIVES[canonicalName] ?? [];
  return names
    .map((name) => index.find((item) => item.action.canonicalName === name))
    .filter((item): item is IndexedAction => item?.action.availability === "available");
}

function suggestionsFrom(items: readonly IndexedAction[]): string[] {
  return [...new Set(items.map((item) => formatActionInvocation(item.action)))].slice(
    0,
    MAX_SUGGESTIONS,
  );
}

function unavailableServerMatch(
  requested: string,
  snapshot: CapabilitySnapshot,
): Capability | undefined {
  const lowered = requested.toLowerCase();
  return snapshot.capabilities.find((capability) => {
    if (capability.availability !== "unavailable" || !capability.mcpServer) return false;
    const server = capability.mcpServer.replace(/[^a-zA-Z0-9_-]/gu, "_").replace(/_+/gu, "_");
    return lowered.startsWith(`mcp__${server.toLowerCase()}__`);
  });
}

export function explainUnknownTool(
  requested: string,
  snapshot: CapabilitySnapshot,
): CapabilityErrorPayload {
  const normalized = normalizeActionSpelling(requested);
  const index = indexActions(snapshot);
  const exact = index.filter((item) => item.keys.includes(normalized));
  const similar = rankSimilar(normalized, index);

  const unavailableExact = exact.find((item) => item.action.availability === "unavailable");
  const availableExact = exact.find((item) => item.action.availability === "available");
  if (unavailableExact && !availableExact) {
    const { capability, action } = unavailableExact;
    return {
      code: "capability_unavailable",
      requested,
      capability: capability.id,
      reason: `${action.canonicalName} is not available: ${action.unavailableReason ?? capability.unavailableReason ?? "unavailable in this session"}`,
      availableActions: availableIn(capability),
      suggestions: suggestionsFrom([...alternativesFor(action.canonicalName, index), ...similar]),
    };
  }
  if (availableExact) {
    // 名字对、调用面错：例如把 Computer facade 动作当成 provider 工具直接调用。
    return {
      code: "tool_not_found",
      requested,
      capability: availableExact.capability.id,
      reason:
        availableExact.action.invocation.kind === "tool"
          ? `tool names are exact and case-sensitive: call "${availableExact.action.invocation.toolName}"`
          : `"${requested}" is not a provider tool here; the action ${availableExact.action.canonicalName} is called inside the ${availableExact.action.invocation.toolName} tool as shown in suggestions`,
      availableActions: availableIn(availableExact.capability),
      suggestions: suggestionsFrom([availableExact, ...similar]),
    };
  }
  const server = unavailableServerMatch(requested, snapshot);
  if (server) {
    return {
      code: "capability_unavailable",
      requested,
      capability: server.id,
      reason: server.unavailableReason ?? "this MCP server is unavailable in this session",
      availableActions: [],
      suggestions: [],
    };
  }
  return {
    code: "tool_not_found",
    requested,
    reason: `No tool or action named "${requested}" exists in this session. Use one of the suggestions or the exact names from your tool list / capability context; the Capabilities tool lists everything available.`,
    availableActions: [],
    suggestions: suggestionsFrom(similar),
  };
}
