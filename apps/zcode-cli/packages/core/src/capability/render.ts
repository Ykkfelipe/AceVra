// capability_context reminder 渲染：固定模板、有界字节、只写入选能力。
// 已在 provider 工具表里且可用的原生能力不重复描述（schema 已在工具表），只在
// 不可用 / 被重定向 / 有相关 Skill 时出现一行。
import type {
  Capability,
  CapabilityAction,
  CapabilitySelection,
  CapabilitySnapshot,
} from "@zcode/contracts";
import { NATIVE_DOMAIN_SPECS } from "./domains.js";

export const MAX_CAPABILITY_CONTEXT_BYTES = 8 * 1024;
const MAX_NOTE_CHARS = 360;
const MAX_RETURNS_CHARS = 220;
const ALWAYS_VISIBLE_IDS: ReadonlySet<string> = new Set(
  NATIVE_DOMAIN_SPECS.filter((spec) => spec.alwaysVisible).map((spec) => spec.id),
);

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function hasUnavailableActions(capability: Capability): boolean {
  return capability.actions.some((action) => action.availability === "unavailable");
}

/** 原生常驻能力可用且无话可说时不渲染，避免把工具表再抄一遍。 */
function worthRendering(capability: Capability, reasons: readonly string[]): boolean {
  if (!ALWAYS_VISIBLE_IDS.has(capability.id)) return true;
  return (
    capability.availability === "unavailable" ||
    hasUnavailableActions(capability) ||
    relevantSkills(capability, reasons).length > 0
  );
}

/**
 * 原生常驻能力（如 files）关联了多个文档 Skill；只保留名字与本轮命中关键词相同的那个，
 * "Edit this PDF" 只提示 pdf Skill，而不是把 docx/xlsx/pptx 一并列出。
 */
function relevantSkills(capability: Capability, reasons: readonly string[]): string[] {
  if (!ALWAYS_VISIBLE_IDS.has(capability.id)) return capability.relatedSkills;
  const keywords = new Set(
    reasons.filter((reason) => reason.startsWith("keyword:")).map((reason) => reason.slice(8)),
  );
  return capability.relatedSkills.filter((skill) =>
    keywords.has(skill.split(":").pop()?.toLowerCase() ?? ""),
  );
}

function actionLine(action: CapabilityAction): string {
  if (action.invocation.kind === "node_repl") {
    const shape = action.argsHint ? ` ${action.argsHint}` : "";
    const note = action.description ? ` — ${truncate(action.description, MAX_NOTE_CHARS)}` : "";
    const returns = action.outputSummary
      ? ` → returns ${truncate(action.outputSummary, MAX_RETURNS_CHARS)}`
      : "";
    return `- ${action.canonicalName}${shape}${returns}${note}`;
  }
  const note = action.description ? ` — ${truncate(action.description, MAX_NOTE_CHARS)}` : "";
  return `- ${action.canonicalName}${note}`;
}

function unavailableLines(actions: readonly CapabilityAction[]): string[] {
  const byReason = new Map<string, string[]>();
  for (const action of actions) {
    const reason = action.unavailableReason ?? "unavailable";
    byReason.set(reason, [...(byReason.get(reason) ?? []), action.canonicalName]);
  }
  return [...byReason].map(
    ([reason, names]) => `Not available here: ${names.join(", ")} — ${reason}`,
  );
}

function invocationLine(capability: Capability): string | undefined {
  const first = capability.actions.find((action) => action.invocation.kind === "node_repl");
  if (!first || first.invocation.kind !== "node_repl") return undefined;
  if (capability.domain === "computer") {
    const mcp = first.invocation.mcpToolName
      ? " The same actions are also provider tools named mcp__computer-use__<name with non-alphanumerics replaced by _>."
      : "";
    return `How to call: inside the \`${first.invocation.toolName}\` tool, \`await agent.computerUse["<name>"](args)\` with the exact names below (results are MCP-shaped: content[0].text holds JSON).${mcp}`;
  }
  return `How to call: inside the \`${first.invocation.toolName}\` tool, ${first.invocation.expression}.`;
}

function renderCapability(capability: Capability, reasons: readonly string[]): string {
  const state = capability.availability === "available" ? "available" : "UNAVAILABLE";
  const lines = [`### ${capability.displayName} — ${state} [id: ${capability.id}]`];
  lines.push(`Selected because: ${reasons.join(", ")}`);
  if (capability.unavailableReason) {
    lines.push(`Reason: ${capability.unavailableReason}`);
  }
  const available = capability.actions.filter((action) => action.availability === "available");
  const unavailable = capability.actions.filter((action) => action.availability === "unavailable");
  if (capability.availability === "available") {
    const invocation = invocationLine(capability);
    if (invocation) lines.push(invocation);
    if (available.length > 0 && !ALWAYS_VISIBLE_IDS.has(capability.id)) {
      const toolNote = available.every((action) => action.invocation.kind === "tool")
        ? " (exact input schemas are in your tool list)"
        : "";
      lines.push(`Actions${toolNote}:`, ...available.map(actionLine));
    }
    lines.push(...unavailableLines(unavailable));
  }
  for (const limit of capability.limits ?? []) lines.push(`Limit: ${limit}`);
  const skills = relevantSkills(capability, reasons);
  if (skills.length > 0) {
    lines.push(
      `Related skills (load with the Skill tool only if you need workflow guidance): ${skills.join(", ")}`,
    );
  }
  return lines.join("\n");
}

function executionLine(snapshot: CapabilitySnapshot): string {
  if (snapshot.target.kind === "local") return "Execution: this Mac (local).";
  const name = snapshot.target.displayName ? `"${snapshot.target.displayName}" ` : "";
  return `Execution: this conversation is bound to the computer ${name}(targetId "${snapshot.target.targetId}"); file, Computer and browser tools still act on this Mac.`;
}

export function renderCapabilityContext(
  snapshot: CapabilitySnapshot,
  selection: CapabilitySelection,
  maxBytes: number = MAX_CAPABILITY_CONTEXT_BYTES,
): string | null {
  const byId = new Map(snapshot.capabilities.map((capability) => [capability.id, capability]));
  const blocks = selection.selected
    .map((entry) => ({ capability: byId.get(entry.capabilityId), reasons: entry.reasons }))
    .filter(
      (item): item is { capability: Capability; reasons: string[] } =>
        item.capability !== undefined && worthRendering(item.capability, item.reasons),
    )
    .map((item) => renderCapability(item.capability, item.reasons));
  if (blocks.length === 0) return null;

  const header = [
    '<capability-context source="acevra-runtime">',
    "Supplied automatically by AceVra from this session's live capability registry; it is not part of the user's request. Use these exact names and argument shapes — do not guess other spellings or probe for methods. Unavailable items are stated with the real reason: tell the user instead of trying variants. The Capabilities tool lists anything not shown here.",
    executionLine(snapshot),
  ].join("\n");
  const footer = "</capability-context>";
  const kept: string[] = [];
  let bytes = Buffer.byteLength(`${header}\n\n${footer}`);
  let dropped = selection.omittedCount;
  for (const block of blocks) {
    const size = Buffer.byteLength(`${block}\n\n`);
    if (bytes + size > maxBytes) {
      dropped += 1;
      continue;
    }
    kept.push(block);
    bytes += size;
  }
  if (kept.length === 0) return null;
  const more =
    dropped > 0
      ? [`(${dropped} more relevant capabilities omitted; call the Capabilities tool.)`]
      : [];
  return [header, "", ...kept.flatMap((block) => [block, ""]), ...more, footer].join("\n");
}
