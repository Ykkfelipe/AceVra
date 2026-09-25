// Codex thread → v4 conversation 投影（domain，纯函数类，无 IO / 无时钟）。
// 行存储/行构造见 codexRowLog.ts，快照见 codexSnapshot.ts，交付追踪见 codexDelivery.ts。
import type {
  CodexExecutionApprovalDecision,
  CodexExecutionApprovalRequestInfo,
  TaskArtifactDescriptor,
} from "@zcode/shared";
import type {
  ConversationDelta,
  ConversationRow,
  TurnHeaderRow,
} from "@zcode/shared/zcode-protocol-v4";
import { type CodexServerNotification, scrubCodexErrorDetail } from "./codexWire.js";
import {
  buildCodexControl,
  buildCodexSnapshot,
  type CodexPhase,
  type CodexProjectionState,
} from "./codexSnapshot.js";
import { buildTurnHeaderRow, buildUserInputRow, CodexRowLog } from "./codexRowLog.js";
import { buildCodexArtifactRow, CodexTurnDeliveryTracker } from "./codexDelivery.js";
import {
  reduceItemCompleted,
  reduceItemDelta,
  reduceItemStarted,
  replayCompletedItem,
  type ItemProjectionHost,
} from "./codexItemProjection.js";
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

export class CodexThreadProjection {
  readonly #log = new CodexRowLog();
  readonly #streamingRowByItemId = new Map<string, number>();
  readonly #approvals = new CodexApprovalTable();
  #seq = 0;
  #revision = 0;
  #currentTurnId: string | null = null;
  #currentTurnRowId: number | null = null;
  #currentUserInputRowId: number | null = null;
  #phase: CodexPhase = "completedSuccess";
  #lastError: CodexProjectionState["lastError"] = null;
  #title = "";
  readonly #deliveryTracker = new CodexTurnDeliveryTracker();

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

  /** 当前行日志（rowId 升序，只读视图）。 */
  get rows(): readonly ConversationRow[] {
    return this.#log.rows;
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
  beginUserTurn(params: {
    text: string;
    turnId: string;
    commandId: string;
  }): CodexProjectionCommit {
    const createdAt = this.now();
    const turnId = params.turnId;
    this.#currentTurnId = turnId;
    this.#deliveryTracker.beginTurn(turnId, params.text);
    const turnHeader = buildTurnHeaderRow({
      turnId,
      commandId: params.commandId,
      rowId: this.#log.allocateRowId(),
      createdAt,
    }) as TurnHeaderRow;
    const userInput = buildUserInputRow({
      turnId,
      text: params.text,
      commandId: params.commandId,
      rowId: this.#log.allocateRowId(),
      createdAt,
    });
    this.#currentTurnRowId = turnHeader.rowId;
    this.#currentUserInputRowId = userInput.rowId;
    this.#phase = "running";
    this.#lastError = null;
    return this.#commit([
      this.#log.append(turnHeader),
      this.#log.append(userInput),
      { op: "state.updated", patch: { control: buildCodexControl(this.#state()) } },
    ]);
  }

  /** 绑定本轮 Codex 原生 turn id 并回填已建的 turnHeader/userInput（sourceTurnId，Amendment 4）。 */
  bindSourceTurnId(sourceTurnId: string): CodexProjectionCommit | null {
    if (this.#log.sourceTurnId === sourceTurnId) return null;
    const deltas = this.#log.bindSourceTurnId(sourceTurnId, [
      this.#currentTurnRowId,
      this.#currentUserInputRowId,
    ]);
    return deltas.length > 0 ? this.#commit(deltas) : null;
  }

  /** 应用一条 Codex 通知；不适用返回 null（调用方丢弃，不产生空帧）。 */
  applyNotification(notification: CodexServerNotification): CodexProjectionCommit | null {
    switch (notification.type) {
      case "itemStarted":
        return this.#itemStarted(notification);
      case "itemDelta":
        return this.#itemDelta(notification);
      case "itemCompleted":
        if (notification.item.kind === "fileChange") {
          this.#deliveryTracker.recordFileChangePaths(
            notification.item.changes.map((change) => change.path),
          );
        }
        return this.#itemCompleted(notification.item);
      case "turnCompleted":
        return this.#turnCompleted(notification);
      case "turnStarted":
        return notification.turnId ? this.bindSourceTurnId(notification.turnId) : null;
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
        return this.#commit([
          { op: "state.updated", patch: { control: buildCodexControl(this.#state()) } },
        ]);
      }
      case "unknown":
        return null;
    }
  }

  #itemStarted(
    notification: Extract<CodexServerNotification, { type: "itemStarted" }>,
  ): CodexProjectionCommit | null {
    return reduceItemStarted(this.#itemHost(), notification);
  }

  #itemDelta(
    notification: Extract<CodexServerNotification, { type: "itemDelta" }>,
  ): CodexProjectionCommit | null {
    return reduceItemDelta(this.#itemHost(), notification);
  }

  #itemCompleted(
    item: Extract<CodexServerNotification, { type: "itemCompleted" }>["item"],
  ): CodexProjectionCommit | null {
    return reduceItemCompleted(this.#itemHost(), item);
  }

  /** item 归约宿主面：把私有行日志/流式索引/当前轮/时钟/commit 暴露给纯归约模块。 */
  #itemHost(): ItemProjectionHost {
    return {
      log: this.#log,
      streamingRowByItemId: this.#streamingRowByItemId,
      currentTurnId: this.#currentTurnId,
      now: this.now,
      commit: (deltas) => this.#commit(deltas),
    };
  }

  #turnCompleted(
    notification: Extract<CodexServerNotification, { type: "turnCompleted" }>,
  ): CodexProjectionCommit {
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
    this.#currentUserInputRowId = null;
    this.#log.setSourceTurnId(null);
    this.#phase =
      state === "failed"
        ? "error"
        : state === "completedInterrupted"
          ? "completedInterrupted"
          : "completedSuccess";
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

  /** turn/start 失败的本地收口：置 turnHeader failed，避免 UI 停在幽灵 running 轮。 */
  failActiveTurn(code: string, message: string): CodexProjectionCommit {
    return this.#closeActiveTurn("failed", { code, message });
  }

  /** 登记审批：pendingInteraction 下发 + 锚点工具行置 pendingApproval。 */
  registerApproval(
    info: Omit<CodexExecutionApprovalRequestInfo, "interactionId">,
    rawId: number,
    requestedPermissions?: unknown,
  ): { commit: CodexProjectionCommit; record: CodexApprovalRecord } {
    const anchorRowId =
      info.kind === "commandExecution" || info.kind === "fileChange"
        ? this.#log.lastToolRowId()
        : null;
    const record = this.#approvals.register({
      info,
      rawId,
      anchorRowId,
      createdAt: this.now(),
      requestedPermissions,
    });
    const deltas: ConversationDelta[] = [
      {
        op: "state.updated",
        patch: { pendingInteractions: this.#approvals.toPendingInteractions(this.now()) },
      },
    ];
    if (anchorRowId !== null) {
      const anchor = this.#log.rowAt(anchorRowId);
      if (anchor?.kind === "toolCall") {
        deltas.push(
          this.#log.upsert({
            ...anchor,
            status: "pendingApproval",
            approvalInteractionId: record.interactionId,
          }),
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
      {
        op: "state.updated",
        patch: { pendingInteractions: this.#approvals.toPendingInteractions(this.now()) },
      },
    ];
    if (resolution.record.anchorRowId !== null) {
      const anchor = this.#log.rowAt(resolution.record.anchorRowId);
      if (anchor?.kind === "toolCall" && anchor.status === "pendingApproval") {
        deltas.push(this.#log.upsert({ ...anchor, status: "running" }));
      }
    }
    return { ...resolution, commit: this.#commit(deltas) };
  }

  /** 冷恢复回放：历史条目直接落终态行（归约见 codexItemProjection）。 */
  replayCompletedItem(item: CodexItem, sourceTurnId?: string | null): CodexProjectionCommit | null {
    return replayCompletedItem(this.#itemHost(), item, sourceTurnId);
  }

  /** turn 完成后取走交付候选（输入文本 + fileChange 路径）；每轮一次性。 */
  takeCompletedTurnDelivery(): {
    turnId: string;
    userInputText: string;
    filePaths: string[];
  } | null {
    return this.#deliveryTracker.takeCompleted();
  }

  /** 已注册 artifact → 标准 artifact 行（turnId 未知时用冷恢复组）。 */
  appendArtifactRow(
    descriptor: TaskArtifactDescriptor,
    turnId: string | null,
  ): CodexProjectionCommit {
    const row = buildCodexArtifactRow({
      descriptor,
      turnId: turnId || "codex-history",
      rowId: this.#log.allocateRowId(),
      createdAt: this.now(),
    });
    return this.#commit([this.#log.append(row)]);
  }

  buildSnapshot(
    sessionId: string,
    options?: { modelId?: string | null; effort?: string | null },
  ): ReturnType<typeof buildCodexSnapshot> {
    return buildCodexSnapshot(this.#state(), sessionId, this.#title, options);
  }

  rowsRange(params: { beforeRowId?: number; limit: number }): ConversationRow[] {
    return this.#log.range(params);
  }
}
