/**
 * Bot 工作区选择与刷新的纯规则（docs/specs/personal-bot.md §16.4），与 React 无关，便于单测。
 */
import type { BotConversationRow } from "@/bot/botConversationHistory.js";

/**
 * 建会话只可能从草稿发起。ACK 到达时若用户已切到别的对话，这条 ACK 已过期：
 * 选择保持不变（新会话照样出现在历史里），否则慢一步的 ACK 会把用户从刚点开的对话拉走。
 */
export function selectionAfterSessionCreated(
  currentSelection: string | null,
  createdSessionId: string,
): string | null {
  return currentSelection === null ? createdSessionId : currentSelection;
}

/** delete / sessionNotFound 只清除仍被选中的那个会话；用户已切走时不动选择。 */
export function selectionAfterBoundSessionLost(
  currentSelection: string | null,
  lostSessionId: string | null,
): string | null {
  return currentSelection === lostSessionId ? null : currentSelection;
}

export interface BotPresentationFacts {
  sessionId: string;
  title: string;
  sessionEnded: boolean;
}

/** 标题落定、会话首次出现、或一轮结束（updatedAt 变化影响排序）时才需要重读历史。 */
export function presentationNeedsHistoryRefresh(
  rows: readonly BotConversationRow[],
  presentation: BotPresentationFacts,
): boolean {
  const row = rows.find((item) => item.sessionId === presentation.sessionId);
  if (!row) return true;
  if (row.title !== presentation.title.trim()) return true;
  return presentation.sessionEnded;
}

/**
 * 单飞 + 一次尾随：进行中再次请求只记一次尾随，结束后用最新的任务补跑一次。
 * 事件驱动的刷新据此合并，不需要定时器。
 */
export function createSingleFlight() {
  let inflight: Promise<void> | null = null;
  let trailing: (() => Promise<void>) | null = null;

  const run = (task: () => Promise<void>): Promise<void> => {
    if (inflight) {
      trailing = task;
      return inflight;
    }
    inflight = (async () => {
      try {
        await task();
      } finally {
        inflight = null;
        const next = trailing;
        trailing = null;
        if (next) void run(next);
      }
    })();
    return inflight;
  };

  return { run };
}
