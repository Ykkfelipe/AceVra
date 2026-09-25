// 跨后端可见时间线的纯组合逻辑（backend-migration.md Amendment 4）。
//
// AceVra task 拥有可见时间线：它 = 按顺序的执行段（每段从产生它的后端只读读取）+ 由持久化
// backendTransitions 合成的迁移 marker。这里只有纯函数与注入式读取器，没有 IO；UI 传输层、
// 迁移 transcript 构建与公开分享共用同一份规则，避免三处各自判断「哪些行可见」。
//
// 行 id 规则：live 段保持原生 rowId 不变（命令/增量/游标无需翻译）；历史段与 marker 映射到负数：
//   历史行      (k − L)·STRIDE + 1 + sourceRowId
//   marker(k)  (k − L)·STRIDE − 1          （打开第 k 段的迁移，k ≥ 1）
// 其中 L = live 段下标。source rowId 必须落在 [0, STRIDE − 2)，越界行丢弃而不是回绕。
import type { BackendTransitionRecord } from "./backend-migration.js";
import type { ZCodeExecutionBackend } from "./codex-execution.js";
import type { ConversationRow } from "./zcode-protocol-v4/rows.js";

export const BACKEND_TIMELINE_SEGMENT_STRIDE = 2 ** 40;
const STRIDE = BACKEND_TIMELINE_SEGMENT_STRIDE;

export type BackendTimelineSegmentSource =
  | {
      readonly kind: "zcode";
      readonly sessionId: string;
      /** 不含：rowId 必须 > afterRowId（新 Agent 段排除更早段与种子行）。 */
      readonly afterRowId?: number;
      /** 含：rowId 必须 ≤ throughRowId（段已被迁移关闭）。 */
      readonly throughRowId?: number;
    }
  | {
      readonly kind: "codex";
      readonly threadId: string;
      /** 属于这些 Codex 原生 turn 的行（handoff 轮）不进入可见时间线。 */
      readonly hiddenSourceTurnIds: readonly string[];
    };

export interface BackendTimelineSegment {
  readonly index: number;
  readonly backend: ZCodeExecutionBackend;
  readonly providerId?: string;
  readonly source: BackendTimelineSegmentSource;
  /** 打开本段的迁移在 backendTransitions 中的下标；第 0 段没有。 */
  readonly openedByTransitionIndex?: number;
  readonly live: boolean;
}

/** marker 合成只需要的迁移事实；Host 侧是完整记录，UI 侧是公开安全的视图。 */
export type BackendTimelineTransitionFacts = Pick<
  BackendTransitionRecord,
  | "from"
  | "to"
  | "fromProviderId"
  | "toProviderId"
  | "transcriptCompacted"
  | "startedAt"
  | "committedAt"
  | "status"
>;

export interface BackendTimelineLayout {
  readonly taskId: string;
  /** 已提交迁移数；布局随每次提交变化，用于组合 logEpoch 与路由缓存失效。 */
  readonly layoutVersion: number;
  readonly segments: readonly BackendTimelineSegment[];
  readonly liveIndex: number;
  /** 完整的 backendTransitions（含 failed），marker 按下标引用。 */
  readonly transitions: readonly BackendTimelineTransitionFacts[];
}

export interface BackendTimelineTaskFacts {
  readonly taskId: string;
  readonly executionBackend?: ZCodeExecutionBackend;
  readonly codexThreadId?: string;
  readonly backendTransitions?: readonly BackendTransitionRecord[];
}

function sourceForSegment(params: {
  taskId: string;
  backend: ZCodeExecutionBackend;
  opening: BackendTransitionRecord | undefined;
  closing: BackendTransitionRecord | undefined;
  fallbackCodexThreadId: string | undefined;
}): BackendTimelineSegmentSource {
  const { opening, closing } = params;
  if (params.backend === "zcode") {
    const afterRowId = opening?.destinationSeedLastRowId ?? undefined;
    const throughRowId = closing?.sourceLastRowId ?? undefined;
    return {
      kind: "zcode",
      sessionId: params.taskId,
      ...(afterRowId === undefined ? {} : { afterRowId }),
      ...(throughRowId === undefined ? {} : { throughRowId }),
    };
  }
  const threadId =
    opening?.destinationExecutionRef ??
    closing?.sourceExecutionRef ??
    params.fallbackCodexThreadId ??
    "";
  return {
    kind: "codex",
    threadId,
    hiddenSourceTurnIds: opening?.handoffTurnId ? [opening.handoffTurnId] : [],
  };
}

/**
 * 从持久化事实推导段布局。只有 committed 记录打开/关闭段；failed 记录不产生段，
 * 失败目标端（例如被放弃的 Codex thread）永远不会成为读源。
 */
export function deriveBackendTimelineLayout(
  facts: BackendTimelineTaskFacts,
): BackendTimelineLayout {
  const transitions = facts.backendTransitions ?? [];
  const committed = transitions
    .map((record, index) => ({ record, index }))
    .filter((entry) => entry.record.status === "committed");
  const segments: BackendTimelineSegment[] = [];
  const firstBackend = committed[0]?.record.from ?? facts.executionBackend ?? "zcode";
  const firstProvider = committed[0]?.record.fromProviderId;
  segments.push({
    index: 0,
    backend: firstBackend,
    ...(firstProvider === undefined ? {} : { providerId: firstProvider }),
    source: sourceForSegment({
      taskId: facts.taskId,
      backend: firstBackend,
      opening: undefined,
      closing: committed[0]?.record,
      fallbackCodexThreadId: committed.length === 0 ? facts.codexThreadId : undefined,
    }),
    live: committed.length === 0,
  });
  committed.forEach((entry, position) => {
    const closing = committed[position + 1]?.record;
    const isLast = position === committed.length - 1;
    segments.push({
      index: position + 1,
      backend: entry.record.to,
      ...(entry.record.toProviderId === undefined ? {} : { providerId: entry.record.toProviderId }),
      source: sourceForSegment({
        taskId: facts.taskId,
        backend: entry.record.to,
        opening: entry.record,
        closing,
        fallbackCodexThreadId: isLast ? facts.codexThreadId : undefined,
      }),
      openedByTransitionIndex: entry.index,
      live: isLast,
    });
  });
  return {
    taskId: facts.taskId,
    layoutVersion: committed.length,
    segments,
    liveIndex: segments.length - 1,
    transitions,
  };
}

export function isRowInTimelineSegment(
  segment: BackendTimelineSegment,
  row: Pick<ConversationRow, "rowId" | "sourceTurnId">,
): boolean {
  const source = segment.source;
  if (source.kind === "zcode") {
    if (source.afterRowId !== undefined && row.rowId <= source.afterRowId) return false;
    if (source.throughRowId !== undefined && row.rowId > source.throughRowId) return false;
    return true;
  }
  return !(row.sourceTurnId !== undefined && source.hiddenSourceTurnIds.includes(row.sourceTurnId));
}

function isComposableSourceRowId(rowId: number): boolean {
  return Number.isFinite(rowId) && rowId >= 0 && rowId < STRIDE - 2;
}

export function composedTimelineRowId(
  layout: BackendTimelineLayout,
  segmentIndex: number,
  sourceRowId: number,
): number {
  if (segmentIndex === layout.liveIndex) return sourceRowId;
  return (segmentIndex - layout.liveIndex) * STRIDE + 1 + sourceRowId;
}

export function composedTimelineMarkerRowId(
  layout: BackendTimelineLayout,
  segmentIndex: number,
): number {
  return (segmentIndex - layout.liveIndex) * STRIDE - 1;
}

export type DecodedTimelineRowId =
  | { readonly kind: "row"; readonly segmentIndex: number; readonly sourceRowId: number }
  | { readonly kind: "marker"; readonly segmentIndex: number }
  | { readonly kind: "invalid" };

export function decodeComposedTimelineRowId(
  layout: BackendTimelineLayout,
  composedRowId: number,
): DecodedTimelineRowId {
  if (composedRowId >= 0) {
    return { kind: "row", segmentIndex: layout.liveIndex, sourceRowId: composedRowId };
  }
  const quotient = Math.floor(composedRowId / STRIDE);
  const remainder = composedRowId - quotient * STRIDE;
  const segmentIndex = layout.liveIndex + quotient;
  if (remainder === STRIDE - 1) {
    const opened = segmentIndex + 1;
    return opened >= 1 && opened <= layout.liveIndex
      ? { kind: "marker", segmentIndex: opened }
      : { kind: "invalid" };
  }
  if (remainder === 0 || segmentIndex < 0 || segmentIndex >= layout.liveIndex) {
    return { kind: "invalid" };
  }
  return { kind: "row", segmentIndex, sourceRowId: remainder - 1 };
}

/**
 * 某一段的源行 → 组合行：过滤不属于本段的行（范围外、种子、handoff 轮），映射 rowId。
 * 历史段只读：去掉 actions（不能 edit/rewind/fork 进已关闭的段），turnId 加段前缀，
 * 避免两段 Codex 冷恢复行共用 "codex-history" 被分组逻辑拼到一起。
 */
export function composeTimelineSegmentRows(
  layout: BackendTimelineLayout,
  segmentIndex: number,
  sourceRows: readonly ConversationRow[],
): ConversationRow[] {
  const segment = layout.segments[segmentIndex];
  if (!segment) return [];
  const live = segmentIndex === layout.liveIndex;
  const composed: ConversationRow[] = [];
  for (const row of sourceRows) {
    if (!isRowInTimelineSegment(segment, row)) continue;
    if (live) {
      composed.push(row);
      continue;
    }
    if (!isComposableSourceRowId(row.rowId)) continue;
    const { actions: _actions, ...rest } = row;
    composed.push({
      ...rest,
      rowId: composedTimelineRowId(layout, segmentIndex, row.rowId),
      turnId: `bt-seg${segmentIndex}:${row.turnId}`,
    } as ConversationRow);
  }
  return composed;
}

/** 打开第 k 段的迁移 marker；只携带公开安全的字段（无 thread id / turn id）。 */
export function buildBackendTransitionMarkerRow(
  layout: BackendTimelineLayout,
  segmentIndex: number,
): ConversationRow | null {
  const segment = layout.segments[segmentIndex];
  const transitionIndex = segment?.openedByTransitionIndex;
  if (transitionIndex === undefined) return null;
  const record = layout.transitions[transitionIndex];
  if (!record) return null;
  const rowId = composedTimelineMarkerRowId(layout, segmentIndex);
  const at = record.committedAt ?? record.startedAt;
  return {
    rowId,
    turnId: `bt-marker:${transitionIndex}`,
    entityId: `backend-transition:${transitionIndex}`,
    kind: "timelineMarker",
    createdAt: at,
    createdAtSeq: rowId,
    marker: {
      type: "backendTransition",
      status: "success",
      fromBackend: record.from,
      toBackend: record.to,
      ...(record.fromProviderId === undefined ? {} : { fromProviderId: record.fromProviderId }),
      ...(record.toProviderId === undefined ? {} : { toProviderId: record.toProviderId }),
      transcriptCompacted: record.transcriptCompacted,
      transitionIndex,
    },
  } as ConversationRow;
}

/** 组合 logEpoch：未迁移过的 task 保持原样（零回归）；迁移后附布局版本。 */
export function composeTimelineLogEpoch(
  layout: BackendTimelineLayout,
  liveLogEpoch: string,
): string {
  return layout.layoutVersion === 0 ? liveLogEpoch : `${liveLogEpoch}::bt${layout.layoutVersion}`;
}

/** 把组合 epoch 还原成 live 后端的 epoch；布局版本不符时返回 null（缓存窗口已失效）。 */
export function decomposeTimelineLogEpoch(
  layout: BackendTimelineLayout,
  composedLogEpoch: string,
): string | null {
  if (layout.layoutVersion === 0) {
    return composedLogEpoch.includes("::bt") ? null : composedLogEpoch;
  }
  const suffix = `::bt${layout.layoutVersion}`;
  return composedLogEpoch.endsWith(suffix) ? composedLogEpoch.slice(0, -suffix.length) : null;
}
