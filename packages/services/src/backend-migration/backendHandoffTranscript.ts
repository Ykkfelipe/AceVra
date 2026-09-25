// Conversation row → 归一化 handoff transcript 的纯转换（phase 11，无 IO/无模型调用）。
// 输入必须是组合后的规范时间线（shared/backend-timeline.ts）：handoff 轮与迁移种子行已由
// 组合器按段边界排除，这里不再做基于 rowId 的二次排除（Amendment 4）。
// 见 packages/services/specs/backend-migration.md「Normalized handoff transcript」
// 「Canonical history must never accumulate handoff turns」两节。
//
// zcode 和 Codex 的历史都先落到同一份 ConversationRow[]（Codex 经 CodexThreadProjection
// 投影，见 codexProjection.ts），所以这里只需要一个转换器，不需要区分来源后端。
import type {
  BackendHandoffEntry,
  BackendHandoffTranscript,
  ZCodeExecutionBackend,
} from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

const TOOL_INPUT_PREVIEW_MAX_CHARS = 120;

function truncateForPreview(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}…`;
}

function summarizeToolCallRow(row: Extract<ConversationRow, { kind: "toolCall" }>): string | null {
  // 只有终态才值得进 transcript；中间态（inputStreaming/pendingApproval/running）
  // 不会出现在「已经发生的历史」里——防御性过滤，正常持久化历史不应该带着这些状态。
  if (row.status !== "success" && row.status !== "error" && row.status !== "cancelled") return null;
  const outcome =
    row.status === "success" ? "completed" : row.status === "error" ? "failed" : "cancelled";
  const inputPreview = row.inputText
    ? `: ${truncateForPreview(row.inputText, TOOL_INPUT_PREVIEW_MAX_CHARS)}`
    : "";
  // 只留一行结果描述，绝不带原始 tool 输出/diff/完整命令输出——这是 spec 明确要求排除的。
  return `${row.toolName} ${outcome}${inputPreview}`;
}

function summarizeSubagentRow(row: Extract<ConversationRow, { kind: "subagent" }>): string | null {
  if (row.status === "running") return null;
  return `Subagent ${row.subagentType} ${row.status}: ${truncateForPreview(row.summaryText, TOOL_INPUT_PREVIEW_MAX_CHARS)}`;
}

function summarizeArtifactRow(row: Extract<ConversationRow, { kind: "artifact" }>): string {
  return `Artifact available: ${row.displayName} (${row.artifactType})`;
}

export interface BuildHandoffTranscriptParams {
  readonly taskId: string;
  readonly sourceBackend: ZCodeExecutionBackend;
  readonly rows: readonly ConversationRow[];
  readonly generatedAt: number;
}

/**
 * 把一份 ConversationRow[] 转成归一化 handoff transcript。`compacted` 恒为 false——
 * 是否需要压缩、以及压缩后的结果，由 backendHandoffCompaction.ts 在这之后单独判断，
 * 这个函数只负责「规范的历史应该长什么样」，不掺进"要不要塞得下"的决策。
 */
export function buildHandoffTranscript(
  params: BuildHandoffTranscriptParams,
): BackendHandoffTranscript {
  const entries: BackendHandoffEntry[] = [];
  for (const row of params.rows) {
    switch (row.kind) {
      case "userInput":
        if (row.text.trim().length === 0) continue;
        entries.push({ role: "user", content: row.text, timestamp: row.createdAt });
        continue;
      case "assistantText":
        // streaming/interrupted/failed 不是「已经发生」的定稿内容；已持久化历史里
        // 正常只会有 complete，这里防御性跳过其余状态。
        if (row.state !== "complete" || row.text.trim().length === 0) continue;
        entries.push({ role: "assistant", content: row.text, timestamp: row.createdAt });
        continue;
      case "reasoning":
        // 隐藏思维链——明确排除，不是遗漏（spec「What is excluded」）。
        continue;
      case "toolCall": {
        const summary = summarizeToolCallRow(row);
        if (summary)
          entries.push({ role: "tool_summary", content: summary, timestamp: row.createdAt });
        continue;
      }
      case "subagent": {
        const summary = summarizeSubagentRow(row);
        if (summary)
          entries.push({ role: "tool_summary", content: summary, timestamp: row.createdAt });
        continue;
      }
      case "artifact":
        entries.push({
          role: "task_note",
          content: summarizeArtifactRow(row),
          timestamp: row.createdAt,
        });
        continue;
      // turnHeader/hookInvocation/timelineMarker（backendTransition 以外的类型）都是结构化
      // 书签或内部编排细节，不是用户可见的任务内容——不进 transcript。这是一个明确的范围
      // 选择，不是遗漏：goalSet/modelChange 这类 marker 记录的是导航状态，不是「决定」。
      case "turnHeader":
      case "hookInvocation":
      case "timelineMarker":
        continue;
      default: {
        // 穷尽性闸门：conversationRowSchema 新增一种 kind 时这里编译失败——
        // 必须显式决定新行是否进 transcript，不能让它悄悄漏进/漏出。
        const exhaustive: never = row;
        throw new Error(`Unhandled conversation row kind: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  return {
    taskId: params.taskId,
    generatedAt: params.generatedAt,
    sourceBackend: params.sourceBackend,
    entries,
    compacted: false,
  };
}
