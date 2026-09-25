// 单个 task 的后端迁移视图与操作（backend-migration.md Amendment 4）。
//
// 权威永远在 Host 的持久化 task 行：这里只缓存最近一次读到的时间线视图，并在
// TaskBackendChanged 事件到达时重新读取。switching 仅表示「本窗口发出的请求尚未返回」，
// 用于禁用重复点击；是否已切换以持久化视图的 executionBackend 为准，从不乐观完成。
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BackendTransitionPhase,
  SwitchTaskBackendResult,
  TaskTimelineView,
  ZCodeExecutionBackend,
} from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { useBackendMigrationService } from "@/hooks/useBackendMigrationService.js";
import { logger } from "@/logger.js";

export interface TaskBackendMigrationTarget {
  readonly taskId: string | null;
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
}

export interface TaskBackendMigrationControl {
  readonly available: boolean;
  readonly view: TaskTimelineView | null;
  /** 本窗口发起的切换请求在途。 */
  readonly switching: boolean;
  /** 持久化的在途迁移阶段（任何窗口/设备发起的都算）。 */
  readonly pendingPhase: BackendTransitionPhase | null;
  readonly pendingTo: ZCodeExecutionBackend | null;
  switchBackend(
    to: ZCodeExecutionBackend,
    toModelSelection?: string,
  ): Promise<SwitchTaskBackendResult | null>;
  loadHandoffDetails(transitionIndex: number): Promise<ConversationRow[] | null>;
}

export function useTaskBackendMigration(
  target: TaskBackendMigrationTarget,
): TaskBackendMigrationControl {
  const service = useBackendMigrationService();
  const [view, setView] = useState<TaskTimelineView | null>(null);
  const [switching, setSwitching] = useState(false);
  const { taskId, workspacePath, workspaceIdentity } = target;
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    if (!service || !taskId) {
      setView(null);
      return;
    }
    const seq = (requestSeq.current += 1);
    const next = await service
      .getTaskTimeline({
        taskId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      })
      .catch(() => null);
    // 迟到的旧响应不得覆盖更新的读取结果。
    if (seq === requestSeq.current) setView(next);
  }, [service, taskId, workspacePath, workspaceIdentity]);

  useEffect(() => {
    void refresh();
    if (!service || !taskId) return;
    const subscription = service.onDynamicTaskBackendChanged()((event) => {
      if (event.taskId === taskId) void refresh();
    });
    return () => subscription.dispose();
  }, [refresh, service, taskId]);

  const switchBackend = useCallback(
    async (to: ZCodeExecutionBackend, toModelSelection?: string) => {
      if (!service || !taskId) return null;
      setSwitching(true);
      try {
        return await service.switchTaskBackend({
          taskId,
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          to,
          ...(toModelSelection ? { toModelSelection } : {}),
        });
      } catch (error) {
        logger.warn(
          `[backend-migration] switch request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      } finally {
        setSwitching(false);
        void refresh();
      }
    },
    [refresh, service, taskId, workspacePath, workspaceIdentity],
  );

  const loadHandoffDetails = useCallback(
    async (transitionIndex: number) => {
      if (!service || !taskId) return null;
      const details = await service
        .readHandoffDetails({
          taskId,
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          transitionIndex,
        })
        .catch(() => null);
      return details?.rows ?? null;
    },
    [service, taskId, workspacePath, workspaceIdentity],
  );

  return {
    available: Boolean(service && taskId),
    view,
    switching,
    pendingPhase: view?.pending?.phase ?? null,
    pendingTo: view?.pending?.to ?? null,
    switchBackend,
    loadHandoffDetails,
  };
}
