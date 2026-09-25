// 跨段时间线的分页读取（backend-migration.md Amendment 4「Pagination」）：从组合游标向前取一窗，
// 跨段、含 marker；读取器注入，本文件无 IO。
import {
  buildBackendTransitionMarkerRow,
  composeTimelineSegmentRows,
  decodeComposedTimelineRowId,
  type BackendTimelineLayout,
  type BackendTimelineSegment,
} from "./backend-timeline.js";
import type { ConversationRow } from "./zcode-protocol-v4/rows.js";

/**
 * 段读取器：只读，按源 rowId 向前翻页（rows 升序）。实现方负责把 beforeSourceRowId 限制在
 * 段范围内；Codex 历史 thread 只能整段读（Codex 仅提供正向分页），可以忽略游标返回整段。
 */
export interface BackendTimelineSegmentReader {
  readBefore(params: {
    segment: BackendTimelineSegment;
    beforeSourceRowId: number | undefined;
    limit: number;
  }): Promise<{ rows: readonly ConversationRow[]; hasMore: boolean }>;
}

interface SegmentCursor {
  segmentIndex: number;
  /** 源 rowId 的不含上界；undefined = 段尾。 */
  beforeSourceRowId: number | undefined;
  /** 本段的「打开」marker 是否已经收集（游标位于 marker 之前时为 true）。 */
  markerTaken: boolean;
}

function cursorFromComposedRowId(
  layout: BackendTimelineLayout,
  beforeRowId: number | undefined,
): SegmentCursor | null {
  if (beforeRowId === undefined) {
    return { segmentIndex: layout.liveIndex, beforeSourceRowId: undefined, markerTaken: false };
  }
  const decoded = decodeComposedTimelineRowId(layout, beforeRowId);
  if (decoded.kind === "invalid") return null;
  if (decoded.kind === "marker") {
    // 游标就是 marker(k)：从第 k−1 段的段尾继续。
    return {
      segmentIndex: decoded.segmentIndex - 1,
      beforeSourceRowId: undefined,
      markerTaken: false,
    };
  }
  return {
    segmentIndex: decoded.segmentIndex,
    beforeSourceRowId: decoded.sourceRowId,
    markerTaken: false,
  };
}

function upperBoundForSegment(
  segment: BackendTimelineSegment,
  before: number | undefined,
): number | undefined {
  if (segment.source.kind !== "zcode") return before;
  const through = segment.source.throughRowId;
  if (through === undefined) return before;
  const segmentEnd = through + 1;
  return before === undefined ? segmentEnd : Math.min(before, segmentEnd);
}

/**
 * 从组合游标向前取至多 limit 行（跨段、含 marker），rows 升序。hasMore 只有在确实到达
 * 第 0 段开头时才为 false。单段内按读取器分页；段内过滤后行数不足时继续向前读。
 */
export async function readComposedTimelineRowsBefore(params: {
  layout: BackendTimelineLayout;
  reader: BackendTimelineSegmentReader;
  beforeRowId?: number;
  limit: number;
}): Promise<{ rows: ConversationRow[]; hasMore: boolean }> {
  const { layout, reader, limit } = params;
  const cursor = cursorFromComposedRowId(layout, params.beforeRowId);
  if (!cursor || cursor.segmentIndex < 0) return { rows: [], hasMore: false };
  const collected: ConversationRow[] = [];
  let segmentIndex = cursor.segmentIndex;
  let before = cursor.beforeSourceRowId;
  while (segmentIndex >= 0 && collected.length < limit) {
    const segment = layout.segments[segmentIndex]!;
    let segmentExhausted = false;
    while (collected.length < limit) {
      const bound = upperBoundForSegment(segment, before);
      const page = await reader.readBefore({ segment, beforeSourceRowId: bound, limit });
      const inRange = page.rows.filter((row) => bound === undefined || row.rowId < bound);
      const visible = composeTimelineSegmentRows(layout, segmentIndex, inRange);
      collected.unshift(...visible);
      const oldest = inRange[0]?.rowId;
      const reachedLowerBound =
        segment.source.kind === "zcode" &&
        segment.source.afterRowId !== undefined &&
        oldest !== undefined &&
        oldest <= segment.source.afterRowId + 1;
      if (
        !page.hasMore ||
        inRange.length === 0 ||
        reachedLowerBound ||
        segment.source.kind === "codex"
      ) {
        segmentExhausted = true;
        break;
      }
      before = oldest;
    }
    if (!segmentExhausted) break;
    const marker = buildBackendTransitionMarkerRow(layout, segmentIndex);
    if (marker) collected.unshift(marker);
    segmentIndex -= 1;
    before = undefined;
  }
  const reachedStart = segmentIndex < 0;
  if (collected.length > limit) {
    return { rows: collected.slice(collected.length - limit), hasMore: true };
  }
  return { rows: collected, hasMore: !reachedStart };
}

/**
 * 全量组合（迁移 transcript 与公开分享用）：从第 0 段到 live 段，handoff 轮与种子行已排除。
 */
export async function readFullComposedTimeline(params: {
  layout: BackendTimelineLayout;
  reader: BackendTimelineSegmentReader;
  pageLimit?: number;
  maxPages?: number;
}): Promise<ConversationRow[]> {
  const pageLimit = params.pageLimit ?? 200;
  const maxPages = params.maxPages ?? 1000;
  const pages: ConversationRow[][] = [];
  let beforeRowId: number | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await readComposedTimelineRowsBefore({
      layout: params.layout,
      reader: params.reader,
      ...(beforeRowId === undefined ? {} : { beforeRowId }),
      limit: pageLimit,
    });
    pages.unshift(result.rows);
    const first = result.rows[0];
    if (!result.hasMore || !first) return pages.flat();
    beforeRowId = first.rowId;
  }
  throw new Error(`timeline paging exceeded ${maxPages} pages for task ${params.layout.taskId}`);
}
