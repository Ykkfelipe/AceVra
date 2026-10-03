/**
 * 无表单「Work on this」（docs/specs/cross-mode-bot-to-coding.md §10）的纯逻辑：
 * - 目标推断：保守，只用已有信息（对话标题 + 最近可见文本 vs. 可写本机项目文件夹名）；
 * - 自动上下文：与 Review 对话框同一组默认（最近摘录在预算内勾选），objective 自动派生。
 * 不调用模型、不挖掘历史、不新建索引；推断不明确就交给轻量 Work in… 选择器。
 */
import type { HandoffObjectRef, HandoffPacket } from "@zcode/shared/cross-mode";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  buildBotCodingHandoffDraft,
  buildExcerptContextItems,
  defaultHandoffObjective,
  extractBotConversationExcerpts,
  type BotConversationExcerpt,
  type BotHandoffLabels,
} from "@/bot/workOnThis/botCodingHandoffDraft.js";
import type { AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";

const MIN_PROJECT_NAME_LENGTH = 3;

function normalizeForMatch(text: string): string {
  // 名称里的 - _ . 与空格视为同一分隔符，避免 "life-craft" 与 "life craft" 不匹配。
  return ` ${text.toLowerCase().replace(/[-_.\s]+/g, " ")} `;
}

function projectFolderName(project: AutomationWorkspaceOption): string {
  const fromPath = project.workspacePath.replace(/\\/g, "/").split("/").filter(Boolean).pop();
  return (fromPath ?? project.label).trim();
}

export type WorkDestinationInference =
  | { kind: "project"; project: AutomationWorkspaceOption }
  | { kind: "ask"; matchedCount: number };

/**
 * 恰好一个项目文件夹名以整词形式出现在标题/最近文本里 → 该项目；零个或多个 → ask。
 * 「通用工作 → Tasks」也走 ask（Tasks 排第一）：宁可多问一次，也不猜错落点。
 */
export function inferWorkDestination(
  title: string | null | undefined,
  excerpts: readonly BotConversationExcerpt[],
  projects: readonly AutomationWorkspaceOption[],
): WorkDestinationInference {
  const haystack = normalizeForMatch([title ?? "", ...excerpts.map((e) => e.text)].join("\n"));
  const matches = projects.filter((project) => {
    const name = projectFolderName(project);
    if (name.length < MIN_PROJECT_NAME_LENGTH) return false;
    const needle = normalizeForMatch(name).trim();
    if (!needle) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "u").test(haystack);
  });
  const [only] = matches;
  return matches.length === 1 && only
    ? { kind: "project", project: only }
    : { kind: "ask", matchedCount: matches.length };
}

/** 标题是真标题就用它；否则（新对话/默认标题）用最近一条用户消息。 */
export function deriveHandoffObjective(
  title: string | null | undefined,
  excerpts: readonly BotConversationExcerpt[],
  placeholderTitles: readonly string[] = [],
): string {
  const trimmed = (title ?? "").trim();
  const usable = trimmed && !placeholderTitles.includes(trimmed) ? trimmed : "";
  if (usable) return defaultHandoffObjective(usable);
  const lastUser = [...excerpts].reverse().find((excerpt) => excerpt.role === "user");
  return defaultHandoffObjective(lastUser?.text ?? "");
}

export interface AutomaticHandoff {
  packet: HandoffPacket;
  excerpts: BotConversationExcerpt[];
}

/** 当前对话 → 自动 bot → coding 草稿（契约裁决上限；摘录默认勾选与 Review 对话框一致）。 */
export function buildAutomaticHandoff(input: {
  conversationRef: HandoffObjectRef;
  title: string | null | undefined;
  rows: readonly ConversationRow[];
  labels: BotHandoffLabels;
  notesLabel: string;
  placeholderTitles?: readonly string[];
}): AutomaticHandoff {
  const excerpts = extractBotConversationExcerpts(input.rows);
  const packet = buildBotCodingHandoffDraft({
    conversationRef: input.conversationRef,
    objective: deriveHandoffObjective(input.title, excerpts, input.placeholderTitles),
    notes: "",
    notesLabel: input.notesLabel,
    excerptItems: buildExcerptContextItems(excerpts, input.conversationRef, input.labels),
  });
  return { packet, excerpts };
}
