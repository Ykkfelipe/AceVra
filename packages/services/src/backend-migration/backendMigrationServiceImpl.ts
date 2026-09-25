// 后端迁移应用服务实现（phase 11，backend-migration.md Amendment 3/4）。
//
// 所有者与事件顺序：
//   UI switchTaskBackend ─▶ 本服务（进程内单飞 + 持久层 begin 栅栏，跨 Host 生效）
//     ─▶ migrateBackend（编排：prepared → destinationCreated → handoffRunning → readyToCommit）
//     ─▶ TaskIndexRepo.applyBackendMigrationPatch（每一步都是栅栏写入；commit 是同一次写）
//     ─▶ 提交后：释放 Codex 缓存 runtime（下次访问按持久化绑定冷恢复）、广播 TaskBackendChanged
// 本服务不缓存任何归属事实：每个请求都从 task 行读取；UI 状态从不作为后端权威。
import { Emitter, type Event } from "@zcode/rpc";
import {
  buildTaskTimelineView,
  composedTimelineMarkerRowId,
  composedTimelineRowId,
  deriveBackendTimelineLayout,
  isRowInTimelineSegment,
  liveSegmentRowBounds,
  parseModelPickerValue,
  readFullComposedTimeline,
  resolveWorkspaceKey,
  selectComposedRowsAfterLastSegmentOf,
  toBackendTransitionView,
  type BackendHandoffEntry,
  type BackendMigrationTaskTarget,
  type ReadHandoffDetailsParams,
  type ReadTimelineSegmentRowsParams,
  type SwitchTaskBackendParams,
  type SwitchTaskBackendResult,
  type TaskBackendChangedEvent,
  type TaskTimelineView,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { CodexExecutionPolicy, CodexMigrationBridge } from "#src/codex/contract.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { CONSERVATIVE_CODEX_CONTEXT_WINDOW_TOKENS } from "./backendHandoffCompaction.js";
import { migrateBackend } from "./backendMigrationOrchestrator.js";
import type { BackendMigrationTaskStore } from "./backendMigrationPorts.js";
import {
  backendMigrationConnectionScopeFactory,
  type IBackendMigrationService,
} from "./backendMigrationService.js";
import {
  agentTargetFor,
  createCodexDestination,
  createSegmentReader,
  createZCodeDestination,
  hashHandoffTranscript,
  type BackendMigrationAgentService,
} from "./backendMigrationSources.js";
import { ConcurrentBackendTransitionError } from "./backendTransitionStateMachine.js";
import { createOwnerLivenessCheck } from "./hostInstanceIdentity.js";
import { recoverOrphanedBackendTransitions } from "./recoverOrphanedBackendTransitions.js";
import {
  createTaskIndexMigrationStore,
  readBackendMigrationTaskState,
} from "./taskIndexMigrationStore.js";

const logger = createServiceLogger("backend-migration");

/** zcode provider 的 context window 在 Host 侧不可得时的保守预算；CLI 自身还有 auto-compact。 */
const CONSERVATIVE_ZCODE_CONTEXT_WINDOW_TOKENS = 128_000;

export interface BackendMigrationServiceDeps {
  readonly taskIndex: Pick<
    TaskIndexRepo,
    "getTaskMeta" | "applyBackendMigrationPatch" | "listTasksWithPendingBackendTransition"
  >;
  /** Codex 未安装/旧 Host 时缺省：迁入 Codex 被拒绝为 destination_unavailable。 */
  readonly codex?: CodexMigrationBridge;
  /** Codex 二进制可能在 Host 启动后才安装/卸载：每次请求时判定。 */
  readonly isCodexAvailable?: () => boolean;
  readonly codexPolicy: CodexExecutionPolicy;
  readonly hostInstanceId: string;
  readonly now?: () => number;
  readonly handoffTimeoutMs?: number;
}

function taskKey(target: BackendMigrationTaskTarget): string {
  return `${resolveWorkspaceKey(target)}\u0000${target.taskId}`;
}

function summaryPrompt(prefix: readonly BackendHandoffEntry[]): string {
  return [
    "Summarize the earlier part of this coding task so another agent can continue it.",
    "Keep decisions, constraints, file paths, identifiers, open problems and exact facts",
    "(names, numbers, tokens). Do not invent anything. Plain text, no preamble.",
    "",
    ...prefix.map((entry) => `${entry.role}: ${entry.content}`),
  ].join("\n");
}

export class BackendMigrationService implements IBackendMigrationService {
  readonly #deps: BackendMigrationServiceDeps;
  readonly #now: () => number;
  readonly #active = new Map<string, Promise<SwitchTaskBackendResult>>();
  readonly #changed = new Emitter<TaskBackendChangedEvent>();

  constructor(deps: BackendMigrationServiceDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
  }

  /** Host attachment：绑定本连接可信的 Agent scope（zcode 行读取需要可信 connection）。 */
  [backendMigrationConnectionScopeFactory](
    agent: BackendMigrationAgentService,
  ): IBackendMigrationService {
    return {
      switchTaskBackend: (params) => this.#switch(params, agent),
      getTaskTimeline: (params) => this.getTaskTimeline(params),
      readTimelineSegmentRows: (params) => this.#readSegmentRows(params, agent),
      readHandoffDetails: (params) => this.readHandoffDetails(params),
      onDynamicTaskBackendChanged: () => this.onDynamicTaskBackendChanged(),
    };
  }

  async switchTaskBackend(): Promise<SwitchTaskBackendResult> {
    // 没有可信连接就无法读取 zcode 历史——只有经 attachment scope 的视图可以写。
    return { outcome: "rejected", reason: "destination_unavailable" };
  }

  async getTaskTimeline(params: BackendMigrationTaskTarget): Promise<TaskTimelineView | null> {
    const meta = await this.#readMeta(params);
    if (!meta) return null;
    const view = buildTaskTimelineView(meta);
    if (view.layoutVersion === 0 || view.firstComposedRowId !== undefined) return view;
    // Codex 起源：第 0 段首行只能读 thread 得到（冷恢复重建，rowId 对同一 thread 确定）。
    const layout = deriveBackendTimelineLayout(meta);
    const first = layout.segments[0];
    if (!first || first.source.kind !== "codex" || !this.#deps.codex) return view;
    const rows = await this.#deps.codex.readThreadRows({
      threadId: first.source.threadId,
      policy: this.#deps.codexPolicy,
    });
    const visible = rows.find((row) => isRowInTimelineSegment(first, row));
    return {
      ...view,
      firstComposedRowId: visible
        ? composedTimelineRowId(layout, 0, visible.rowId)
        : composedTimelineMarkerRowId(layout, 1),
    };
  }

  async readTimelineSegmentRows(): Promise<{
    rows: ConversationRow[];
    hasMore: boolean;
    layoutVersion: number;
  }> {
    throw new Error("backend_timeline_connection_untrusted");
  }

  async readHandoffDetails(
    params: ReadHandoffDetailsParams,
  ): Promise<{ rows: ConversationRow[] } | null> {
    const meta = await this.#readMeta(params);
    const record = meta?.backendTransitions?.[params.transitionIndex];
    if (
      !record ||
      record.to !== "codex" ||
      !record.handoffTurnId ||
      !record.destinationExecutionRef
    ) {
      return null;
    }
    if (!this.#deps.codex) return null;
    const rows = await this.#deps.codex.readThreadRows({
      threadId: record.destinationExecutionRef,
      policy: this.#deps.codexPolicy,
    });
    return { rows: rows.filter((row) => row.sourceTurnId === record.handoffTurnId) };
  }

  onDynamicTaskBackendChanged(): Event<TaskBackendChangedEvent> {
    return this.#changed.event;
  }

  /** Host 启动时调用一次：把所有者已不存活的在途迁移确定性地收敛为 failed/restart。 */
  async recoverOrphanedTransitions(): Promise<void> {
    const result = await recoverOrphanedBackendTransitions({
      repo: this.#deps.taskIndex,
      isOwnerAlive: createOwnerLivenessCheck({
        selfInstanceId: this.#deps.hostInstanceId,
        hasActiveMigrationOwnedBySelf: () => this.#active.size > 0,
      }),
      now: this.#now,
      cleanupDestination: async (_meta, pending) => {
        // 孤儿 Codex thread 从未被 task 引用：只需丢弃可能残留的 handoff 收集器。
        if (pending.to === "codex" && pending.destinationExecutionRef) {
          this.#deps.codex?.abandonThread(pending.destinationExecutionRef);
        }
      },
    });
    if (result.recoveredTaskIds.length > 0) {
      logger.info(undefined, "recovered orphaned backend transitions", {
        count: result.recoveredTaskIds.length,
      });
    }
  }

  async #readMeta(target: BackendMigrationTaskTarget): Promise<ZCodeTaskMeta | null> {
    return this.#deps.taskIndex.getTaskMeta({
      taskId: target.taskId,
      workspacePath: target.workspacePath,
      ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    });
  }

  #emit(target: BackendMigrationTaskTarget, meta: ZCodeTaskMeta | null): void {
    if (!meta) return;
    this.#changed.fire({
      taskId: meta.taskId,
      workspaceKey: resolveWorkspaceKey(target),
      layoutVersion: deriveBackendTimelineLayout(meta).layoutVersion,
      executionBackend: meta.executionBackend ?? "zcode",
      pendingPhase: meta.pendingBackendTransition?.phase ?? null,
    });
  }

  async #readSegmentRows(
    params: ReadTimelineSegmentRowsParams,
    agent: BackendMigrationAgentService,
  ): Promise<{ rows: ConversationRow[]; hasMore: boolean; layoutVersion: number }> {
    const meta = await this.#readMeta(params);
    if (!meta) throw new Error("backend_timeline_task_not_found");
    const layout = deriveBackendTimelineLayout(meta);
    if (layout.layoutVersion !== params.layoutVersion) {
      throw new Error("backend_timeline_layout_stale");
    }
    const segment = layout.segments[params.segmentIndex];
    if (!segment) throw new Error("backend_timeline_segment_not_found");
    if (segment.source.kind === "codex" && !this.#deps.codex) {
      throw new Error("backend_timeline_codex_unavailable");
    }
    const reader = createSegmentReader({
      target: params,
      agent,
      codex: this.#deps.codex ?? { readThreadRows: async () => [] },
      codexPolicy: this.#deps.codexPolicy,
    });
    const through =
      segment.source.kind === "zcode" && segment.source.throughRowId !== undefined
        ? segment.source.throughRowId + 1
        : undefined;
    const before =
      params.beforeSourceRowId === undefined
        ? through
        : through === undefined
          ? params.beforeSourceRowId
          : Math.min(through, params.beforeSourceRowId);
    const page = await reader.readBefore({
      segment,
      beforeSourceRowId: before,
      limit: params.limit,
    });
    const rows = page.rows.filter(
      (row) => (before === undefined || row.rowId < before) && isRowInTimelineSegment(segment, row),
    );
    return { rows, hasMore: page.hasMore, layoutVersion: layout.layoutVersion };
  }

  async #switch(
    params: SwitchTaskBackendParams,
    agent: BackendMigrationAgentService,
  ): Promise<SwitchTaskBackendResult> {
    const key = taskKey(params);
    if (this.#active.has(key)) return { outcome: "rejected", reason: "concurrent_transition" };
    const running = this.#runSwitch(params, agent).finally(() => {
      this.#active.delete(key);
    });
    this.#active.set(key, running);
    return running;
  }

  async #runSwitch(
    params: SwitchTaskBackendParams,
    agent: BackendMigrationAgentService,
  ): Promise<SwitchTaskBackendResult> {
    const meta = await this.#readMeta(params);
    if (!meta) return { outcome: "rejected", reason: "task_not_found" };
    const current = meta.executionBackend ?? "zcode";
    // 同后端内换 provider 是已上线的 provider 切换路径，不是迁移（spec「already shipped」）。
    if (params.to === current) return { outcome: "rejected", reason: "same_backend" };
    if (params.to === "codex" && (!this.#deps.codex || this.#deps.isCodexAvailable?.() === false)) {
      return { outcome: "rejected", reason: "destination_unavailable" };
    }
    let toProviderId: string | undefined;
    if (params.to === "zcode") {
      try {
        toProviderId = parseModelPickerValue(params.toModelSelection ?? "").providerId;
      } catch {
        return { outcome: "rejected", reason: "invalid_destination" };
      }
    }
    if (meta.status === "running") return { outcome: "rejected", reason: "turn_in_progress" };
    if (meta.pendingBackendTransition) {
      return { outcome: "rejected", reason: "concurrent_transition" };
    }

    const baseStore = createTaskIndexMigrationStore(this.#deps.taskIndex, {
      workspacePath: meta.workspacePath,
      ...(meta.workspaceIdentity ? { workspaceIdentity: meta.workspaceIdentity } : {}),
    });
    // 每一次落盘之后广播：UI 以持久化阶段为准显示进度，不做乐观完成。
    const store: BackendMigrationTaskStore = {
      ...baseStore,
      begin: async (taskId, pending) => {
        await baseStore.begin(taskId, pending);
        this.#emit(params, await this.#readMeta(params));
      },
      advance: async (taskId, pending) => {
        await baseStore.advance(taskId, pending);
        this.#emit(params, await this.#readMeta(params));
      },
    };
    const requestedSeedId = `${this.#now()}`;
    const reader = createSegmentReader({
      target: params,
      agent,
      codex: this.#deps.codex ?? { readThreadRows: async () => [] },
      codexPolicy: this.#deps.codexPolicy,
    });
    const summarySelection = params.to === "zcode" ? params.toModelSelection : meta.model;
    try {
      const result = await migrateBackend(
        readBackendMigrationTaskState(meta),
        {
          taskId: meta.taskId,
          sessionId: meta.taskId,
          to: params.to,
          ...(toProviderId === undefined ? {} : { toProviderId }),
          ...(params.toModelSelection === undefined
            ? {}
            : { toModelSelection: params.toModelSelection }),
        },
        {
          now: this.#now,
          ownerInstanceId: this.#deps.hostInstanceId,
          generateTranscriptRevision: hashHandoffTranscript,
          readSourceHistory: async (request) => {
            const layout = deriveBackendTimelineLayout(meta);
            const rows = await readFullComposedTimeline({ layout, reader });
            return {
              rows:
                request.to === "zcode"
                  ? selectComposedRowsAfterLastSegmentOf(layout, rows, "zcode")
                  : rows,
              liveSegment: liveSegmentRowBounds(layout, rows),
            };
          },
          resolveDestinationBudget: (request) => ({
            contextWindowTokens:
              request.to === "codex"
                ? CONSERVATIVE_CODEX_CONTEXT_WINDOW_TOKENS
                : CONSERVATIVE_ZCODE_CONTEXT_WINDOW_TOKENS,
          }),
          summarizePrefix: async (prefix) => {
            if (!summarySelection) throw new Error("backend_handoff_no_summary_model");
            const generated = await agent.generateWorkspaceText({
              ...agentTargetFor(params),
              selection: parseModelPickerValue(summarySelection),
              prompt: summaryPrompt(prefix),
              querySource: "backend_handoff_compaction",
            });
            return generated.text;
          },
          codex: createCodexDestination({
            codex: this.#deps.codex ?? {
              startMigrationThread: async () => {
                throw new Error("codex_not_installed");
              },
              runHandoffTurn: async () => {
                throw new Error("codex_not_installed");
              },
              abandonThread: () => undefined,
            },
            ...(this.#deps.handoffTimeoutMs === undefined
              ? {}
              : { handoffTimeoutMs: this.#deps.handoffTimeoutMs }),
          }),
          zcode: createZCodeDestination({
            target: params,
            agent,
            toModelSelection: params.toModelSelection ?? "",
            seedId: requestedSeedId,
          }),
          workspacePath: meta.workspacePath,
          taskTitle: meta.title,
          store,
        },
      );
      if (result.outcome === "committed")
        this.#afterCommit(meta, result.record.destinationExecutionRef);
      const after = await this.#readMeta(params);
      this.#emit(params, after);
      const index = Math.max(0, (after?.backendTransitions?.length ?? 1) - 1);
      logger.info(undefined, "backend switch finished", {
        outcome: result.outcome,
        from: current,
        to: params.to,
        ...(result.outcome === "inDoubt" ? {} : { failureReason: result.record.failureReason }),
      });
      if (result.outcome === "committed") {
        return {
          outcome: "committed",
          transition: toBackendTransitionView(result.record, index),
          layoutVersion: deriveBackendTimelineLayout(after ?? meta).layoutVersion,
        };
      }
      if (result.outcome === "failed") {
        return {
          outcome: "failed",
          transition: toBackendTransitionView(result.record, index),
          recordPersisted: result.recordPersisted,
        };
      }
      return { outcome: "inDoubt" };
    } catch (error) {
      if (error instanceof ConcurrentBackendTransitionError) {
        return { outcome: "rejected", reason: "concurrent_transition" };
      }
      throw error;
    }
  }

  /** 提交后：丢弃 handoff 收集器与缓存 runtime，下一次 Codex 访问按持久化绑定冷恢复。 */
  #afterCommit(meta: ZCodeTaskMeta, destinationRef: string | undefined): void {
    const codex = this.#deps.codex;
    if (!codex) return;
    if (destinationRef) codex.abandonThread(destinationRef);
    codex.releaseTaskRuntime(meta.taskId);
  }
}
