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
import type {
  CommandAck,
  CommandEnvelope,
  ConversationResyncParams,
  ConversationTopicFrame,
  SubscribeParams,
  V4ConversationResyncResult,
  V4ConversationRowsRangeParams,
  V4ConversationRowsRangeResult,
  V4ConversationSubscribeResult,
} from "@zcode/shared/zcode-protocol-v4";
import { parseConversationTopic } from "@zcode/shared/zcode-protocol-v4";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { CODEX_METHODS, scrubCodexErrorDetail } from "#src/codex/domain/codexWire.js";
import { codexUnroutableApprovalResponse } from "#src/codex/domain/codexApprovals.js";
import type { ITaskArtifactRegistry } from "#src/task-artifacts/contract.js";
import {
  deliverUserNamedCodexArtifacts,
  reanchorRegisteredArtifactsAfterRebuild,
} from "./codexDeliveryIntegration.js";
import { toCodexTaskBinding } from "#src/codex/domain/codexBinding.js";
import type { CodexExecutionPolicy } from "#src/codex/domain/codexPolicy.js";
import { CodexThreadProjection } from "#src/codex/domain/codexProjection.js";
import type { CodexProjectionCommit } from "#src/codex/domain/codexProjection.js";
import {
  CodexTaskRuntime,
  ensureRuntimeForTask,
  extractCodexTurnId,
  rebuildProjectionFromCodex,
  resumeCodexThread,
  routeCodexNotification,
  selectRuntimeForNotification,
  startCodexThread,
} from "./codexTaskRuntime.js";
import type { CodexAppServerPort, CodexTaskIndexPort } from "./codexPorts.js";
import type { ICodexExecutionService } from "./codexExecutionService.js";
import { handleConversationCommand } from "./codexConversationCommands.js";

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
    frames.fire(
      runtime.buildFrame({
        subscriptionId,
        payload: { kind: "snapshot", snapshot: runtime.projection.buildSnapshot(taskId) },
        fromSeq: 0,
        toSeq: runtime.projection.seq,
      }),
    );
  }

  function persistStatus(taskId: string, status: ZCodeTaskMeta["status"]): void {
    const runtime = runtimes.get(taskId);
    if (!runtime) return;
    void deps.taskIndex
      .updateTaskState({
        workspacePath: runtime.workspacePath,
        ...(runtime.workspaceIdentity ? { workspaceIdentity: runtime.workspaceIdentity } : {}),
        taskId,
        patch: { status, updatedAt: now() },
      })
      .catch((error) => logger.warn(undefined, `codex task status write failed: ${String(error)}`));
  }


  // ── bridge 通知扇入：按 threadId 路由到 runtime 并归约成帧 ──
  const offNotification = deps.bridge.onNotification((method, params, rawRequest) => {
    try {
      const record =
        typeof params === "object" && params !== null ? (params as Record<string, unknown>) : null;
      const threadId =
        typeof record?.threadId === "string"
          ? record.threadId
          : typeof record?.thread_id === "string"
            ? record.thread_id
            : null;
      const runtime = selectRuntimeForNotification([...runtimes.values()], threadId);
      const routed = runtime
        ? routeCodexNotification(runtime, method, params, rawRequest)
        : null;
      if (!routed) {
        // 审批类服务器请求必须可路由：无法定位 thread 的审批回 denied 并告警，
        // 绝不静默丢弃（那会让 turn 无 UI 可审批地挂死）。
        if (rawRequest && rawRequest.method.includes("requestApproval")) {
          // fail closed：无法定位 thread 的审批按 schema 真形回拒（权限类回空授权）。
          deps.bridge.respond(rawRequest.rawId, codexUnroutableApprovalResponse(rawRequest.method));
          logger.warn(undefined, `codex approval routed to no runtime; denied rawId=${rawRequest.rawId}`);
        }
        return;
      }
      emitCommit(runtime!.taskId, routed.commit);
      if (method === "turn/completed") {
        persistStatus(runtime!.taskId, runtime!.projection.phase === "error" ? "error" : "completed");
        // 用户点名交付：turn 完成后旁路注册（不改 turn 语义，不阻塞通知扇入）。
        const delivery = runtime!.projection.takeCompletedTurnDelivery();
        if (delivery && deps.taskArtifacts) {
          void deliverUserNamedCodexArtifacts({
            registry: deps.taskArtifacts,
            taskId: runtime!.taskId,
            workspacePath: runtime!.workspacePath,
            ...(runtime!.workspaceIdentity
              ? { workspaceIdentity: runtime!.workspaceIdentity }
              : {}),
            projection: runtime!.projection,
            delivery,
            emitCommit,
          }).catch((error) => {
            logger.warn(undefined, `codex artifact delivery failed: ${String(error)}`);
          });
        }
      }
    } catch (error) {
      logger.warn(undefined, `codex notification routing failed: ${String(error)}`);
    }
  });

  /** 确保 runtime 可用；失败路径绝不污染缓存，错误一律脱敏后再出通道。 */
  const ensureRuntime = (taskId: string): Promise<CodexTaskRuntime> =>
    ensureRuntimeForTask({
      bridge: deps.bridge,
      taskIndex: deps.taskIndex,
      policy: deps.policy,
      taskArtifacts: deps.taskArtifacts,
      runtimes,
      taskId,
      now,
    });

  const service: ICodexExecutionService = {
    async createTask(params: CodexExecutionCreateTaskParams): Promise<CodexExecutionCreateTaskResult> {
      if (!deps.bridge.installed) throw new Error("codex_not_installed");
      const codexThreadId = await startCodexThread(deps.bridge, {
        workspacePath: params.workspacePath,
        policy: deps.policy,
      });
      const taskId = createUuid();
      const createdAt = now();
      const title =
        params.title?.trim() ||
        (params.firstInput?.trim().slice(0, 60) || "Codex task").replace(/\s+/g, " ");
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
        codexThreadId,
      };
      const runtime = new CodexTaskRuntime(
        {
          taskId,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          codexThreadId,
          bridgeGeneration: deps.bridge.generation,
        },
        now,
      );
      runtime.projection.setTitle(title);
      runtimes.set(taskId, runtime);
      await deps.taskIndex.syncTaskMeta({ meta });
      if (params.firstInput?.trim()) {
        await service.sendTurn({ taskId, content: params.firstInput });
      }
      return { task: toCodexTaskBinding(meta) };
    },

    async sendTurn(params: CodexExecutionSendTurnParams): Promise<{ accepted: boolean; commandId: string }> {
      const runtime = await ensureRuntime(params.taskId);
      const commandId = params.commandId || createUuid();
      const turnId = `codex-turn-${++runtime.turnCounter}-${commandId.slice(0, 8)}`;
      const commit = runtime.projection.beginUserTurn({ text: params.content, turnId, commandId });
      emitCommit(params.taskId, commit);
      try {
        // turn/start 的 input 形状以 spec 的 E2E checklist 为准；文本项 {type:"text", text}。
        // 响应携带 {turn:{id}}（schema）：记下 Codex 侧 turn id 供 turn/interrupt 使用。
        const result = await deps.bridge.call(CODEX_METHODS.turnStart, {
          threadId: runtime.codexThreadId,
          input: [{ type: "text", text: params.content }],
        });
        runtime.codexTurnId = extractCodexTurnId(result);
      } catch (error) {
        // Codex 不会为这次 turn 发 turn/completed；投影必须本地收口成 failed，
        // 否则 UI 停在幽灵 running 轮上（canStop 永真）。
        const message = error instanceof Error ? error.message : String(error);
        emitCommit(params.taskId, runtime.projection.failActiveTurn("codex.turnStartFailed", message));
        persistStatus(params.taskId, "error");
        throw new Error(scrubCodexErrorDetail(`codex_turn_start_failed: ${message}`));
      }
      persistStatus(params.taskId, "running");
      return { accepted: true, commandId };
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

    async listTasks(params: CodexExecutionListTasksParams = {}): Promise<CodexExecutionListTasksResult> {
      const metas = await deps.taskIndex.listTaskMetas({
        ...(params.workspacePath !== undefined ? { workspacePath: params.workspacePath } : {}),
        ...(params.workspaceIdentity !== undefined
          ? { workspaceIdentity: params.workspaceIdentity }
          : {}),
      });
      return { tasks: metas.filter((meta) => meta.executionBackend === "codex").map(toCodexTaskBinding) };
    },

    async isCodexTask(taskId: string): Promise<boolean> {
      const runtime = runtimes.get(taskId);
      if (runtime && !runtime.isStale(deps.bridge)) return true;
      const meta = await deps.taskIndex.getTaskMeta({ taskId });
      return meta?.executionBackend === "codex";
    },

    async subscribeConversationV4(params: SubscribeParams): Promise<V4ConversationSubscribeResult> {
      const taskId = parseConversationTopic(params.topic);
      if (!taskId) throw new Error(`codex_unsupported_topic:${params.topic}`);
      const runtime = await ensureRuntime(taskId);
      const subscriptionId = createUuid();
      subscriptions.set(subscriptionId, { subscriptionId, taskId });
      // 行日志全量快照；不支持 resume 水位（不保留 delta 历史）。
      // initial frame 在 ACK 之后投递，由 transport 的 activation barrier 保证次序。
      queueMicrotask(() => emitSnapshot(subscriptionId, taskId));
      return {
        ack: { subscriptionId, mode: "snapshot", logEpoch: runtime.projection.logEpoch },
      };
    },

    async resyncConversationV4(params: ConversationResyncParams): Promise<V4ConversationResyncResult> {
      const entry = subscriptions.get(params.subscriptionId);
      if (!entry) throw new Error("codex_subscription_not_owned");
      const runtime = await ensureRuntime(entry.taskId);
      queueMicrotask(() => emitSnapshot(params.subscriptionId, entry.taskId));
      return {
        ack: { subscriptionId: params.subscriptionId, mode: "snapshot", logEpoch: runtime.projection.logEpoch },
      };
    },

    async unsubscribeConversationV4(params: { subscriptionId: string }): Promise<void> {
      subscriptions.delete(params.subscriptionId);
    },

    async conversationRowsRangeV4(params: V4ConversationRowsRangeParams): Promise<V4ConversationRowsRangeResult> {
      const runtime = await ensureRuntime(params.sessionId);
      const rows = runtime.projection.rowsRange({
        ...(params.beforeRowId !== undefined ? { beforeRowId: params.beforeRowId } : {}),
        limit: params.limit,
      });
      return {
        rows,
        atSeq: runtime.projection.seq,
        atRevision: runtime.projection.revision,
        atLogEpoch: runtime.projection.logEpoch,
        hasMore: rows.length > 0 && (rows[0]?.rowId ?? 1) > 1,
      };
    },

    async sendConversationCommandV4(params: { envelope: CommandEnvelope }): Promise<CommandAck> {
      const envelope = params.envelope;
      const taskId = envelope.sessionId;
      if (!taskId) {
        return {
          commandId: envelope.commandId,
          status: "rejected",
          revisionAtDecision: 0,
          reasonCode: "fault.command.unsupportedBackend",
          message: "Codex backend requires an existing task",
        };
      }
      const runtime = await ensureRuntime(taskId);
      return handleConversationCommand(
        {
          bridge: deps.bridge,
          taskIndex: deps.taskIndex,
          emitCommit,
          sendTurn: async ({ taskId: id, content, commandId }) => {
            await service.sendTurn({ taskId: id, content, ...(commandId ? { commandId } : {}) });
          },
          now,
        },
        taskId,
        runtime,
        envelope,
      );
    },

    onDynamicConversationFrame() {
      return frames.event;
    },
  };

  function dispose(): void {
    offNotification();
    runtimes.clear();
    subscriptions.clear();
    frames.dispose();
  }

  return { service, dispose };
}
