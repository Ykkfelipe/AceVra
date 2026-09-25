// Codex v4 conversation 适配（app）：subscribe/resync/unsubscribe/rowsRange/command。
//
// 抽出成独立模块：ICodexExecutionService 的 v4 面向只做「把入参翻译成 runtime/bridge 调用」，
// 订阅表、快照投递与后端迁移发送栅栏都收在这里，避免把执行服务的分派面撑成第二个状态机。
// 初始 frame 由调用方的 activation barrier 保证在 ACK 之后投递。
import { createUuid } from "@zcode/shared";
import { parseConversationTopic } from "@zcode/shared/zcode-protocol-v4";
import type { CodexExecutionSendTurnParams } from "@zcode/shared";
import type {
  CommandAck,
  CommandEnvelope,
  ConversationResyncParams,
  SubscribeParams,
  V4ConversationResyncResult,
  V4ConversationRowsRangeParams,
  V4ConversationRowsRangeResult,
  V4ConversationSubscribeResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { CodexTaskIndexPort } from "./codexPorts.js";
import { rejectCodexSendDuringBackendTransition } from "./codexMigrationBridge.js";
import type { CodexTaskRuntime } from "./codexTaskRuntime.js";
import { handleConversationCommand } from "./codexConversationCommands.js";
import type { CodexAppServerPort } from "./codexPorts.js";
import type { CodexProjectionCommit } from "#src/codex/domain/codexProjection.js";

interface SubscriptionEntry {
  readonly subscriptionId: string;
  readonly taskId: string;
}

/** v4 适配所需的宿主面（由 createCodexExecutionService 提供）。 */
export interface CodexConversationV4Host {
  readonly bridge: CodexAppServerPort;
  readonly taskIndex: CodexTaskIndexPort;
  readonly subscriptions: Map<string, SubscriptionEntry>;
  ensureRuntime(taskId: string): Promise<CodexTaskRuntime>;
  emitSnapshot(subscriptionId: string, taskId: string): void;
  emitCommit(taskId: string, commit: CodexProjectionCommit): void;
  now(): number;
  sendTurn(params: CodexExecutionSendTurnParams): Promise<unknown>;
}

/** 构造 ICodexExecutionService 的 v4 conversation 方法组。 */
export function createCodexConversationV4Methods(host: CodexConversationV4Host): {
  subscribeConversationV4(params: SubscribeParams): Promise<V4ConversationSubscribeResult>;
  resyncConversationV4(params: ConversationResyncParams): Promise<V4ConversationResyncResult>;
  unsubscribeConversationV4(params: { subscriptionId: string }): Promise<void>;
  conversationRowsRangeV4(
    params: V4ConversationRowsRangeParams,
  ): Promise<V4ConversationRowsRangeResult>;
  sendConversationCommandV4(params: { envelope: CommandEnvelope }): Promise<CommandAck>;
} {
  return {
    async subscribeConversationV4(params: SubscribeParams): Promise<V4ConversationSubscribeResult> {
      const taskId = parseConversationTopic(params.topic);
      if (!taskId) throw new Error(`codex_unsupported_topic:${params.topic}`);
      const runtime = await host.ensureRuntime(taskId);
      const subscriptionId = createUuid();
      host.subscriptions.set(subscriptionId, { subscriptionId, taskId });
      // 行日志全量快照；不支持 resume 水位（不保留 delta 历史）。
      // initial frame 在 ACK 之后投递，由 transport 的 activation barrier 保证次序。
      queueMicrotask(() => host.emitSnapshot(subscriptionId, taskId));
      return {
        ack: { subscriptionId, mode: "snapshot", logEpoch: runtime.projection.logEpoch },
      };
    },

    async resyncConversationV4(
      params: ConversationResyncParams,
    ): Promise<V4ConversationResyncResult> {
      const entry = host.subscriptions.get(params.subscriptionId);
      if (!entry) throw new Error("codex_subscription_not_owned");
      const runtime = await host.ensureRuntime(entry.taskId);
      queueMicrotask(() => host.emitSnapshot(params.subscriptionId, entry.taskId));
      return {
        ack: {
          subscriptionId: params.subscriptionId,
          mode: "snapshot",
          logEpoch: runtime.projection.logEpoch,
        },
      };
    },

    async unsubscribeConversationV4(params: { subscriptionId: string }): Promise<void> {
      host.subscriptions.delete(params.subscriptionId);
    },

    async conversationRowsRangeV4(
      params: V4ConversationRowsRangeParams,
    ): Promise<V4ConversationRowsRangeResult> {
      const runtime = await host.ensureRuntime(params.sessionId);
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
      // 迁移进行中不接受新用户轮（Amendment 4「Normal turns during a migration」）。
      const transitionRejection =
        envelope.type === "sendText"
          ? await rejectCodexSendDuringBackendTransition({
              taskIndex: host.taskIndex,
              taskId,
              commandId: envelope.commandId,
            })
          : null;
      if (transitionRejection) return transitionRejection;
      const runtime = await host.ensureRuntime(taskId);
      return handleConversationCommand(
        {
          bridge: host.bridge,
          taskIndex: host.taskIndex,
          emitCommit: host.emitCommit,
          sendTurn: async ({ taskId: id, content, commandId, modelId, effort }) => {
            await host.sendTurn({
              taskId: id,
              content,
              ...(commandId ? { commandId } : {}),
              ...(modelId ? { modelId } : {}),
              ...(effort ? { effort } : {}),
            });
          },
          now: host.now,
        },
        taskId,
        runtime,
        envelope,
      );
    },
  };
}
