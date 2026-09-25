// 跨后端可见时间线的 renderer 传输层（backend-migration.md Amendment 4）。
//
// 包在按后端路由的传输外面，只做三件事：
// 1. 组合：live 段帧原样（rowId 不变），按段可见性过滤 handoff 轮/种子行；历史段与迁移 marker
//    以负 rowId 前置，经 Host 迁移服务按段下标只读取回——UI 不持有任何 thread id；
// 2. 翻页：rowsRange 越过 live 段后继续进入历史段（共享组合器，确定性、不重复）；
// 3. 换代：收到持久化的 TaskBackendChanged（提交/布局变化）后，在同一个对外 subscriptionId 下
//    换掉内层 live 订阅并推送新快照——写权限随之切到新 executionBackend，历史段仍可读。
// 写命令从不在这里改写：路由层按持久化的 executionBackend 选后端，Host 侧还有写权限栅栏。
import {
  composeTimelineLogEpoch,
  composedTimelineMarkerRowId,
  buildBackendTransitionMarkerRow,
  decomposeTimelineLogEpoch,
  isRowInTimelineSegment,
  layoutFromTaskTimelineView,
  readComposedTimelineRowsBefore,
  type BackendMigrationTaskTarget,
  type BackendTimelineLayout,
  type BackendTimelineSegmentReader,
  type TaskBackendChangedEvent,
  type TaskTimelineView,
} from "@zcode/shared";
import {
  PROTOCOL_V4_LIMITS,
  parseConversationTopic,
  type ConversationDelta,
  type ConversationRow,
  type ConversationTopicFrame,
  type TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTransport } from "@/v4/transport.js";
import { logger } from "@/logger.js";

/** Host 迁移服务里本层需要的只读面。 */
export interface TimelineMigrationReadPort {
  getTaskTimeline(target: BackendMigrationTaskTarget): Promise<TaskTimelineView | null>;
  readTimelineSegmentRows(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    layoutVersion: number;
    segmentIndex: number;
    beforeSourceRowId?: number;
    limit: number;
  }): Promise<{ rows: ConversationRow[]; hasMore: boolean; layoutVersion: number }>;
}

export type RoutedConversationTransport = ConversationTransport & {
  /** 丢弃该 task 的后端路由缓存（持久化归属已变化）。 */
  invalidateRoute?(sessionId: string): void;
};

export type BackendTimelineConversationTransport = ConversationTransport & {
  handleTaskBackendChanged(event: TaskBackendChangedEvent): void;
};

interface ComposedSubscription {
  readonly outwardId: string;
  innerId: string;
  readonly taskId: string;
  readonly topic: string;
  /** null = 未迁移过（layoutVersion 0）：帧原样透传，零回归。 */
  layout: BackendTimelineLayout | null;
  executionBackend: TaskTimelineView["executionBackend"];
  firstComposedRowId: number | null;
  prefix: ConversationRow[];
  liveLogEpoch: string | null;
  liveSeq: number;
  liveRevision: number;
  readonly hiddenLiveRowIds: Set<number>;
  swapping: Promise<void> | null;
}

/** 首屏前置的历史行数上限：只为短 live 窗口补上下文，更早的由 loadOlder 翻页。 */
const PREFIX_ROW_LIMIT = PROTOCOL_V4_LIMITS.snapshotTailWindowRows;

export function createBackendTimelineConversationTransport(options: {
  readonly inner: RoutedConversationTransport;
  readonly migration: TimelineMigrationReadPort;
  readonly workspace: { readonly workspacePath: string; readonly workspaceIdentity?: string };
}): BackendTimelineConversationTransport {
  const { inner, migration } = options;
  const byOutward = new Map<string, ComposedSubscription>();
  const outwardByInner = new Map<string, string>();

  const target = (taskId: string): BackendMigrationTaskTarget => ({
    taskId,
    workspacePath: options.workspace.workspacePath,
    ...(options.workspace.workspaceIdentity
      ? { workspaceIdentity: options.workspace.workspaceIdentity }
      : {}),
  });

  const historicalReader = (
    taskId: string,
    layout: BackendTimelineLayout,
  ): BackendTimelineSegmentReader => ({
    async readBefore({ segment, beforeSourceRowId, limit }) {
      if (segment.live) {
        const result = await inner.rowsRange({
          sessionId: taskId,
          ...(beforeSourceRowId === undefined ? {} : { beforeRowId: beforeSourceRowId }),
          limit: Math.min(limit, PROTOCOL_V4_LIMITS.rowsRangeMaxLimit),
        });
        return { rows: result.rows, hasMore: result.hasMore };
      }
      return migration.readTimelineSegmentRows({
        ...target(taskId),
        layoutVersion: layout.layoutVersion,
        segmentIndex: segment.index,
        ...(beforeSourceRowId === undefined ? {} : { beforeSourceRowId }),
        limit,
      });
    },
  });

  async function loadLayout(taskId: string): Promise<{
    view: TaskTimelineView | null;
    layout: BackendTimelineLayout | null;
    prefix: ConversationRow[];
  }> {
    const view = await migration.getTaskTimeline(target(taskId)).catch(() => null);
    if (!view || view.layoutVersion === 0) return { view, layout: null, prefix: [] };
    const layout = layoutFromTaskTimelineView(view);
    const liveMarker = buildBackendTransitionMarkerRow(layout, layout.liveIndex);
    const older = await readComposedTimelineRowsBefore({
      layout,
      reader: historicalReader(taskId, layout),
      beforeRowId: composedTimelineMarkerRowId(layout, layout.liveIndex),
      limit: PREFIX_ROW_LIMIT,
    });
    return { view, layout, prefix: liveMarker ? [...older.rows, liveMarker] : older.rows };
  }

  function liveSegmentReachedStart(
    sub: ComposedSubscription,
    rawWindow: readonly ConversationRow[],
    sourceFirstRowId: number | null,
  ): boolean {
    const live = sub.layout?.segments[sub.layout.liveIndex];
    const first = rawWindow[0];
    if (!live || !first) return true;
    const afterRowId = live.source.kind === "zcode" ? live.source.afterRowId : undefined;
    // zcode live 段的下界之下还有行（更早的 Agent 段/种子）⇒ 窗口已覆盖 live 段的开头。
    if (afterRowId !== undefined && rawWindow.some((row) => row.rowId <= afterRowId)) return true;
    return sourceFirstRowId === null || first.rowId <= sourceFirstRowId;
  }

  function composeRows(
    sub: ComposedSubscription,
    rows: readonly ConversationRow[],
  ): ConversationRow[] {
    const live = sub.layout?.segments[sub.layout.liveIndex];
    if (!live) return [...rows];
    return rows.filter((row) => {
      if (isRowInTimelineSegment(live, row)) return true;
      sub.hiddenLiveRowIds.add(row.rowId);
      return false;
    });
  }

  function composeDelta(
    sub: ComposedSubscription,
    delta: ConversationDelta,
  ): ConversationDelta | null {
    if (delta.op === "row.appended" || delta.op === "row.upserted") {
      return composeRows(sub, [delta.row]).length === 1 ? delta : null;
    }
    if (delta.op === "row.delta") return sub.hiddenLiveRowIds.has(delta.rowId) ? null : delta;
    return delta;
  }

  function transformFrame(
    sub: ComposedSubscription,
    frame: ConversationTopicFrame,
  ): ConversationTopicFrame {
    const outward = { ...frame, subscriptionId: sub.outwardId };
    if (frame.payload.kind === "snapshot") {
      const snapshot = frame.payload.snapshot;
      sub.liveLogEpoch = snapshot.logEpoch;
      sub.liveSeq = snapshot.seq;
      sub.liveRevision = snapshot.revision;
      if (!sub.layout) return outward;
      const liveWindow = composeRows(sub, snapshot.rows.window);
      const prepend = liveSegmentReachedStart(sub, snapshot.rows.window, snapshot.rows.firstRowId);
      const window = prepend ? [...sub.prefix, ...liveWindow] : liveWindow;
      return {
        ...outward,
        payload: {
          kind: "snapshot",
          snapshot: {
            ...snapshot,
            logEpoch: composeTimelineLogEpoch(sub.layout, snapshot.logEpoch),
            rows: {
              window,
              totalCount: snapshot.rows.totalCount + sub.prefix.length,
              firstRowId: sub.firstComposedRowId ?? window[0]?.rowId ?? null,
            },
          },
        },
      };
    }
    sub.liveSeq = frame.toSeq;
    if (!sub.layout) return outward;
    const deltas = frame.payload.deltas
      .map((delta) => composeDelta(sub, delta))
      .filter((delta): delta is ConversationDelta => delta !== null);
    return { ...outward, payload: { kind: "deltas", deltas } };
  }

  function register(sub: ComposedSubscription): void {
    byOutward.set(sub.outwardId, sub);
    outwardByInner.set(sub.innerId, sub.outwardId);
  }

  function composedEpoch(sub: ComposedSubscription, liveEpoch: string): string {
    return sub.layout ? composeTimelineLogEpoch(sub.layout, liveEpoch) : liveEpoch;
  }

  /** 布局变化：同一对外订阅下换掉内层 live 订阅，推送新后端的快照。 */
  async function swapLiveSubscription(sub: ComposedSubscription): Promise<void> {
    inner.invalidateRoute?.(sub.taskId);
    const { view, layout, prefix } = await loadLayout(sub.taskId);
    const previousInner = sub.innerId;
    sub.layout = layout;
    sub.prefix = prefix;
    sub.executionBackend = view?.executionBackend ?? "zcode";
    sub.firstComposedRowId = view?.firstComposedRowId ?? null;
    sub.hiddenLiveRowIds.clear();
    const result = await inner.subscribe({ topic: sub.topic });
    outwardByInner.delete(previousInner);
    sub.innerId = result.ack.subscriptionId;
    outwardByInner.set(sub.innerId, sub.outwardId);
    inner.activate(sub.innerId);
    await inner.unsubscribe(previousInner).catch(() => undefined);
  }

  const transport: BackendTimelineConversationTransport = {
    ...inner,
    async subscribe(params) {
      const taskId = parseConversationTopic(params.topic);
      if (!taskId) return inner.subscribe(params);
      const { view, layout, prefix } = await loadLayout(taskId);
      // 组合 epoch 只在布局版本一致时才能还原成 live 后端的 resume 基线；否则丢弃基线走快照。
      const { base, ...rest } = params;
      const liveEpoch = !base
        ? null
        : layout
          ? decomposeTimelineLogEpoch(layout, base.logEpoch)
          : base.logEpoch.includes("::bt")
            ? null
            : base.logEpoch;
      const result = await inner.subscribe(
        base && liveEpoch ? { ...rest, base: { ...base, logEpoch: liveEpoch } } : rest,
      );
      const sub: ComposedSubscription = {
        outwardId: result.ack.subscriptionId,
        innerId: result.ack.subscriptionId,
        taskId,
        topic: params.topic,
        layout,
        executionBackend: view?.executionBackend ?? "zcode",
        firstComposedRowId: view?.firstComposedRowId ?? null,
        prefix,
        liveLogEpoch: result.ack.logEpoch,
        liveSeq: 0,
        liveRevision: 0,
        hiddenLiveRowIds: new Set(),
        swapping: null,
      };
      register(sub);
      return {
        ...result,
        ack: { ...result.ack, logEpoch: composedEpoch(sub, result.ack.logEpoch) },
      };
    },
    activate(subscriptionId) {
      inner.activate(byOutward.get(subscriptionId)?.innerId ?? subscriptionId);
    },
    async resync(params) {
      const sub = byOutward.get(params.subscriptionId);
      if (!sub) return inner.resync(params);
      const liveBase =
        params.base && sub.layout
          ? decomposeTimelineLogEpoch(sub.layout, params.base.logEpoch)
          : params.base?.logEpoch;
      const result = await inner.resync({
        ...params,
        subscriptionId: sub.innerId,
        base: params.base && liveBase ? { ...params.base, logEpoch: liveBase } : null,
      });
      return {
        ...result,
        ack: {
          ...result.ack,
          subscriptionId: sub.outwardId,
          logEpoch: composedEpoch(sub, result.ack.logEpoch),
        },
      };
    },
    async unsubscribe(subscriptionId) {
      const sub = byOutward.get(subscriptionId);
      byOutward.delete(subscriptionId);
      if (sub) outwardByInner.delete(sub.innerId);
      await inner.unsubscribe(sub?.innerId ?? subscriptionId);
    },
    async rowsRange(params) {
      const sub = [...byOutward.values()].find(
        (entry) => entry.taskId === params.sessionId && entry.layout,
      );
      if (!sub?.layout) return inner.rowsRange(params);
      const layout = sub.layout;
      const result = await readComposedTimelineRowsBefore({
        layout,
        reader: historicalReader(sub.taskId, layout),
        ...(params.beforeRowId === undefined ? {} : { beforeRowId: params.beforeRowId }),
        limit: params.limit,
      });
      return {
        rows: result.rows,
        hasMore: result.hasMore,
        atSeq: sub.liveSeq,
        atRevision: sub.liveRevision,
        atLogEpoch: composeTimelineLogEpoch(layout, sub.liveLogEpoch ?? ""),
      };
    },
    onFrame(
      listener: (
        frame: ConversationTopicFrame,
        context?: { deliveryKind: TopicFrameDeliveryKind },
      ) => void,
    ) {
      return inner.onFrame((frame, context) => {
        const outwardId = outwardByInner.get(frame.subscriptionId);
        const sub = outwardId ? byOutward.get(outwardId) : undefined;
        listener(sub ? transformFrame(sub, frame) : frame, context);
      });
    },
    onAssemblyFault(listener) {
      return inner.onAssemblyFault((fault) => {
        const outwardId = outwardByInner.get(fault.subscriptionId);
        listener(outwardId ? { ...fault, subscriptionId: outwardId } : fault);
      });
    },
    handleTaskBackendChanged(event) {
      for (const sub of byOutward.values()) {
        if (sub.taskId !== event.taskId) continue;
        const layoutVersion = sub.layout?.layoutVersion ?? 0;
        if (
          layoutVersion === event.layoutVersion &&
          sub.executionBackend === event.executionBackend
        )
          continue;
        if (sub.swapping) continue;
        sub.swapping = swapLiveSubscription(sub)
          .catch((error: unknown) => {
            logger.warn(
              `[v4-timeline] ${sub.topic} live subscription swap failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          })
          .finally(() => {
            sub.swapping = null;
          });
      }
    },
  };
  return transport;
}
