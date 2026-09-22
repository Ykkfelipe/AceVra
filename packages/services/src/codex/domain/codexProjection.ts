// Codex thread → v4 conversation 投影（domain，纯函数类，无 IO / 无时钟）。
// Codex 通知与宿主侧 turn 边界归约成 v4 rows/deltas；行存储见 codexRowLog.ts，
// 快照形状由 codexSnapshot.ts 构造，审批登记/解析委托 codexApprovals.ts。
import type { CodexExecutionApprovalDecision, CodexExecutionApprovalRequestInfo } from "@zcode/shared";
import type {
  ConversationDelta,
  ConversationRow,
  TurnHeaderRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { CodexServerNotification } from "./codexWire.js";
import { scrubCodexErrorDetail } from "./codexWire.js";
import {
  buildCodexControl,
  buildCodexSnapshot,
  type CodexPhase,
  type CodexProjectionState,
} from "./codexSnapshot.js";
import { CodexRowLog, codexToolInputText, rowBase } from "./codexRowLog.js";
import {
  CodexApprovalTable,
  type CodexApprovalRecord,
  type CodexApprovalResolution,
} from "./codexApprovals.js";

export interface CodexProjectionCommit {
  readonly seq: number;
  readonly revision: number;
  readonly deltas: ConversationDelta[];
}

/** 解析结果 + 本次解析产生的投影增量（调用方必须把它发给订阅者）。 */
export interface CodexApprovalResolutionWithCommit extends CodexApprovalResolution {
  readonly commit: CodexProjectionCommit;
}

type CodexItem = Extract<CodexServerNotification, { type: "itemStarted" }>["item"];

function isToolItemKind(kind: CodexItem["kind"]): boolean {
  return kind === "commandExecution" || kind === "fileChange" || kind === "mcpToolCall" || kind === "webSearch";
}

export class CodexThreadProjection {
  readonly #log = new CodexRowLog();
  readonly #streamingRowByItemId = new Map<string, number>();
  readonly #approvals = new CodexApprovalTable();
  #seq = 0;
  #revision = 0;
  #currentTurnId: string | null = null;
  #currentTurnRowId: number | null = null;
  #phase: CodexPhase = "completedSuccess";
  #lastError: CodexProjectionState["lastError"] = null;
  #title = "";

  constructor(
    /** 渲染端 logEpoch；与桥代数绑定（codex-<generation>）。 */
    public logEpoch: string,
    private readonly now: () => number = () => 0,
  ) {}

  get seq(): number {
    return this.#seq;
  }

  get revision(): number {
    return this.#revision;
  }

  get rowCount(): number {
    return this.#log.rows.length;
  }

  get title(): string {
    return this.#title;
  }

  get phase(): CodexPhase {
    return this.#phase;
  }

  get lastError(): CodexProjectionState["lastError"] {
    return this.#lastError;
  }

  get pendingApprovals(): readonly CodexApprovalRecord[] {
    return this.#approvals.pending();
  }

  setTitle(title: string): void {
    this.#title = title;
  }

  #commit(deltas: ConversationDelta[]): CodexProjectionCommit {
    this.#seq += 1;
    this.#revision += 1;
    return { seq: this.#seq, revision: this.#revision, deltas };
  }

  #state(): CodexProjectionState {
    return {
      logEpoch: this.logEpoch,
      seq: this.#seq,
      revision: this.#revision,
      phase: this.#phase,
      lastError: this.#lastError,
      rows: this.#log.rows,
      pendingInteractions: this.#approvals.toPendingInteractions(this.now()),
    };
  }

  /** 宿主发起用户轮：turnHeader + userInput 行 + control=running。 */
  beginUserTurn(params: { text: string; turnId: string; commandId: string }): CodexProjectionCommit {
    const createdAt = this.now();
    const turnId = params.turnId;
    this.#currentTurnId = turnId;
    const turnHeader: TurnHeaderRow = {
      ...rowBase(this.#log.allocateRowId(), turnId, `codex-turn-${turnId}`, createdAt),
      kind: "turnHeader",
      origin: "userInput",
      executionKind: "agent",
      sourceCommandId: params.commandId,
      state: "running",
      startedAt: createdAt,
    };
    const userInput: ConversationRow = {
      ...rowBase(this.#log.allocateRowId(), turnId, `codex-input-${turnId}`, createdAt),
      kind: "userInput",
      text: params.text,
      origin: "realUser",
      sourceCommandId: params.commandId,
    };
    this.#currentTurnRowId = turnHeader.rowId;
    this.#phase = "running";
    this.#lastError = null;
    return this.#commit([
      this.#log.append(turnHeader),
      this.#log.append(userInput),
      { op: "state.updated", patch: { control: buildCodexControl(this.#state()) } },
    ]);
  }

  #appendStreamingRow(item: { itemId: string | null; text: string }, kind: "assistantText" | "reasoning"): CodexProjectionCommit {
    const turnId = this.#currentTurnId ?? "codex-turn-unknown";
    const entityId = item.itemId ? `codex-item-${item.itemId}` : `codex-row-${this.#log.allocateRowId()}`;
    const row: ConversationRow = {
      ...rowBase(this.#log.allocateRowId(), turnId, entityId, this.now()),
      kind,
      text: item.text,
      state: "streaming",
    };
    if (item.itemId) this.#streamingRowByItemId.set(item.itemId, row.rowId);
    return this.#commit([this.#log.append(row)]);
  }

  /** 应用一条 Codex 通知；不适用返回 null（调用方丢弃，不产生空帧）。 */
  applyNotification(notification: CodexServerNotification): CodexProjectionCommit | null {
    switch (notification.type) {
      case "itemStarted":
        return this.#itemStarted(notification);
      case "itemDelta":
        return this.#itemDelta(notification);
      case "itemCompleted":
        return this.#itemCompleted(notification.item);
      case "turnCompleted":
        return this.#turnCompleted(notification);
      case "turnStarted":
      case "threadStarted":
        return null;
      case "error": {
        this.#lastError = {
          code: "codex.error",
          message: scrubCodexErrorDetail(notification.message),
          recoverable: true,
          at: this.now(),
          source: "provider",
        };
        if (this.#phase === "running") this.#phase = "error";
        return this.#commit([{ op: "state.updated", patch: { control: buildCodexControl(this.#state()) } }]);
      }
      case "unknown":
        return null;
    }
  }

  #itemStarted(notification: Extract<CodexServerNotification, { type: "itemStarted" }>): CodexProjectionCommit | null {
    const item = notification.item;
    if (item.kind === "agentMessage" || item.kind === "reasoning") {
      return this.#appendStreamingRow(item, item.kind === "agentMessage" ? "assistantText" : "reasoning");
    }
    if (!isToolItemKind(item.kind)) return null;
    const turnId = this.#currentTurnId ?? "codex-turn-unknown";
    const row = this.#toolCallRow(item, turnId, "running");
    if (item.itemId) this.#streamingRowByItemId.set(item.itemId, row.rowId);
    return this.#commit([this.#log.append(row)]);
  }

  #toolCallRow(item: CodexItem, turnId: string, status: "running" | "success" | "error"): ConversationRow {
    const createdAt = this.now();
    const entityId = item.itemId ? `codex-item-${item.itemId}` : `codex-row-${this.#log.allocateRowId()}`;
    return {
      ...rowBase(this.#log.allocateRowId(), turnId, entityId, createdAt),
      kind: "toolCall",
      toolCallId: item.itemId ?? `codex-tool-${this.#log.allocateRowId()}`,
      toolName: `codex.${item.kind}`,
      status,
      inputText: codexToolInputText(item),
      startedAt: createdAt,
      ...(status === "running" ? {} : { endedAt: createdAt }),
    };
  }

  #itemDelta(notification: Extract<CodexServerNotification, { type: "itemDelta" }>): CodexProjectionCommit | null {
    const rowId = notification.itemId ? this.#streamingRowByItemId.get(notification.itemId) : undefined;
    if (rowId === undefined) return null;
    const target = this.#log.rowAt(rowId);
    if (!target) return null;
    if (notification.deltaKind === "commandOutput" || notification.deltaKind === "fileChangeOutput") {
      if (target.kind !== "toolCall") return null;
      return this.#commit([
        this.#log.upsert({
          ...target,
          output: { text: (target.output?.text ?? "") + notification.append },
        }),
      ]);
    }
    if (target.kind !== "assistantText" && target.kind !== "reasoning") return null;
    return this.#commit([{ op: "row.delta", rowId, path: "text", append: notification.append }]);
  }

  #itemCompleted(item: Extract<CodexServerNotification, { type: "itemCompleted" }>["item"]): CodexProjectionCommit | null {
    const entityId = item.itemId ? `codex-item-${item.itemId}` : null;
    const rowId = entityId ? this.#log.rowIdOfEntity(entityId) : undefined;
    if (rowId === undefined) return null;
    const existing = this.#log.rowAt(rowId);
    if (!existing) return null;
    if (existing.kind === "assistantText") {
      const text = item.kind === "agentMessage" ? item.text : existing.text;
      return this.#commit([this.#log.upsert({ ...existing, text, state: "complete" })]);
    }
    if (existing.kind === "reasoning") {
      return this.#commit([this.#log.upsert({ ...existing, state: "complete" })]);
    }
    if (existing.kind === "toolCall") {
      const status = item.status ?? null;
      const failed = status !== null && /fail|error/i.test(status);
      return this.#commit([
        this.#log.upsert({
          ...existing,
          status: failed ? "error" : "success",
          ...(item.kind === "commandExecution" && item.aggregatedOutput !== null
            ? { output: { text: item.aggregatedOutput } }
            : {}),
          endedAt: this.now(),
        }),
      ]);
    }
    return null;
  }

  #turnCompleted(notification: Extract<CodexServerNotification, { type: "turnCompleted" }>): CodexProjectionCommit {
    const state =
      notification.outcome === "success"
        ? "completedSuccess"
        : notification.outcome === "interrupted"
          ? "completedInterrupted"
          : "failed";
    const error =
      notification.outcome === "failed"
        ? {
            code: "codex.turnFailed",
            message: scrubCodexErrorDetail(notification.errorMessage ?? "Codex turn failed"),
          }
        : undefined;
    return this.#closeActiveTurn(state, error);
  }

  /** turn 收口共用路径：turnHeader 终态 + phase/lastError + control patch。 */
  #closeActiveTurn(
    state: "completedSuccess" | "completedInterrupted" | "failed",
    error?: { code: string; message: string },
  ): CodexProjectionCommit {
    const deltas: ConversationDelta[] = [];
    if (this.#currentTurnRowId !== null) {
      const turnHeader = this.#log.rowAt(this.#currentTurnRowId);
      if (turnHeader?.kind === "turnHeader") {
        deltas.push(
          this.#log.upsert({
            ...turnHeader,
            state: state === "failed" ? ("failed" as const) : state,
            endedAt: this.now(),
          }),
        );
      }
    }
    this.#currentTurnRowId = null;
    this.#currentTurnId = null;
    this.#phase =
      state === "failed" ? "error" : state === "completedInterrupted" ? "completedInterrupted" : "completedSuccess";
    if (error) {
      this.#lastError = {
        ...error,
        // lastError 会经快照进通道：与其它错误路径一致，先脱敏再落投影。
        message: scrubCodexErrorDetail(error.message),
        recoverable: true,
        at: this.now(),
        source: "provider",
      };
    }
    deltas.push({ op: "state.updated", patch: { control: buildCodexControl(this.#state()) } });
    return this.#commit(deltas);
  }

  /**
   * turn/start 失败的本地收口：Codex 不会为这次 turn 发 turn/completed，
   * 投影必须自己把 turnHeader 置 failed，否则 UI 停在幽灵 running 轮上。
   */
  failActiveTurn(code: string, message: string): CodexProjectionCommit {
    return this.#closeActiveTurn("failed", { code, message });
  }

  /** 登记审批：生成 interactionId、下发 pendingInteraction，锚点工具行置为 pendingApproval。 */
  registerApproval(
    info: Omit<CodexExecutionApprovalRequestInfo, "interactionId">,
    rawId: number,
  ): { commit: CodexProjectionCommit; record: CodexApprovalRecord } {
    const anchorRowId =
      info.kind === "commandExecution" || info.kind === "fileChange" ? this.#log.lastToolRowId() : null;
    const record = this.#approvals.register({ info, rawId, anchorRowId, createdAt: this.now() });
    const deltas: ConversationDelta[] = [
      { op: "state.updated", patch: { pendingInteractions: this.#approvals.toPendingInteractions(this.now()) } },
    ];
    if (anchorRowId !== null) {
      const anchor = this.#log.rowAt(anchorRowId);
      if (anchor?.kind === "toolCall") {
        deltas.push(
          this.#log.upsert({ ...anchor, status: "pendingApproval", approvalInteractionId: record.interactionId }),
        );
      }
    }
    deltas.push({ op: "state.updated", patch: { control: buildCodexControl(this.#state()) } });
    return { commit: this.#commit(deltas), record };
  }

  /** 解析审批；未知 interactionId 返回 null（调用方回 rejected ACK，绝不静默放行）。 */
  resolveApproval(
    interactionId: string,
    decision: CodexExecutionApprovalDecision["decision"],
  ): CodexApprovalResolutionWithCommit | null {
    const resolution = this.#approvals.resolve(interactionId, decision);
    if (!resolution) return null;
    const deltas: ConversationDelta[] = [
      { op: "state.updated", patch: { pendingInteractions: this.#approvals.toPendingInteractions(this.now()) } },
    ];
    if (resolution.record.anchorRowId !== null) {
      const anchor = this.#log.rowAt(resolution.record.anchorRowId);
      if (anchor?.kind === "toolCall" && anchor.status === "pendingApproval") {
        deltas.push(this.#log.upsert({ ...anchor, status: "running" }));
      }
    }
    return { ...resolution, commit: this.#commit(deltas) };
  }

  /**
   * 冷恢复回放：把 thread/items/list 的历史条目直接落成终态行。
   * 与 applyNotification(itemCompleted) 不同：不要求先出现过 itemStarted（恢复时投影为空）。
   */
  replayCompletedItem(item: CodexItem): CodexProjectionCommit | null {
    const entityId = item.itemId ? `codex-item-${item.itemId}` : null;
    const turnId = "codex-history";
    const existingRowId = entityId ? this.#log.rowIdOfEntity(entityId) : undefined;
    const existing = existingRowId !== undefined ? this.#log.rowAt(existingRowId) : undefined;
    if (item.kind === "agentMessage" || item.kind === "reasoning") {
      const kind = item.kind === "agentMessage" ? "assistantText" : "reasoning";
      const row: ConversationRow = existing?.kind === kind
        ? { ...existing, text: item.text, state: "complete" }
        : {
            ...rowBase(this.#log.allocateRowId(), turnId, entityId ?? `codex-row-${this.#log.allocateRowId()}`, this.now()),
            kind,
            text: item.text,
            state: "complete",
          };
      return this.#commit([existing ? this.#log.upsert(row) : this.#log.append(row)]);
    }
    if (!isToolItemKind(item.kind)) return null;
    const failed = item.status != null && /fail|error/i.test(item.status);
    const row =
      existing?.kind === "toolCall"
        ? { ...existing, status: failed ? ("error" as const) : ("success" as const), endedAt: this.now() }
        : this.#toolCallRow(item, turnId, failed ? "error" : "success");
    return this.#commit([existing ? this.#log.upsert(row) : this.#log.append(row)]);
  }

  buildSnapshot(sessionId: string): ReturnType<typeof buildCodexSnapshot> {
    return buildCodexSnapshot(this.#state(), sessionId, this.#title);
  }

  rowsRange(params: { beforeRowId?: number; limit: number }): ConversationRow[] {
    return this.#log.range(params);
  }
}
