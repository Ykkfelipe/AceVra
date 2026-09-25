// 时间线组合器的视图/选择辅助（backend-migration.md Amendment 4）：Host ↔ UI 的公开安全视图转换，
// 以及迁移时「目标端还没见过哪些段」「live 段的行边界」两个选择器。纯函数，无 IO。
import {
  toBackendTransitionView,
  type BackendTimelineSegmentView,
  type PendingBackendTransition,
  type TaskTimelineView,
} from "./backend-migration.js";
import {
  composedTimelineMarkerRowId,
  composedTimelineRowId,
  decodeComposedTimelineRowId,
  deriveBackendTimelineLayout,
  type BackendTimelineLayout,
  type BackendTimelineSegment,
  type BackendTimelineTaskFacts,
} from "./backend-timeline.js";
import type { ZCodeExecutionBackend } from "./codex-execution.js";
import type { ConversationRow } from "./zcode-protocol-v4/rows.js";

/**
 * 只保留「目标后端还没见过」的组合行：目标最后一次拥有的段之后的所有段（含 marker）。
 * Codex → Agent 时 Agent 会话已经持有自己早先段的完整上下文，种子只需补上之后的 Codex 段，
 * 避免同一段历史在模型上下文里重复、随迁移次数平方增长（Amendment 4）。
 */
export function selectComposedRowsAfterLastSegmentOf(
  layout: BackendTimelineLayout,
  rows: readonly ConversationRow[],
  backend: ZCodeExecutionBackend,
): ConversationRow[] {
  let lastIndex = -1;
  for (const segment of layout.segments) {
    if (segment.backend === backend) lastIndex = segment.index;
  }
  if (lastIndex < 0) return [...rows];
  return rows.filter((row) => {
    const decoded = decodeComposedTimelineRowId(layout, row.rowId);
    if (decoded.kind === "invalid") return false;
    return decoded.segmentIndex > lastIndex;
  });
}

/** live 段在源后端里的 [first, last] 行边界（离开 zcode 时写进迁移记录）。 */
export function liveSegmentRowBounds(
  layout: BackendTimelineLayout,
  rows: readonly ConversationRow[],
): { firstRowId: number | null; lastRowId: number | null } {
  const live = rows.filter((row) => row.rowId >= 0);
  const segment = layout.segments[layout.liveIndex];
  const lowerBound =
    segment?.source.kind === "zcode" && segment.source.afterRowId !== undefined
      ? segment.source.afterRowId
      : -1;
  // 空段也必须给出上界：否则关闭后的段没有 throughRowId，会把之后写进同一会话的行吞进来。
  return {
    firstRowId: live[0]?.rowId ?? null,
    lastRowId: live.at(-1)?.rowId ?? lowerBound,
  };
}

function segmentVisibility(
  segment: BackendTimelineSegment,
): BackendTimelineSegmentView["visibility"] {
  const source = segment.source;
  if (source.kind === "zcode") {
    return {
      kind: "zcode",
      ...(source.afterRowId === undefined ? {} : { afterRowId: source.afterRowId }),
      ...(source.throughRowId === undefined ? {} : { throughRowId: source.throughRowId }),
    };
  }
  return { kind: "codex", hiddenSourceTurnIds: source.hiddenSourceTurnIds };
}

/** Host → UI：公开安全的时间线视图（不含 thread id）。 */
export function buildTaskTimelineView(
  facts: BackendTimelineTaskFacts & {
    readonly pendingBackendTransition?: PendingBackendTransition;
  },
): TaskTimelineView {
  const layout = deriveBackendTimelineLayout(facts);
  const pending = facts.pendingBackendTransition;
  // Agent 起源的 task：第 0 段的首行在第一次离开 zcode 时就记在迁移记录里（确定、免读取）；
  // Codex 起源的 task 需要 Host 读 thread 才知道，留给服务层补齐。
  const firstCommitted = (facts.backendTransitions ?? []).find((r) => r.status === "committed");
  const firstComposedRowId =
    layout.layoutVersion > 0 && layout.segments[0]?.backend === "zcode"
      ? typeof firstCommitted?.sourceFirstRowId === "number"
        ? composedTimelineRowId(layout, 0, firstCommitted.sourceFirstRowId)
        : composedTimelineMarkerRowId(layout, 1)
      : undefined;
  return {
    taskId: facts.taskId,
    executionBackend: facts.executionBackend ?? "zcode",
    layoutVersion: layout.layoutVersion,
    ...(firstComposedRowId === undefined ? {} : { firstComposedRowId }),
    segments: layout.segments.map((segment) => ({
      index: segment.index,
      backend: segment.backend,
      ...(segment.providerId === undefined ? {} : { providerId: segment.providerId }),
      live: segment.live,
      ...(segment.openedByTransitionIndex === undefined
        ? {}
        : { openedByTransitionIndex: segment.openedByTransitionIndex }),
      visibility: segmentVisibility(segment),
    })),
    transitions: (facts.backendTransitions ?? []).map(toBackendTransitionView),
    ...(pending
      ? {
          pending: {
            phase: pending.phase,
            to: pending.to,
            ...(pending.toProviderId === undefined ? {} : { toProviderId: pending.toProviderId }),
            requestedAt: pending.requestedAt,
          },
        }
      : {}),
  };
}

/** UI：从视图重建布局（Codex 段的 threadId 为空占位——UI 只经 Host 按段下标读取历史段）。 */
export function layoutFromTaskTimelineView(view: TaskTimelineView): BackendTimelineLayout {
  const segments: BackendTimelineSegment[] = view.segments.map((segment) => ({
    index: segment.index,
    backend: segment.backend,
    ...(segment.providerId === undefined ? {} : { providerId: segment.providerId }),
    live: segment.live,
    ...(segment.openedByTransitionIndex === undefined
      ? {}
      : { openedByTransitionIndex: segment.openedByTransitionIndex }),
    source:
      segment.visibility.kind === "zcode"
        ? {
            kind: "zcode",
            sessionId: view.taskId,
            ...(segment.visibility.afterRowId === undefined
              ? {}
              : { afterRowId: segment.visibility.afterRowId }),
            ...(segment.visibility.throughRowId === undefined
              ? {}
              : { throughRowId: segment.visibility.throughRowId }),
          }
        : {
            kind: "codex",
            threadId: "",
            hiddenSourceTurnIds: segment.visibility.hiddenSourceTurnIds,
          },
  }));
  return {
    taskId: view.taskId,
    layoutVersion: view.layoutVersion,
    segments,
    liveIndex: segments.length - 1,
    transitions: view.transitions,
  };
}
