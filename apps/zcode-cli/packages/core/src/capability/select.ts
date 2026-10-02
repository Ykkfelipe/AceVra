// 确定性相关性选择：只用域词表、显式 plugin 引用、执行目标与目标名，不调用任何模型。
// 每个入选能力都带可解释的 reasons，测试直接断言 reasons。
import type {
  Capability,
  CapabilityDomain,
  CapabilitySelection,
  CapabilitySelectionEntry,
  CapabilitySnapshot,
} from "@zcode/contracts";
import { COMPUTER_CAPABILITY_ID } from "./computer.js";
import { DOMAIN_LEXICON, LOCAL_ONLY_KEYWORDS } from "./domains.js";

export const DEFAULT_MAX_SELECTED_CAPABILITIES = 6;
const MAX_REASONS_PER_SOURCE = 3;
const REMOTE_DOMAINS: ReadonlySet<CapabilityDomain> = new Set([
  "remote_computer",
  "execution_targets",
]);

export interface CapabilitySelectionInput {
  /** canonical 用户文本（已持久化的 displayInput），不是命令模板展开结果。 */
  text: string;
  /** 本轮严格解析出的 plugin stable id（plugin://name@marketplace）。 */
  pluginReferences?: readonly string[];
  maxCapabilities?: number;
}

const ASCII_TERM = /^[\x20-\x7e]+$/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** ASCII 词按词边界匹配（"chrome" 不命中 "chromedriver"）；CJK 词按子串匹配。 */
export function textMentions(normalizedText: string, term: string): boolean {
  const lowered = term.toLowerCase();
  if (!ASCII_TERM.test(lowered)) return normalizedText.includes(lowered);
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(lowered)}([^a-z0-9]|$)`, "u").test(normalizedText);
}

function lexiconFor(domain: CapabilityDomain): readonly string[] {
  if (REMOTE_DOMAINS.has(domain)) {
    // 远程两域共用意图词：要远程跑命令的请求也可能需要远程屏幕，反之亦然。
    return [...(DOMAIN_LEXICON.remote_computer ?? []), ...(DOMAIN_LEXICON.execution_targets ?? [])];
  }
  return DOMAIN_LEXICON[domain] ?? [];
}

function matches(text: string, terms: readonly string[], prefix: string): string[] {
  return [...new Set(terms)]
    .filter((term) => term.length > 0 && textMentions(text, term))
    .slice(0, MAX_REASONS_PER_SOURCE)
    .map((term) => `${prefix}:${term}`);
}

function reasonsFor(
  capability: Capability,
  snapshot: CapabilitySnapshot,
  text: string,
  references: ReadonlySet<string>,
): string[] {
  const reasons: string[] = [];
  if (capability.pluginId && references.has(capability.pluginId)) {
    reasons.push(`plugin_reference:${capability.pluginId}`);
  }
  if (
    snapshot.target.kind === "remote" &&
    (capability.domain === "execution_targets" || capability.id === "native.shell")
  ) {
    reasons.push("selected_target");
  }
  if (REMOTE_DOMAINS.has(capability.domain)) {
    reasons.push(...matches(text, capability.keywords, "target_name"));
  }
  reasons.push(...matches(text, lexiconFor(capability.domain), "keyword"));
  if (capability.domain === "mcp" || capability.source === "plugin") {
    const prefix = capability.domain === "mcp" ? "mcp_name" : "plugin_name";
    reasons.push(...matches(text, capability.keywords, prefix));
  }
  return [...new Set(reasons)];
}

function hasRemoteIntent(
  entries: readonly CapabilitySelectionEntry[],
  byId: Map<string, Capability>,
): boolean {
  return entries.some((entry) => {
    const capability = byId.get(entry.capabilityId);
    return capability !== undefined && REMOTE_DOMAINS.has(capability.domain);
  });
}

function priority(entry: CapabilitySelectionEntry): number {
  return entry.reasons.some((reason) => reason.startsWith("plugin_reference:")) ? 1 : 0;
}

export function selectRelevantCapabilities(
  snapshot: CapabilitySnapshot,
  input: CapabilitySelectionInput,
): CapabilitySelection {
  const text = input.text.toLowerCase();
  const references = new Set(input.pluginReferences ?? []);
  const byId = new Map(snapshot.capabilities.map((capability) => [capability.id, capability]));
  let entries: CapabilitySelectionEntry[] = snapshot.capabilities
    .map((capability) => ({
      capabilityId: capability.id,
      reasons: reasonsFor(capability, snapshot, text, references),
    }))
    .filter((entry) => entry.reasons.length > 0);

  // 远程意图（目标名 / 远程词）压制本机 Computer 的纯关键词命中，避免"用我的 Dell"
  // 把本机 Mac 的 Computer 也塞给模型；显式本机词或 plugin 引用仍保留。
  const explicitLocal = LOCAL_ONLY_KEYWORDS.some((term) => textMentions(text, term));
  if (hasRemoteIntent(entries, byId) && !explicitLocal) {
    entries = entries
      .map((entry) =>
        entry.capabilityId === COMPUTER_CAPABILITY_ID
          ? { ...entry, reasons: entry.reasons.filter((reason) => !reason.startsWith("keyword:")) }
          : entry,
      )
      .filter((entry) => entry.reasons.length > 0);
  }

  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (left, right) =>
        priority(right.entry) - priority(left.entry) ||
        right.entry.reasons.length - left.entry.reasons.length ||
        left.index - right.index,
    )
    .map(({ entry }) => entry);
  const max = input.maxCapabilities ?? DEFAULT_MAX_SELECTED_CAPABILITIES;
  return {
    selected: ordered.slice(0, max),
    omittedCount: Math.max(0, ordered.length - max),
  };
}
