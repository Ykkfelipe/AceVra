// 迁移编排的持久化适配器：把 BackendMigrationTaskStore 端口接到真实 TaskIndexRepo 的
// 栅栏写入（applyBackendMigrationPatch）。见 backend-migration.md Amendment 3。
//
// 只做形状翻译和错误类型映射，不做任何时序决策——时序全部在 backendMigrationOrchestrator.ts。
import { parseModelPickerValue, type ZCodeTaskMeta } from "@zcode/shared";
import {
  BackendMigrationFenceError,
  type BackendMigrationMetaPatch,
  type TaskIndexRepo,
} from "#src/session/taskIndexRepo.js";
import {
  BackendTransitionOwnershipLostError,
  ConcurrentBackendTransitionError,
} from "./backendTransitionStateMachine.js";
import type {
  BackendMigrationTaskState,
  BackendMigrationTaskStore,
} from "./backendMigrationPorts.js";

export type BackendMigrationTaskIndex = Pick<
  TaskIndexRepo,
  "applyBackendMigrationPatch" | "getTaskMeta"
>;

export interface BackendMigrationTaskRef {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
}

function providerIdFromModelSelection(model: string | undefined): string | undefined {
  if (!model?.trim()) return undefined;
  try {
    return parseModelPickerValue(model).providerId;
  } catch {
    return undefined;
  }
}

/**
 * task 行 → 编排层视角的迁移状态。providerId 只在 zcode 后端有意义（从 model 选择解析）；
 * sourceExecutionRef 只在 Codex 后端有意义（当前 codexThreadId）。
 */
export function readBackendMigrationTaskState(meta: ZCodeTaskMeta): BackendMigrationTaskState {
  const executionBackend = meta.executionBackend ?? "zcode";
  const providerId =
    executionBackend === "zcode" ? providerIdFromModelSelection(meta.model) : undefined;
  const sourceExecutionRef = executionBackend === "codex" ? meta.codexThreadId : undefined;
  return {
    executionBackend,
    ...(providerId === undefined ? {} : { providerId }),
    ...(sourceExecutionRef === undefined ? {} : { sourceExecutionRef }),
    ...(meta.pendingBackendTransition
      ? { pendingBackendTransition: meta.pendingBackendTransition }
      : {}),
    ...(meta.backendTransitions ? { backendTransitions: meta.backendTransitions } : {}),
  };
}

export function createTaskIndexMigrationStore(
  repo: BackendMigrationTaskIndex,
  ref: BackendMigrationTaskRef,
): BackendMigrationTaskStore {
  const target = (taskId: string) => ({
    workspacePath: ref.workspacePath,
    ...(ref.workspaceIdentity ? { workspaceIdentity: ref.workspaceIdentity } : {}),
    taskId,
  });

  const owned = async (
    taskId: string,
    pending: { requestedAt: number; ownerInstanceId?: string },
    patch: BackendMigrationMetaPatch,
  ): Promise<void> => {
    try {
      await repo.applyBackendMigrationPatch({
        ...target(taskId),
        fence: {
          kind: "owned",
          requestedAt: pending.requestedAt,
          ownerInstanceId: pending.ownerInstanceId,
        },
        patch,
      });
    } catch (error) {
      if (error instanceof BackendMigrationFenceError) {
        throw new BackendTransitionOwnershipLostError(taskId);
      }
      throw error;
    }
  };

  return {
    async begin(taskId, pending) {
      try {
        await repo.applyBackendMigrationPatch({
          ...target(taskId),
          fence: { kind: "begin" },
          patch: { pendingBackendTransition: pending },
        });
      } catch (error) {
        if (error instanceof BackendMigrationFenceError && error.current) {
          throw new ConcurrentBackendTransitionError(error.current);
        }
        throw error;
      }
    },
    advance(taskId, pending) {
      return owned(taskId, pending, { pendingBackendTransition: pending });
    },
    finish(taskId, pending, outcome) {
      return owned(taskId, pending, {
        pendingBackendTransition: undefined,
        appendTransition: outcome.record,
        ...(outcome.commit
          ? {
              executionBackend: outcome.commit.executionBackend,
              codexThreadId: outcome.commit.codexThreadId,
              ...(outcome.commit.modelSelection === undefined
                ? {}
                : { model: outcome.commit.modelSelection }),
            }
          : {}),
      });
    },
    async read(taskId) {
      const meta = await repo.getTaskMeta(target(taskId));
      if (!meta) throw new Error(`task index 中不存在 task: ${taskId}`);
      return readBackendMigrationTaskState(meta);
    },
  };
}
