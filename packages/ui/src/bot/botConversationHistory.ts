/**
 * Bot 对话历史的纯投影（docs/specs/personal-bot.md §16.3）。
 *
 * 输入是 CLI session store 经 `session/list`（projection = personal-bot）返回的会话事实；
 * 这里只做展示投影：去重、按最近活动排序、按本地日期分组。不持有状态，也不补造会话。
 */
import type { ZCodeSessionInfo } from "@zcode/shared";

export interface BotConversationRow {
  sessionId: string;
  /** 空串表示还没有标题（首条输入尚未落定），由 UI 显示「New conversation」。 */
  title: string;
  createdAt: number;
  updatedAt: number;
}

export type BotConversationGroupId = "today" | "yesterday" | "previous7Days" | "older";

export interface BotConversationGroup {
  id: BotConversationGroupId;
  rows: BotConversationRow[];
}

const GROUP_ORDER: readonly BotConversationGroupId[] = [
  "today",
  "yesterday",
  "previous7Days",
  "older",
];
const DAY_MS = 24 * 60 * 60 * 1000;
const PREVIOUS_DAYS_WINDOW = 7;

/** 只接受 personal_bot：投影由 CLI 保证，这里再挡一次，防止旧 CLI 忽略 projection 后把 Coding 会话混进来。 */
export function toBotConversationRows(sessions: readonly ZCodeSessionInfo[]): BotConversationRow[] {
  const byId = new Map<string, BotConversationRow>();
  for (const session of sessions) {
    if (session.sessionKind !== "personal_bot") continue;
    if (session.archivedAt !== undefined) continue;
    const row: BotConversationRow = {
      sessionId: session.sessionId,
      title: session.title.trim(),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
    const existing = byId.get(row.sessionId);
    if (!existing || existing.updatedAt < row.updatedAt) byId.set(row.sessionId, row);
  }
  return [...byId.values()].sort(compareRowsByRecency);
}

function compareRowsByRecency(left: BotConversationRow, right: BotConversationRow): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
  return left.sessionId.localeCompare(right.sessionId);
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function resolveBotConversationGroupId(
  updatedAt: number,
  now: number,
): BotConversationGroupId {
  const todayStart = startOfLocalDay(now);
  if (updatedAt >= todayStart) return "today";
  // 夏令时切换日不是 24h，用本地日界而不是 now - 24h。
  const yesterdayStart = startOfLocalDay(todayStart - DAY_MS / 2);
  if (updatedAt >= yesterdayStart) return "yesterday";
  const windowStart = startOfLocalDay(todayStart - PREVIOUS_DAYS_WINDOW * DAY_MS + DAY_MS / 2);
  if (updatedAt >= windowStart) return "previous7Days";
  return "older";
}

/** 分组保持行的相对顺序（行已按最近活动排序），空组不输出。 */
export function groupBotConversationRows(
  rows: readonly BotConversationRow[],
  now: number,
): BotConversationGroup[] {
  const buckets = new Map<BotConversationGroupId, BotConversationRow[]>();
  for (const row of rows) {
    const groupId = resolveBotConversationGroupId(row.updatedAt, now);
    const bucket = buckets.get(groupId);
    if (bucket) bucket.push(row);
    else buckets.set(groupId, [row]);
  }
  return GROUP_ORDER.flatMap((id) => {
    const groupRows = buckets.get(id);
    return groupRows ? [{ id, rows: groupRows }] : [];
  });
}
