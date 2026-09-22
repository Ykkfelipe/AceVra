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

/** 工具行构造（itemId 缺失时用本地行号兜底 id）；冷恢复与实时投影共用。 */
export function buildCodexToolCallRow(options: {
  item: Extract<CodexServerNotification, { type: "itemStarted" }>["item"];
  turnId: string;
  status: "running" | "success" | "error";
  allocateRowId: () => number;
  now: () => number;
}): ConversationRow {
  const { item, turnId, status, allocateRowId, now } = options;
  const createdAt = now();
  const entityId = item.itemId ? `codex-item-${item.itemId}` : `codex-row-${allocateRowId()}`;
  return {
    ...rowBase(allocateRowId(), turnId, entityId, createdAt),
    kind: "toolCall",
    toolCallId: item.itemId ?? `codex-tool-${allocateRowId()}`,
    toolName: `codex.${item.kind}`,
    status,
    inputText: codexToolInputText(item),
    startedAt: createdAt,
    ...(status === "running" ? {} : { endedAt: createdAt }),
  };
}

/** 流式文本行（assistantText/reasoning）构造；entityId 稳定自 itemId。 */
export function buildStreamingTextRow(options: {
  item: { itemId: string | null; text: string };
  kind: "assistantText" | "reasoning";
  turnId: string;
  allocateRowId: () => number;
  now: () => number;
}): { row: ConversationRow } {
  const { item, kind, turnId, allocateRowId, now } = options;
  const entityId = item.itemId ? `codex-item-${item.itemId}` : `codex-row-${allocateRowId()}`;
  const row: ConversationRow = {
    ...rowBase(allocateRowId(), turnId, entityId, now()),
    kind,
    text: item.text,
    state: "streaming",
  };
  return { row };
}

/** 宿主发起用户轮的 turnHeader 行构造。 */
export function buildTurnHeaderRow(options: {
  turnId: string;
  commandId: string;
  rowId: number;
  createdAt: number;
}): ConversationRow {
  const { turnId, commandId, rowId, createdAt } = options;
  return {
    ...rowBase(rowId, turnId, `codex-turn-${turnId}`, createdAt),
    kind: "turnHeader",
    origin: "userInput",
    executionKind: "agent",
    sourceCommandId: commandId,
    state: "running",
    startedAt: createdAt,
  };
}

/** 宿主发起用户轮的 userInput 行构造。 */
export function buildUserInputRow(options: {
  turnId: string;
  text: string;
  commandId: string;
  rowId: number;
  createdAt: number;
}): ConversationRow {
  const { turnId, text, commandId, rowId, createdAt } = options;
  return {
    ...rowBase(rowId, turnId, `codex-input-${turnId}`, createdAt),
    kind: "userInput",
    text,
    origin: "realUser",
    sourceCommandId: commandId,
  };
}

/** 冷恢复：历史条目 → 终态行（文本类直接落行；工具类按 status 判定成败）。 */
export function buildReplayedHistoryRow(options: {
  item: Extract<CodexServerNotification, { type: "itemStarted" }>["item"];
  existing: ConversationRow | undefined;
  turnId: string;
  allocateRowId: () => number;
  now: () => number;
}): ConversationRow | null {
  const { item, existing, turnId, allocateRowId, now } = options;
  const failed = item.status != null && /fail|error/i.test(item.status);
  if (item.kind === "agentMessage" || item.kind === "reasoning") {
    const kind = item.kind === "agentMessage" ? ("assistantText" as const) : ("reasoning" as const);
    if (existing?.kind === kind) return { ...existing, text: item.text, state: "complete" };
    const entityId = item.itemId ? `codex-item-${item.itemId}` : `codex-row-${allocateRowId()}`;
    return {
      ...rowBase(allocateRowId(), turnId, entityId, now()),
      kind,
      text: item.text,
      state: "complete",
    };
  }
  if (!isToolItemKind(item.kind)) return null;
  if (existing?.kind === "toolCall") {
    return { ...existing, status: failed ? ("error" as const) : ("success" as const), endedAt: now() };
  }
  return buildCodexToolCallRow({
    item,
    turnId,
    status: failed ? "error" : "success",
    allocateRowId,
    now,
  });
}
