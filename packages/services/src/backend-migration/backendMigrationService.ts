// 后端迁移应用服务契约（phase 11，backend-migration.md Amendment 4）。
//
// UI 对执行后端只有一个写入口：switchTaskBackend。executionBackend、providerId（model 选择）、
// codexThreadId 与迁移元数据都只由服务端的事务（backendMigrationOrchestrator + TaskIndexRepo
// 栅栏写入）改变；UI 观察持久化结果与 onDynamicTaskBackendChanged 事件，不做乐观归属切换。
// 其余方法都是只读：时间线视图、按段下标读取历史段、按迁移下标读取 handoff 细节。
import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type {
  BackendMigrationTaskTarget,
  ReadHandoffDetailsParams,
  ReadTimelineSegmentRowsParams,
  SwitchTaskBackendParams,
  SwitchTaskBackendResult,
  TaskBackendChangedEvent,
  TaskTimelineView,
} from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { createServiceDescriptor } from "#src/descriptors.js";

export interface IBackendMigrationService {
  /** 唯一的写操作：把 task 切到目标后端/provider；成功与否以持久化记录为准。 */
  switchTaskBackend(params: SwitchTaskBackendParams): Promise<SwitchTaskBackendResult>;
  /** 当前持久化的时间线视图（段、迁移记录、在途迁移）；task 不存在返回 null。 */
  getTaskTimeline(params: BackendMigrationTaskTarget): Promise<TaskTimelineView | null>;
  /**
   * 只读：某个历史段的一页源行（rowId 升序、已按段可见性过滤）。live 段也可读，
   * 但 live 段的写入与实时流仍只走当前 executionBackend 的会话传输。
   */
  readTimelineSegmentRows(
    params: ReadTimelineSegmentRowsParams,
  ): Promise<{ rows: ConversationRow[]; hasMore: boolean; layoutVersion: number }>;
  /** 「Show handoff details」：该次 Codex handoff 轮的真实请求与回复（按 Codex turn id 取回）。 */
  readHandoffDetails(params: ReadHandoffDetailsParams): Promise<{ rows: ConversationRow[] } | null>;
  onDynamicTaskBackendChanged(): Event<TaskBackendChangedEvent>;
}

export const IBackendMigrationService = createServiceDescriptor<IBackendMigrationService>(
  ServiceChannels.BackendMigration,
);

/** Host attachment 内部：用本连接已握手的可信 Agent scope 创建同一服务的连接视图。 */
export const backendMigrationConnectionScopeFactory = Symbol(
  "backendMigrationConnectionScopeFactory",
);
