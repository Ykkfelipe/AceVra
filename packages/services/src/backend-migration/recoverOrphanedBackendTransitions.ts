// 重启恢复（spec「Restart-during-migration」+ Amendment 3）：把「所有者已不存活」的
// pendingBackendTransition 确定性地收敛为 failed/restart，executionBackend 一律不动。
//
// 绝不凭「目标端（Codex thread / 种子历史）是否存在」推断归属；也绝不清理存活 Host 的在途
// 迁移——所有者存活判定由调用方注入（真实实现见 hostInstanceIdentity.ts）。
import type { PendingBackendTransition, ZCodeTaskMeta } from "@zcode/shared";
import { BackendMigrationFenceError, type TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { recoverPendingBackendTransitionOnLoad } from "./backendTransitionStateMachine.js";
import { readBackendMigrationTaskState } from "./taskIndexMigrationStore.js";

export interface RecoverOrphanedBackendTransitionsParams {
  readonly repo: Pick<
    TaskIndexRepo,
    "listTasksWithPendingBackendTransition" | "applyBackendMigrationPatch"
  >;
  readonly isOwnerAlive: (ownerInstanceId: string | undefined) => boolean;
  readonly now: () => number;
  /** best-effort 目标端清理（放弃孤儿 Codex thread / 删除孤儿种子历史）；失败不影响恢复。 */
  readonly cleanupDestination?: (
    meta: ZCodeTaskMeta,
    pending: PendingBackendTransition,
  ) => Promise<void>;
}

export interface RecoverOrphanedBackendTransitionsResult {
  readonly recoveredTaskIds: readonly string[];
  /** 所有者仍存活，留给它自己完成或失败。 */
  readonly liveTaskIds: readonly string[];
  /** 恢复写入时栅栏已变化（所有者恰好在此期间收尾），无需处理。 */
  readonly raceResolvedTaskIds: readonly string[];
}

export async function recoverOrphanedBackendTransitions(
  params: RecoverOrphanedBackendTransitionsParams,
): Promise<RecoverOrphanedBackendTransitionsResult> {
  const recoveredTaskIds: string[] = [];
  const liveTaskIds: string[] = [];
  const raceResolvedTaskIds: string[] = [];
  const metas = await params.repo.listTasksWithPendingBackendTransition();
  for (const meta of metas) {
    const pending = meta.pendingBackendTransition;
    if (!pending) continue;
    if (params.isOwnerAlive(pending.ownerInstanceId)) {
      liveTaskIds.push(meta.taskId);
      continue;
    }
    const state = readBackendMigrationTaskState(meta);
    const recovered = recoverPendingBackendTransitionOnLoad({
      pending,
      currentBackend: state.executionBackend,
      ...(state.providerId === undefined ? {} : { currentProviderId: state.providerId }),
      recoveredAt: params.now(),
    });
    if (!recovered) continue;
    try {
      await params.repo.applyBackendMigrationPatch({
        workspacePath: meta.workspacePath,
        ...(meta.workspaceIdentity ? { workspaceIdentity: meta.workspaceIdentity } : {}),
        taskId: meta.taskId,
        fence: {
          kind: "owned",
          requestedAt: pending.requestedAt,
          ownerInstanceId: pending.ownerInstanceId,
        },
        patch: {
          pendingBackendTransition: undefined,
          appendTransition: recovered.transitionRecord,
        },
      });
    } catch (error) {
      if (error instanceof BackendMigrationFenceError) {
        raceResolvedTaskIds.push(meta.taskId);
        continue;
      }
      throw error;
    }
    recoveredTaskIds.push(meta.taskId);
    if (params.cleanupDestination) {
      try {
        await params.cleanupDestination(meta, pending);
      } catch {
        // best-effort：孤儿目标端从未被 task 引用，放弃它是安全的。
      }
    }
  }
  return { recoveredTaskIds, liveTaskIds, raceResolvedTaskIds };
}
