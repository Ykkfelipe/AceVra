// Codex 执行后端服务实现（app 层）。
//
// 组合：CodexAppServerPort（唯一被允许触达 codex app-server 的 bridge）+ CodexTaskIndexPort
// （harness 任务索引持久化）+ CodexTaskRuntime（每任务 thread 投影）。
// 边界承诺：本服务对外只发布 v4 会话投影与脱敏任务绑定；bridge 的 stderr、auth 面、
// OAuth URL 一律不进入本文件；任务↔thread 绑定持久化在 meta_json 的
// executionBackend/codexThreadId。v4 命令处理见 codexConversationCommands.ts。
import { Emitter } from "@zcode/rpc";
import { createUuid } from "@zcode/shared";
import type {
  CodexExecutionApprovalDecision,
  CodexExecutionCreateTaskParams,
  CodexExecutionCreateTaskResult,
  CodexExecutionListTasksParams,
  CodexExecutionListTasksResult,
  CodexExecutionReadTaskParams,
  CodexExecutionSendTurnParams,
  CodexTaskThreadInfo,
  ZCodeTaskMeta,
} from "@zcode/shared";
import type { ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { codexUnroutableApprovalResponse } from "#src/codex/domain/codexApprovals.js";
import type { ITaskArtifactRegistry } from "#src/task-artifacts/contract.js";
import { deliverCompletedTurnArtifacts } from "./codexDeliveryIntegration.js";
import { toCodexTaskBinding } from "#src/codex/domain/codexBinding.js";
import type { CodexExecutionPolicy, CodexModelOverride } from "#src/codex/domain/codexPolicy.js";
import { resolveCodexModelOverride } from "#src/codex/domain/codexPolicy.js";
import type { CodexProjectionCommit } from "#src/codex/domain/codexProjection.js";
import { CodexTaskRuntime, ensureRuntimeForTask, startCodexThread } from "./codexTaskRuntime.js";
import type { CodexAppServerPort, CodexTaskIndexPort } from "./codexPorts.js";
import { createCodexNotificationRouter } from "./codexNotificationRouter.js";
import { persistCodexStatus, persistCodexTurnOverride } from "./codexTaskPersistence.js";
import type { ICodexExecutionService } from "./codexExecutionService.js";
import {
  assertNoCodexBackendTransition,
  createCodexMigrationBridge,
  type CodexMigrationBridge,
} from "./codexMigrationBridge.js";
import { startCodexTurn } from "./codexTurnStart.js";
import { createCodexConversationV4Methods } from "./codexConversationV4.js";

const logger = createServiceLogger("codex-execution");

interface SubscriptionEntry {
  readonly subscriptionId: string;
  readonly taskId: string;
}

interface CodexExecutionServiceDeps {
  readonly bridge: CodexAppServerPort;
  readonly taskIndex: CodexTaskIndexPort;
  /** 宿主执行策略（approvalPolicy + sandbox），由 node.ts 按 env 解析，默认 safeInteractive。 */
  readonly policy: CodexExecutionPolicy;
  /** Task artifacts 注册面（宿主内部）；缺省时用户点名交付不生效（不报错）。 */
  readonly taskArtifacts?: ITaskArtifactRegistry;
  readonly now?: () => number;
}

export function createCodexExecutionService(deps: CodexExecutionServiceDeps): {
  service: ICodexExecutionService;
  migration: CodexMigrationBridge; // 宿主内部迁移桥，不经 RPC 暴露
  dispose(): void;
} {
  const now = deps.now ?? (() => Date.now());
  const runtimes = new Map<string, CodexTaskRuntime>();
  const subscriptions = new Map<string, SubscriptionEntry>();
  const frames = new Emitter<ConversationTopicFrame>();

  function emitCommit(taskId: string, commit: CodexProjectionCommit): void {
    const runtime = runtimes.get(taskId);
    if (!runtime) return;
    for (const entry of subscriptions.values()) {
      if (entry.taskId !== taskId) continue;
      frames.fire(
        runtime.buildFrame({
          subscriptionId: entry.subscriptionId,
          payload: { kind: "deltas", deltas: commit.deltas },
          // 区间契约 (fromSeq, toSeq]：store 仅在 fromSeq === 当前水位时应用，
          // 否则视为断档进入 recovery。snapshot 帧固定 fromSeq=0。
          fromSeq: commit.seq - 1,
          toSeq: commit.seq,
        }),
      );
    }
  }

  function emitSnapshot(subscriptionId: string, taskId: string): void {
    const runtime = runtimes.get(taskId);
    if (!runtime || !subscriptions.has(subscriptionId)) return;
    const snapshot = runtime.projection.buildSnapshot(taskId, {
      modelId: runtime.codexModelId,
      effort: runtime.codexEffort,
    });
    frames.fire(
      runtime.buildFrame({
        subscriptionId,
        payload: { kind: "snapshot", snapshot },
        fromSeq: 0,
        toSeq: runtime.projection.seq,
      }),
    );
  }

  const persistenceContext = {
    taskIndex: deps.taskIndex,
    now,
    warn: (message: string) => logger.warn(undefined, message),
  };
  const persistStatus = (taskId: string, status: ZCodeTaskMeta["status"]): void => {
    const runtime = runtimes.get(taskId);
    if (runtime) persistCodexStatus(persistenceContext, runtime, status);
  };
  const persistTurnOverride = (runtime: CodexTaskRuntime, override: CodexModelOverride): void =>
    persistCodexTurnOverride(persistenceContext, runtime, override);

  const migration = createCodexMigrationBridge({
    bridge: deps.bridge,
    now,
    releaseTaskRuntime: (taskId) => runtimes.delete(taskId),
  });

  // ── bridge 通知扇入：按 threadId 路由到 runtime 并归约成帧 ──
  // 无主通知按 threadId 暂存、runtime 注册时回放：否则 thread/start 窗口期到达的
  // turn/completed 会被丢弃，投影永久停在 running（composer 永远“agent 正在工作”）。
  const notificationRouter = createCodexNotificationRouter({
    runtimes,
    emitCommit,
    onUnroutableServerRequest: (rawRequest) => {
      if (!rawRequest.method.includes("requestApproval")) return;
      // fail closed：无法定位 thread 的审批按 schema 真形回拒（权限类回空授权）。
      deps.bridge.respond(rawRequest.rawId, codexUnroutableApprovalResponse(rawRequest.method));
      logger.warn(
        undefined,
        `codex approval routed to no runtime; denied rawId=${rawRequest.rawId}`,
      );
    },
  });
  const offNotification = deps.bridge.onNotification((method, params, rawRequest) => {
    try {
      if (migration.handleNotification(method, params, rawRequest)) return; // handoff thread 归迁移收集器
      const routed = notificationRouter.handle(method, params, rawRequest);
      if (!routed) return;
      if (method === "turn/completed") {
        const runtime = runtimes.get(routed.taskId);
        if (!runtime) return;
        persistStatus(routed.taskId, runtime.projection.phase === "error" ? "error" : "completed");
        // 用户点名交付：turn 完成后旁路注册（不改 turn 语义，不阻塞通知扇入）。
        deliverCompletedTurnArtifacts({ registry: deps.taskArtifacts, runtime, emitCommit });
      }
    } catch (error) {
      logger.warn(undefined, `codex notification routing failed: ${String(error)}`);
    }
  });

  /** 确保 runtime 可用；失败路径绝不污染缓存，错误一律脱敏后再出通道。 */
  const ensureRuntime = async (taskId: string): Promise<CodexTaskRuntime> => {
    const runtime = await ensureRuntimeForTask({
      bridge: deps.bridge,
      taskIndex: deps.taskIndex,
      policy: deps.policy,
      taskArtifacts: deps.taskArtifacts,
      runtimes,
      taskId,
      now,
    });
    // 冷恢复/bridge 换代后回放该 thread 暂存的通知。
    notificationRouter.attachRuntime(runtime);
    return runtime;
  };

  const service: ICodexExecutionService = {
    async createTask(
      params: CodexExecutionCreateTaskParams,
    ): Promise<CodexExecutionCreateTaskResult> {
      if (!deps.bridge.installed) throw new Error("codex_not_installed");
      // allow-list 之外的 id 一律拒绝（fail loud），防止自由文本把任意值透传给 Codex。
      const override = resolveCodexModelOverride({
        modelId: params.modelId,
        effort: params.effort,
      });
      const thread = await startCodexThread(deps.bridge, {
        workspacePath: params.workspacePath,
        policy: deps.policy,
        ...(override.modelId ? { modelId: override.modelId } : {}),
      });
      const taskId = createUuid();
      const createdAt = now();
      const title =
        params.title?.trim() ||
        (params.firstInput?.trim().slice(0, 60) || "Codex task").replace(/\s+/g, " ");
      // meta 持久化的是 Codex 回报的实际生效读数（thread/start 响应），而不是请求值。
      const effectiveModelId = thread.model ?? override.modelId ?? null;
      const effectiveEffort = thread.effort ?? null;
      const meta: ZCodeTaskMeta = {
        taskId,
        traceId: `codex-${taskId}`,
        title,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        createdAt,
        updatedAt: createdAt,
        mode: "build",
        executionBackend: "codex",
        codexThreadId: thread.threadId,
        ...(effectiveModelId ? { codexModelId: effectiveModelId } : {}),
        ...(effectiveEffort ? { codexEffort: effectiveEffort } : {}),
      };
      const runtime = new CodexTaskRuntime(
        {
          taskId,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          codexThreadId: thread.threadId,
          bridgeGeneration: deps.bridge.generation,
          codexModelId: effectiveModelId,
          codexEffort: effectiveEffort,
        },
        now,
      );
      runtime.projection.setTitle(title);
      runtimes.set(taskId, runtime);
      notificationRouter.attachRuntime(runtime); // 回放 thread/start 窗口期先到的通知
      await deps.taskIndex.syncTaskMeta({ meta });
      if (params.firstInput?.trim())
        await service.sendTurn({
          taskId,
          content: params.firstInput,
          ...(override.effort ? { effort: override.effort } : {}),
        });
      return { task: toCodexTaskBinding(meta) };
    },

    async sendTurn(
      params: CodexExecutionSendTurnParams,
    ): Promise<{ accepted: boolean; commandId: string }> {
      await assertNoCodexBackendTransition(deps.taskIndex, params.taskId);
      const runtime = await ensureRuntime(params.taskId);
      // turn 级覆盖同样受 allow-list 约束；Codex schema：覆盖作用于本 turn 及后续 turns。
      const override = resolveCodexModelOverride({
        modelId: params.modelId,
        effort: params.effort,
      });
      return startCodexTurn({
        bridge: deps.bridge,
        runtime,
        params,
        override,
        emitCommit,
        persistTurnOverride,
        persistStatus: (taskId, status) => persistStatus(taskId, status),
      });
    },

    async respondApproval(params: CodexExecutionApprovalDecision): Promise<void> {
      const runtime = await ensureRuntime(params.taskId);
      const resolution = runtime.projection.resolveApproval(params.interactionId, params.decision);
      if (!resolution) throw new Error("codex_approval_unknown_interaction");
      // resolution.commit 含 pendingInteractions 收敛 + 锚点行 pendingApproval→running。
      emitCommit(params.taskId, resolution.commit);
      deps.bridge.respond(resolution.record.rawId, resolution.codexResponse);
    },

    async readTask(params: CodexExecutionReadTaskParams): Promise<CodexTaskThreadInfo | null> {
      const meta = await deps.taskIndex.getTaskMeta({
        taskId: params.taskId,
        ...(params.workspacePath !== undefined ? { workspacePath: params.workspacePath } : {}),
        ...(params.workspaceIdentity !== undefined
          ? { workspaceIdentity: params.workspaceIdentity }
          : {}),
      });
      if (!meta) return null;
      return {
        taskId: meta.taskId,
        codexThreadId: meta.codexThreadId ?? null,
        executionBackend: meta.executionBackend ?? "zcode",
      };
    },

    async listTasks(
      params: CodexExecutionListTasksParams = {},
    ): Promise<CodexExecutionListTasksResult> {
      const metas = await deps.taskIndex.listTaskMetas({
        ...(params.workspacePath !== undefined ? { workspacePath: params.workspacePath } : {}),
        ...(params.workspaceIdentity !== undefined
          ? { workspaceIdentity: params.workspaceIdentity }
          : {}),
      });
      return {
        tasks: metas.filter((meta) => meta.executionBackend === "codex").map(toCodexTaskBinding),
      };
    },

    async isCodexTask(params: { taskId: string; workspaceIdentity?: string }): Promise<boolean> {
      const runtime = runtimes.get(params.taskId);
      if (runtime && !runtime.isStale(deps.bridge)) return true;
      const meta = await deps.taskIndex.getTaskMeta({
        taskId: params.taskId,
        ...(params.workspaceIdentity !== undefined
          ? { workspaceIdentity: params.workspaceIdentity }
          : {}),
      });
      return meta?.executionBackend === "codex";
    },

    ...createCodexConversationV4Methods({
      bridge: deps.bridge,
      taskIndex: deps.taskIndex,
      subscriptions,
      ensureRuntime,
      emitSnapshot,
      emitCommit,
      now,
      sendTurn: (params) => service.sendTurn(params),
    }),

    onDynamicConversationFrame() {
      return frames.event;
    },
  };

  function dispose(): void {
    offNotification();
    migration.dispose();
    runtimes.clear();
    subscriptions.clear();
    frames.dispose();
  }

  return { service, migration, dispose };
}
