// Handoff transcript 的「装不装得下」判断与压缩（phase 11）。
// 见 backend-migration.md「Oversized transcripts: reuse the existing compaction philosophy」。
//
// 不直接复用 apps/zcode-cli/packages/core/src/compact/*：那些函数绑定 AgentRuntimeInternal
// 和 CLI 内部的 AutoCompactPolicyConfig/CompactModelMessage 类型，packages/services 不应该
// 跨包依赖 apps/zcode-cli 的内部实现（同一条边界原则：Host 只经 stdio 与 Agent 通信）。
// 这里按同样的「预留输出空间 + 安全缓冲」思路重新实现一份更小的版本，量体裁衣：
// 迁移只需要「这次 handoff 装不装得下」的一次性判断，不需要 CLI 那套持续运行的 auto-compact
// 决策机器。token 估算公式与 apps/zcode-cli/packages/core/src/context/utils.ts#estimateTokens
// 保持一致（同一个共享除数常量 ESTIMATED_TOKEN_CHAR_DIVISOR），避免同一份历史在两处估出
// 差异很大的数字。
import {
  ESTIMATED_TOKEN_CHAR_DIVISOR,
  type BackendHandoffEntry,
  type BackendHandoffTranscript,
} from "@zcode/shared";

const CHINESE_CHAR_PATTERN = /[一-鿿]/gu;

/** 与 estimateTokens（apps/zcode-cli）同一公式：中文字符按两个字符计入。 */
export function estimateHandoffEntryTokens(entry: BackendHandoffEntry): number {
  const text = entry.content;
  const chineseChars = (text.match(CHINESE_CHAR_PATTERN) ?? []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil((chineseChars * 2 + otherChars) / ESTIMATED_TOKEN_CHAR_DIVISOR);
}

export function estimateHandoffTranscriptTokens(entries: readonly BackendHandoffEntry[]): number {
  return entries.reduce((total, entry) => total + estimateHandoffEntryTokens(entry), 0);
}

export interface HandoffCompactionBudget {
  readonly contextWindowTokens: number;
  /** 给目标端「回应/继续任务」预留的输出空间；不算进能塞给它的历史预算里。 */
  readonly outputReserveTokens?: number;
  /** 额外安全缓冲，对齐 apps/zcode-cli 的 AUTOCOMPACT_BUFFER_TOKENS 思路。 */
  readonly bufferTokens?: number;
}

const DEFAULT_OUTPUT_RESERVE_TOKENS = 8_000;
const DEFAULT_BUFFER_TOKENS = 2_000;
/** Codex 尚未在 CODEX_MODEL_OPTIONS 里携带真实 context window（见 spec「Explicitly out of
 *  scope」）；这个保守预算只在目标是 Codex 且调用方没有显式传入更精确的值时使用。 */
export const CONSERVATIVE_CODEX_CONTEXT_WINDOW_TOKENS = 100_000;

function resolveThreshold(budget: HandoffCompactionBudget): number {
  const outputReserve = budget.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
  const buffer = budget.bufferTokens ?? DEFAULT_BUFFER_TOKENS;
  return Math.max(0, budget.contextWindowTokens - outputReserve - buffer);
}

export function handoffTranscriptFitsBudget(
  entries: readonly BackendHandoffEntry[],
  budget: HandoffCompactionBudget,
): boolean {
  return estimateHandoffTranscriptTokens(entries) <= resolveThreshold(budget);
}

/** 尾部预算只吃阈值的一部分，给即将生成的摘要本身，以及目标端的首轮回应留出空间。 */
const TAIL_BUDGET_FRACTION = 0.6;

interface SplitForCompactionResult {
  readonly prefix: readonly BackendHandoffEntry[];
  readonly tail: readonly BackendHandoffEntry[];
}

/** 从末尾向前尽量多留「最近的原文」，其余归进要被摘要的前缀。 */
function splitForCompaction(
  entries: readonly BackendHandoffEntry[],
  budget: HandoffCompactionBudget,
): SplitForCompactionResult {
  const tailBudget = Math.floor(resolveThreshold(budget) * TAIL_BUDGET_FRACTION);
  let runningTotal = 0;
  let splitIndex = entries.length;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entryTokens = estimateHandoffEntryTokens(entries[i]!);
    if (splitIndex !== entries.length && runningTotal + entryTokens > tailBudget) break;
    runningTotal += entryTokens;
    splitIndex = i;
  }
  return { prefix: entries.slice(0, splitIndex), tail: entries.slice(splitIndex) };
}

export type SummarizeHandoffPrefix = (prefix: readonly BackendHandoffEntry[]) => Promise<string>;

export interface CompactHandoffTranscriptIfNeededParams {
  readonly transcript: BackendHandoffTranscript;
  readonly budget: HandoffCompactionBudget;
  /** 真实的摘要模型调用；注入而不是内建，迁移编排层决定用哪个 provider/model 生成摘要。
   *  这个调用失败即视为迁移失败（compaction_failed），绝不吞掉错误后静默截断历史。 */
  readonly summarizePrefix: SummarizeHandoffPrefix;
  readonly now: () => number;
}

/**
 * 装得下就原样返回（compacted 保持 false）；装不下就摘要旧的一半、原样保留新的一半，
 * 绝不整体丢弃、也绝不因为「太长」本身就失败——只有摘要调用本身失败才是失败
 * （由调用方捕获 summarizePrefix 抛出的错误并记为 compaction_failed）。
 */
export async function compactHandoffTranscriptIfNeeded(
  params: CompactHandoffTranscriptIfNeededParams,
): Promise<BackendHandoffTranscript> {
  const { transcript, budget } = params;
  if (handoffTranscriptFitsBudget(transcript.entries, budget)) {
    return transcript;
  }
  const { prefix, tail } = splitForCompaction(transcript.entries, budget);
  if (prefix.length === 0) {
    // 连「只留尾部」都装不下——通常是单条超大 entry，压缩帮不上忙；按 spec
    // 「never silently drop」原样发送，不能假装压缩成功却其实丢了东西。
    return transcript;
  }
  const summaryText = await params.summarizePrefix(prefix);
  const summaryEntry: BackendHandoffEntry = {
    role: "task_note",
    content: `Prior context summary (compacted from ${prefix.length} earlier entries): ${summaryText}`,
    timestamp: params.now(),
  };
  return {
    ...transcript,
    entries: [summaryEntry, ...tail],
    compacted: true,
  };
}
