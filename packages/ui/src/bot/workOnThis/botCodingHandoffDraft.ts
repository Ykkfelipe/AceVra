/**
 * Bot → Coding「Work on this」的草稿构建（docs/specs/cross-mode-bot-to-coding.md §2）。
 *
 * 纯函数，不持有状态：
 * - 摘录只来自**当前**对话的可见文本（用户/Ace 的 text part）；工具输出、推理、附件、合成/隐藏消息
 *   一律不提供。个人记忆是 model-only、非持久的 attachment，transcript 里本就不存在。
 * - 上下文条目只经冻结契约 `createHandoffContextItem` 创建，上限/字节预算由契约裁决，这里不重算规则，
 *   只决定「哪些摘录默认勾选」（最近的、放得进预算的）。
 * - 没有任何记忆/身份/其它对话/连接器条目的入口。
 */
import {
  createHandoffContextItem,
  createHandoffPacket,
  handoffContextItemByteLength,
  HANDOFF_CONTEXT_LIMITS,
  type HandoffContextItem,
  type HandoffObjectRef,
  type HandoffPacket,
} from "@zcode/shared/cross-mode";
import type { ZCodeMessageWithParts } from "@zcode/shared";

export interface BotConversationExcerpt {
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** 摘录候选上限：只提供最近的若干条，避免把整段历史倾倒进对话框。 */
export const MAX_EXCERPT_CANDIDATES = 12;
/** 默认勾选的最近摘录条数（仍受契约字节预算约束）。 */
export const DEFAULT_INCLUDED_EXCERPTS = 4;
/** 单条摘录截断长度（UTF-8 字节，低于契约单条上限，给备注留余量）。 */
const EXCERPT_MAX_BYTES = 1200;
/** 默认勾选摘录占用的总字节上限：给用户备注预留 2 KB。 */
const DEFAULT_EXCERPT_BUDGET_BYTES = HANDOFF_CONTEXT_LIMITS.maxIncludedTotalBytes - 2048;
const OBJECTIVE_MAX_LENGTH = 500;

/** 只接受用户在界面上看得到的真实对话：合成/注入/model-only 消息一律跳过。 */
function isConversationMessage(message: ZCodeMessageWithParts): boolean {
  const info = message.info;
  if ((info.semantics?.uiVisibility ?? "visible") !== "visible") return false;
  if (info.role === "assistant") return true;
  if (info.synthetic || info.source || info.visibility === "model-only") return false;
  return (info.semantics?.origin ?? "real_user") === "real_user";
}

function visibleText(message: ZCodeMessageWithParts): string {
  return message.parts
    .flatMap((part) =>
      part.type === "text" && !part.synthetic && !part.ignored ? [part.text.trim()] : [],
    )
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/** 按 UTF-8 字节截断（不切断代理对），超长时以省略号结尾。 */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (handoffContextItemByteLength(text) <= maxBytes) return text;
  let result = "";
  for (const char of text) {
    if (handoffContextItemByteLength(`${result}${char}…`) > maxBytes) break;
    result += char;
  }
  return `${result.trimEnd()}…`;
}

/** transcript → 最近的可见文本摘录（旧 → 新）。 */
export function extractBotConversationExcerpts(
  messages: readonly ZCodeMessageWithParts[],
): BotConversationExcerpt[] {
  const excerpts: BotConversationExcerpt[] = [];
  for (const message of messages) {
    const role = message.info.role;
    if (!isConversationMessage(message)) continue;
    const text = visibleText(message);
    if (!text) continue;
    excerpts.push({
      messageId: message.info.messageId,
      role,
      text: truncateToBytes(text, EXCERPT_MAX_BYTES),
    });
  }
  return excerpts.slice(-MAX_EXCERPT_CANDIDATES);
}

/** 对话标题 → 默认 objective（契约要求 1–500 字符；空标题由用户填写）。 */
export function defaultHandoffObjective(title: string | null | undefined): string {
  const compact = (title ?? "").trim().replace(/\s+/g, " ");
  return compact.length <= OBJECTIVE_MAX_LENGTH ? compact : compact.slice(0, OBJECTIVE_MAX_LENGTH);
}

export interface BotHandoffLabels {
  /** 摘录标签：按角色给出前缀（例如 "You" / "Ace"）。 */
  excerpt: (role: "user" | "assistant", index: number) => string;
}

/**
 * 摘录 → 契约条目。最近的 DEFAULT_INCLUDED_EXCERPTS 条在预算内默认勾选；其余显式不勾选
 * （`included:false` 由契约记为 user 决定）。每条带回指向原对话的 provenance。
 */
export function buildExcerptContextItems(
  excerpts: readonly BotConversationExcerpt[],
  conversationRef: HandoffObjectRef,
  labels: BotHandoffLabels,
): HandoffContextItem[] {
  let budget = DEFAULT_EXCERPT_BUDGET_BYTES;
  const includedFrom = Math.max(0, excerpts.length - DEFAULT_INCLUDED_EXCERPTS);
  // 从新到旧分配预算，再按旧 → 新输出，保持阅读顺序。
  const includedIds = new Set<string>();
  for (let index = excerpts.length - 1; index >= includedFrom; index -= 1) {
    const excerpt = excerpts[index];
    if (!excerpt) continue;
    const bytes = handoffContextItemByteLength(excerpt.text);
    if (bytes > budget) break;
    budget -= bytes;
    includedIds.add(excerpt.messageId);
  }
  return excerpts.map((excerpt, index) =>
    createHandoffContextItem({
      id: `excerpt-${excerpt.messageId}`.slice(0, 64),
      label: labels.excerpt(excerpt.role, index),
      content: excerpt.text,
      provenance: [conversationRef],
      ...(includedIds.has(excerpt.messageId) ? {} : { included: false }),
    }),
  );
}

export const NOTES_ITEM_ID = "notes";

export interface BotCodingHandoffDraftInput {
  conversationRef: HandoffObjectRef;
  objective: string;
  /** 用户写的备注；空白则不生成条目。 */
  notes: string;
  /** 备注条目标签（本地化文案，随条目带给 Coding agent）。 */
  notesLabel: string;
  /** 已按用户勾选状态维护好的摘录条目（来自 buildExcerptContextItems + 契约编辑原语）。 */
  excerptItems: readonly HandoffContextItem[];
  handoffId?: string;
  createdAt?: number;
}

/**
 * 当前对话框状态 → 冻结契约草稿（bot → coding）。objective 不合法时契约会抛错，
 * 调用方用 `tryBuildBotCodingHandoffDraft` 拿可展示的结果。
 */
export function buildBotCodingHandoffDraft(input: BotCodingHandoffDraftInput): HandoffPacket {
  const notes = input.notes.trim();
  const context: HandoffContextItem[] = [
    ...(notes
      ? [
          createHandoffContextItem({
            id: NOTES_ITEM_ID,
            label: input.notesLabel,
            content: notes,
            provenance: [input.conversationRef],
          }),
        ]
      : []),
    ...input.excerptItems,
  ];
  return createHandoffPacket({
    sourceMode: "bot",
    destinationMode: "coding",
    objective: input.objective.trim(),
    // 回程是摘要（coding → bot）；产物回带留给回程里程碑决定。
    returnPolicy: "summary",
    sourceRefs: [input.conversationRef],
    context,
    // v1 项目引用需要不透明 id，还没有路径 → 项目 id 的规范映射；目的 workspace 由 origin 记录。
    linkedProject: null,
    ...(input.handoffId ? { handoffId: input.handoffId } : {}),
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
  });
}

export type TryBuildDraftResult =
  | { ok: true; packet: HandoffPacket }
  | { ok: false; message: string };

export function tryBuildBotCodingHandoffDraft(
  input: BotCodingHandoffDraftInput,
): TryBuildDraftResult {
  try {
    return { ok: true, packet: buildBotCodingHandoffDraft(input) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
