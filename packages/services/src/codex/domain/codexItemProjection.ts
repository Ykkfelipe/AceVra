// Codex item 事件 → v4 行增量的纯归约（domain）。
//
// 冷/热恢复与实时流共用同一份 item 归约：itemStarted 开流式行、itemDelta 追加文本或
// commandOutput、itemCompleted 落终态。抽出成独立模块，使 CodexThreadProjection 只保留
// turn 生命周期与状态机，item 行构造不再挤进同一个类文件。
//
// 归约不持有状态：调用方（投影）通过 ItemProjectionHost 暴露行日志、流式行索引、
// 当前轮 id、时钟与 commit 回调；本模块只做「给定通知与既有行，算出该写哪些 delta」。
import type { ConversationDelta } from "@zcode/shared/zcode-protocol-v4";
import type { CodexItem } from "./codexWire.js";
import type { CodexRowLog } from "./codexRowLog.js";
import {
  buildCodexToolCallRow,
  buildCompletedStreamedRow,
  buildReplayedHistoryRow,
  buildStreamingTextRow,
  isToolItemKind,
} from "./codexRowLog.js";

/** item 归约所需的最小宿主面（由 CodexThreadProjection 提供）。 */
export interface ItemProjectionHost {
  readonly log: CodexRowLog;
  readonly streamingRowByItemId: Map<string, number>;
  readonly currentTurnId: string | null;
  readonly now: () => number;
  /** 递增 seq/revision 并封装 commit；返回可直接下发的 commit。 */
  commit(deltas: ConversationDelta[]): {
    seq: number;
    revision: number;
    deltas: ConversationDelta[];
  };
}

export type ItemProjectionCommit = ReturnType<ItemProjectionHost["commit"]>;

function appendStreamingRow(
  host: ItemProjectionHost,
  item: { itemId: string | null; text: string },
  kind: "assistantText" | "reasoning",
): ItemProjectionCommit {
  const built = buildStreamingTextRow({
    item,
    kind,
    turnId: host.currentTurnId ?? "codex-turn-unknown",
    allocateRowId: () => host.log.allocateRowId(),
    now: host.now,
  });
  if (item.itemId) host.streamingRowByItemId.set(item.itemId, built.row.rowId);
  return host.commit([host.log.append(built.row)]);
}

/** item/started：agentMessage/reasoning 开流式行；工具 item 开 running 工具行。 */
export function reduceItemStarted(
  host: ItemProjectionHost,
  notification: { item: CodexItem; turnId: string | null },
): ItemProjectionCommit | null {
  const item = notification.item;
  if (notification.turnId) host.log.setSourceTurnId(notification.turnId);
  if (item.kind === "agentMessage" || item.kind === "reasoning") {
    return appendStreamingRow(
      host,
      item,
      item.kind === "agentMessage" ? "assistantText" : "reasoning",
    );
  }
  if (!isToolItemKind(item.kind)) return null;
  const row = buildCodexToolCallRow({
    item,
    turnId: host.currentTurnId ?? "codex-turn-unknown",
    status: "running",
    allocateRowId: () => host.log.allocateRowId(),
    now: host.now,
  });
  if (item.itemId) host.streamingRowByItemId.set(item.itemId, row.rowId);
  return host.commit([host.log.append(row)]);
}

/** item/delta：command/fileChange 输出并入工具行 output；文本并入流式行 text。 */
export function reduceItemDelta(
  host: ItemProjectionHost,
  notification: {
    itemId: string | null;
    append: string;
    deltaKind: string;
  },
): ItemProjectionCommit | null {
  const rowId = notification.itemId
    ? host.streamingRowByItemId.get(notification.itemId)
    : undefined;
  if (rowId === undefined) return null;
  const target = host.log.rowAt(rowId);
  if (!target) return null;
  if (notification.deltaKind === "commandOutput" || notification.deltaKind === "fileChangeOutput") {
    if (target.kind !== "toolCall") return null;
    return host.commit([
      host.log.upsert({
        ...target,
        output: { text: (target.output?.text ?? "") + notification.append },
      }),
    ]);
  }
  if (target.kind !== "assistantText" && target.kind !== "reasoning") return null;
  return host.commit([{ op: "row.delta", rowId, path: "text", append: notification.append }]);
}

/** item/completed：把流式/工具行落终态；按 itemId 幂等 upsert。 */
export function reduceItemCompleted(
  host: ItemProjectionHost,
  item: CodexItem,
): ItemProjectionCommit | null {
  const entityId = item.itemId ? `codex-item-${item.itemId}` : null;
  const rowId = entityId ? host.log.rowIdOfEntity(entityId) : undefined;
  const existing = rowId === undefined ? undefined : host.log.rowAt(rowId);
  const completed = existing ? buildCompletedStreamedRow(existing, item, host.now) : null;
  return completed ? host.commit([host.log.upsert(completed)]) : null;
}

/**
 * 冷恢复回放：把 thread/items/list 的历史条目直接落成终态行。
 * 与 reduceItemCompleted 不同：不要求先出现过 itemStarted（恢复时投影为空）。
 * sourceTurnId 随行保留，后端迁移据此在重建后仍能识别 handoff 轮。
 */
export function replayCompletedItem(
  host: ItemProjectionHost,
  item: CodexItem,
  sourceTurnId?: string | null,
): ItemProjectionCommit | null {
  const entityId = item.itemId ? `codex-item-${item.itemId}` : null;
  const existingRowId = entityId ? host.log.rowIdOfEntity(entityId) : undefined;
  const existing = existingRowId !== undefined ? host.log.rowAt(existingRowId) : undefined;
  const row = buildReplayedHistoryRow({
    item,
    existing,
    turnId: "codex-history",
    allocateRowId: () => host.log.allocateRowId(),
    now: host.now,
  });
  if (!row) return null;
  const tagged = sourceTurnId ? { ...row, sourceTurnId } : row;
  return host.commit([existing ? host.log.upsert(tagged) : host.log.append(tagged)]);
}
