/**
 * 个人记忆：记录形状 + 有界相关性检索。纯函数，无 IO。
 *
 * 核心不变量（M1 spec §6.2）：任何调用都不得把整个记忆库注入上下文。
 * 条数与字节数都有硬上限，渲染在记录边界截断，且始终报告被省略的相关条数。
 *
 * 注意与 Project Memory（packages/services/src/memory）区分：那是 coding workspace 的
 * Markdown 记忆，两者不共用存储、不互相写入。
 */

export const PERSONAL_MEMORY_CATEGORIES = [
  "person",
  "project",
  "goal",
  "preference",
  "routine",
  "place",
  "decision",
  "event",
  "situation",
] as const;

export type PersonalMemoryCategory = (typeof PERSONAL_MEMORY_CATEGORIES)[number];

export type PersonalMemorySource = "user" | "bot";

export interface PersonalMemoryRecord {
  id: string;
  category: PersonalMemoryCategory;
  title: string;
  summary: string;
  details?: string;
  tags: string[];
  /** 置顶记忆在任何查询下都优先入选（仍受条数/字节预算约束）。 */
  pinned: boolean;
  source: PersonalMemorySource;
  createdAt: number;
  updatedAt: number;
}

/** 新建记忆时的入参：id/时间戳由调用方（app 层）补齐。 */
export interface PersonalMemoryInput {
  /** 给出 id 时按 id 覆盖既有记录（upsert）；缺省则新建。 */
  id?: string;
  category: PersonalMemoryCategory;
  title: string;
  summary: string;
  details?: string;
  tags?: string[];
  pinned?: boolean;
  source?: PersonalMemorySource;
}

export const DEFAULT_MAX_MEMORY_RECORDS = 8;

export const MAX_MEMORY_CONTEXT_BYTES = 4096;

export const MAX_MEMORY_TITLE_LENGTH = 120;

export const MAX_MEMORY_SUMMARY_LENGTH = 400;

const MAX_MEMORY_DETAILS_LENGTH = 2000;

export const MAX_MEMORY_TAGS = 12;

const TITLE_WEIGHT = 4;

const TAG_WEIGHT = 3;

const SUMMARY_WEIGHT = 2;

const DETAILS_WEIGHT = 1;

export interface PersonalMemorySelection {
  selected: PersonalMemoryRecord[];
  /** 命中（置顶或相关性 > 0）但未入选的条数。 */
  omittedCount: number;
  /** 命中总数，= selected.length + omittedCount。 */
  eligibleCount: number;
}

export interface PersonalMemoryContext {
  /** 已渲染的上下文文本；无命中时为空串。 */
  text: string;
  selected: PersonalMemoryRecord[];
  omittedCount: number;
  byteLength: number;
}

interface PersonalMemoryLimits {
  /** 入选条数上限；字节预算属于渲染阶段（renderPersonalMemoryContext）。 */
  maxRecords?: number;
}

function clampText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const entry of value) {
    const tag = clampText(entry, 48);
    if (tag.length === 0 || tags.includes(tag)) continue;
    tags.push(tag);
    if (tags.length >= MAX_MEMORY_TAGS) break;
  }
  return tags;
}

function isCategory(value: unknown): value is PersonalMemoryCategory {
  return (
    typeof value === "string" && (PERSONAL_MEMORY_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * 归一化来自持久化或调用方的记录。缺 category/title 的记录不可修复，返回 null 由调用方丢弃。
 */
export function normalizePersonalMemoryRecord(
  input: unknown,
  now: number,
): PersonalMemoryRecord | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Partial<PersonalMemoryRecord>;
  if (!isCategory(candidate.category)) return null;
  const title = clampText(candidate.title, MAX_MEMORY_TITLE_LENGTH);
  if (title.length === 0) return null;
  const id = clampText(candidate.id, 128);
  if (id.length === 0) return null;

  const details = clampText(candidate.details, MAX_MEMORY_DETAILS_LENGTH);
  const createdAt = typeof candidate.createdAt === "number" ? candidate.createdAt : now;
  const updatedAt = typeof candidate.updatedAt === "number" ? candidate.updatedAt : createdAt;

  return {
    id,
    category: candidate.category,
    title,
    summary: clampText(candidate.summary, MAX_MEMORY_SUMMARY_LENGTH),
    ...(details.length > 0 ? { details } : {}),
    tags: normalizeTags(candidate.tags),
    pinned: candidate.pinned === true,
    source: candidate.source === "bot" ? "bot" : "user",
    createdAt,
    updatedAt,
  };
}

/**
 * 查询分词：拉丁词 + CJK 二元组。中文没有词边界，二元组足以支撑相关性排序，
 * 且不引入分词依赖，保证检索是确定性的纯函数。
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(/[a-z0-9][a-z0-9_+-]*/g)) {
    if (match[0].length >= 2) tokens.add(match[0]);
  }
  for (const run of lower.replace(/[^\u4e00-\u9fff]+/g, " ").split(" ")) {
    for (let index = 0; index + 2 <= run.length; index += 1) {
      tokens.add(run.slice(index, index + 2));
    }
  }
  return tokens;
}

function overlapCount(text: string, queryTokens: Set<string>): number {
  if (text.length === 0) return 0;
  const tokens = tokenize(text);
  let overlap = 0;
  for (const token of tokens) {
    if (queryTokens.has(token)) overlap += 1;
  }
  return overlap;
}

function relevanceScore(record: PersonalMemoryRecord, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  let score = overlapCount(record.title, queryTokens) * TITLE_WEIGHT;
  score += overlapCount(record.tags.join(" "), queryTokens) * TAG_WEIGHT;
  score += overlapCount(record.summary, queryTokens) * SUMMARY_WEIGHT;
  score += overlapCount(record.details ?? "", queryTokens) * DETAILS_WEIGHT;
  return score;
}

function compareRecords(
  left: { record: PersonalMemoryRecord; score: number },
  right: { record: PersonalMemoryRecord; score: number },
): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.record.updatedAt !== right.record.updatedAt) {
    return right.record.updatedAt - left.record.updatedAt;
  }
  return left.record.id < right.record.id ? -1 : left.record.id > right.record.id ? 1 : 0;
}

/**
 * 有界相关性选择。
 *
 * - 置顶记录先占预算（按 updatedAt/id 稳定排序）。
 * - 其余记录必须命中查询才入选（score > 0）；空查询只返回置顶记录。
 * - 排序完全确定：score desc → updatedAt desc → id asc。
 */
export function selectRelevantPersonalMemory(
  records: readonly PersonalMemoryRecord[],
  query: string,
  limits: PersonalMemoryLimits = {},
): PersonalMemorySelection {
  const maxRecords = Math.max(0, limits.maxRecords ?? DEFAULT_MAX_MEMORY_RECORDS);

  const pinned: PersonalMemoryRecord[] = [];
  const scored: { record: PersonalMemoryRecord; score: number }[] = [];
  const queryTokens = tokenize(query);

  for (const record of records) {
    if (record.pinned) {
      pinned.push(record);
      continue;
    }
    if (queryTokens.size === 0) continue;
    const score = relevanceScore(record, queryTokens);
    if (score <= 0) continue;
    scored.push({ record, score });
  }

  pinned.sort((left, right) =>
    compareRecords({ record: left, score: 0 }, { record: right, score: 0 }),
  );
  scored.sort(compareRecords);

  const selected: PersonalMemoryRecord[] = [];
  for (const record of pinned) {
    if (selected.length >= maxRecords) break;
    selected.push(record);
  }
  for (const entry of scored) {
    if (selected.length >= maxRecords) break;
    selected.push(entry.record);
  }

  const eligibleCount = pinned.length + scored.length;
  return {
    selected,
    eligibleCount,
    omittedCount: eligibleCount - selected.length,
  };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

const CONTEXT_HEADER =
  "Personal memory (remembered from earlier conversations with this user; only entries relevant to the current request):";

function renderRecordLine(record: PersonalMemoryRecord): string {
  const detail = record.summary.length > 0 ? ` — ${record.summary}` : "";
  return `- [${record.category}] ${record.title}${detail}`;
}

function renderTrailer(omittedCount: number): string {
  return `\n(${omittedCount} more relevant ${omittedCount === 1 ? "memory" : "memories"} omitted)`;
}

/**
 * 渲染有界上下文：按记录边界截断，UTF-8 字节数不超过 maxBytes。
 * 截断时把剩余命中计入 omitted 提示，调用方仍能告诉模型“还有更多”。
 */
export function renderPersonalMemoryContext(
  selection: PersonalMemorySelection,
  limits: { maxBytes?: number } = {},
): PersonalMemoryContext {
  const maxBytes = Math.max(0, limits.maxBytes ?? MAX_MEMORY_CONTEXT_BYTES);
  if (selection.selected.length === 0) {
    return { text: "", selected: [], omittedCount: selection.omittedCount, byteLength: 0 };
  }

  const lines = selection.selected.map(renderRecordLine);
  let keptCount = lines.length;

  const compose = (count: number): string => {
    if (count === 0) return "";
    const omitted = selection.eligibleCount - count;
    const body = `${CONTEXT_HEADER}\n${lines.slice(0, count).join("\n")}`;
    return omitted > 0 ? `${body}${renderTrailer(omitted)}` : body;
  };

  let text = compose(keptCount);
  // 超预算时逐条回退，保证在记录边界截断且始终留有 omitted 提示。
  while (keptCount > 0 && byteLength(text) > maxBytes) {
    keptCount -= 1;
    text = compose(keptCount);
  }
  if (keptCount === 0) {
    return { text: "", selected: [], omittedCount: selection.omittedCount, byteLength: 0 };
  }

  return {
    text,
    selected: selection.selected.slice(0, keptCount),
    omittedCount: selection.eligibleCount - keptCount,
    byteLength: byteLength(text),
  };
}
