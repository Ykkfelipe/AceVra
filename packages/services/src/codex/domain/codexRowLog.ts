// v4 行日志存储（domain，纯数据结构）。
// rowId 会话内单调、永不复用；entityId（codex-item-<id>）→ rowId 反查表供
// 通知归约定位既有行；rowsRange 提供有界尾部/游标分页。
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { CodexServerNotification } from "./codexWire.js";

export function rowBase(rowId: number, turnId: string, entityId: string, createdAt: number) {
  return { rowId, turnId, entityId, createdAt, createdAtSeq: rowId } as const;
}

/** 工具行的结构化输入摘要：命令原文 / 文件清单 / server.tool / 查询词。 */
export function codexToolInputText(item: Extract<CodexServerNotification, { type: "itemStarted" }>["item"]): string {
  switch (item.kind) {
    case "commandExecution":
      return item.command;
    case "fileChange":
      return item.changes.map((change) => `${change.kind} ${change.path}`).join("\n");
    case "mcpToolCall":
      return `${item.server}.${item.tool}`;
    case "webSearch":
      return item.query;
    default:
      return "";
  }
}

/** 会不会渲染成 toolCall 行（审批锚点 / 冷恢复的落行判定都用它）。 */
export function isToolItemKind(kind: Extract<CodexServerNotification, { type: "itemStarted" }>["item"]["kind"]): boolean {
  return kind === "commandExecution" || kind === "fileChange" || kind === "mcpToolCall" || kind === "webSearch";
}

export class CodexRowLog {
  readonly #rows: ConversationRow[] = [];
  readonly #rowIdByEntity = new Map<string, number>();
  #nextRowId = 1;

  allocateRowId(): number {
    return this.#nextRowId++;
  }

  get rows(): readonly ConversationRow[] {
    return this.#rows;
  }

  rowIdOfEntity(entityId: string): number | undefined {
    return this.#rowIdByEntity.get(entityId);
  }

  rowAt(rowId: number): ConversationRow | undefined {
    return this.#rows.find((row) => row.rowId === rowId);
  }

  /** 追加行并登记 entityId；返回 append delta。 */
  append(row: ConversationRow): { op: "row.appended"; row: ConversationRow } {
    this.#rows.push(row);
    this.#rowIdByEntity.set(row.entityId ?? `codex-row-${row.rowId}`, row.rowId);
    return { op: "row.appended", row };
  }

  /** 按 rowId 整行替换；返回 upsert delta。 */
  upsert(row: ConversationRow): { op: "row.upserted"; row: ConversationRow } {
    const index = this.#rows.findIndex((entry) => entry.rowId === row.rowId);
    if (index >= 0) this.#rows[index] = row;
    return { op: "row.upserted", row };
  }

  /** itemId/entityId 关联：流式行映射。 */
  trackEntity(entityId: string, rowId: number): void {
    this.#rowIdByEntity.set(entityId, rowId);
  }

  lastToolRowId(): number | null {
    for (let index = this.#rows.length - 1; index >= 0; index -= 1) {
      const row = this.#rows[index];
      if (row?.kind === "toolCall") return row.rowId;
    }
    return null;
  }

  range(params: { beforeRowId?: number; limit: number }): ConversationRow[] {
    const limit = Math.max(1, Math.min(params.limit, 200));
    const source =
      params.beforeRowId === undefined
        ? this.#rows
        : this.#rows.filter((row) => row.rowId < params.beforeRowId!);
    return source.slice(-limit);
  }
}
