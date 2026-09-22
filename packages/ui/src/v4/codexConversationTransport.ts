// Codex 执行后端的 v4 conversation 传输面（ConversationTransport 实现）。
// 桥到 ICodexExecutionService 的 v4 子集（subscribe/resync/unsubscribe/rowsRange/command/frame），
// 帧是标准 ConversationTopicFrame，SessionDataLayer / ConversationProjectionStore 零感知。
//
// 与 agentConversationTransport 的差异：Codex 帧是 host 上构造好的逻辑帧，不需要
// wire assembler；但 ACK 与 initial 帧的次序约定保持一致——store 在写入 subscriptionId
// 后才 activate，activate 前到达的帧缓冲，activate 后的第一帧必须标 "initial"
// （否则 store 视为断档进入 recovery）。host 在 ACK 之后才投递 initial，但 RPC 响应与
// 通知帧可能乱序到达，因此 activate 前的帧按 topic 预缓冲。
import type {
  CommandAck,
  CommandEnvelope,
  CommandsQueryParams,
  CommandsQueryResult,
  ConversationResyncParams,
  ConversationTopicFrame,
  SubscribeParams,
  TopicFrameDeliveryKind,
  V4ConversationPlansParams,
  V4ConversationPlansResult,
  V4ConversationResyncResult,
  V4ConversationRowsRangeParams,
  V4ConversationRowsRangeResult,
  V4ConversationSubscribeResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { ICodexExecutionService } from "@zcode/services";
import type { ConversationTransport } from "@/v4/transport.js";
import type { AttachmentUploadOptions } from "@/v4/attachmentUploadTransaction.js";

/** codex 后端不支持的能力统一抛这个 fault 前缀，UI 呈现为能力缺失而非崩溃。 */
const CODEX_BACKEND_UNSUPPORTED = "fault.codex.backendUnsupported";

type CodexConversationServiceSubset = Pick<
  ICodexExecutionService,
  | "subscribeConversationV4"
  | "resyncConversationV4"
  | "unsubscribeConversationV4"
  | "conversationRowsRangeV4"
  | "sendConversationCommandV4"
  | "onDynamicConversationFrame"
>;

interface SubscriptionGate {
  /** store 已 activate；此前到达的帧留在 buffered。 */
  activated: boolean;
  buffered: ConversationTopicFrame[];
  /** 已投递帧数；第一帧标 "initial"。 */
  delivered: number;
  /** resync ACK 已返回、等待对应 snapshot（标 "recovery"）。 */
  resyncAwaiting: boolean;
}

export function createCodexConversationTransport(
  codexService: CodexConversationServiceSubset,
): ConversationTransport {
  const listeners = new Set<
    (frame: ConversationTopicFrame, context?: { deliveryKind: TopicFrameDeliveryKind }) => void
  >();
  const gates = new Map<string, SubscriptionGate>();
  /** ACK 未返回时到达的帧按 topic 暂存；ACK 后并入对应 gate。 */
  const pendingByTopic = new Map<string, ConversationTopicFrame[]>();
  let upstream: { dispose(): void } | null = null;

  function deliver(frame: ConversationTopicFrame): void {
    const gate = gates.get(frame.subscriptionId);
    const context: { deliveryKind: TopicFrameDeliveryKind } =
      gate && gate.delivered === 0
        ? { deliveryKind: "initial" }
        : gate?.resyncAwaiting && frame.payload.kind === "snapshot"
          ? { deliveryKind: "recovery" }
          : { deliveryKind: "online" };
    if (gate) {
      if (context.deliveryKind === "recovery") gate.resyncAwaiting = false;
      gate.delivered += 1;
    }
    for (const listener of listeners) listener(frame, context);
  }

  function accept(frame: ConversationTopicFrame): void {
    const gate = gates.get(frame.subscriptionId);
    if (!gate) {
      // ACK 未返回：按 topic 预缓冲；ack 时只保留属于新订阅的帧，
      // 旧订阅的在途帧（subscriptionId 不符）由此丢弃，避免污染新 gate 的 initial 判定。
      const pending = pendingByTopic.get(frame.topic) ?? [];
      if (pending.length < 64) pending.push(frame);
      pendingByTopic.set(frame.topic, pending);
      return;
    }
    if (!gate.activated) {
      gate.buffered.push(frame);
      return;
    }
    deliver(frame);
  }

  return {
    async subscribe(params: SubscribeParams): Promise<V4ConversationSubscribeResult> {
      const result = await codexService.subscribeConversationV4(params);
      const gate: SubscriptionGate = {
        activated: false,
        buffered: (pendingByTopic.get(params.topic) ?? []).filter(
          (frame) => frame.subscriptionId === result.ack.subscriptionId,
        ),
        delivered: 0,
        resyncAwaiting: false,
      };
      // 预缓冲只服务本次订阅；无论是否命中都清掉，防止 stale 帧无限累积。
      pendingByTopic.delete(params.topic);
      gates.set(result.ack.subscriptionId, gate);
      return result;
    },
    activate(subscriptionId: string): void {
      const gate = gates.get(subscriptionId);
      if (!gate) return;
      gate.activated = true;
      const buffered = gate.buffered;
      gate.buffered = [];
      for (const frame of buffered) deliver(frame);
    },
    async resync(params: ConversationResyncParams): Promise<V4ConversationResyncResult> {
      const gate = gates.get(params.subscriptionId);
      if (gate) gate.resyncAwaiting = true;
      return codexService.resyncConversationV4(params);
    },
    async unsubscribe(subscriptionId: string): Promise<void> {
      gates.delete(subscriptionId);
      await codexService.unsubscribeConversationV4({ subscriptionId });
    },
    sendCommand(envelope: CommandEnvelope): Promise<CommandAck> {
      return codexService.sendConversationCommandV4({ envelope });
    },
    async queryCommands(params: CommandsQueryParams): Promise<CommandsQueryResult> {
      // Codex 后端不保留跨进程命令账本；unknown 让 renderer 静默清账，
      // 失败可见性由 transport error 与投影 watchdog 承担。
      return {
        results: params.commands.map((key) => ({ key, result: "unknown" as const })),
      };
    },
    async rowsRange(params: V4ConversationRowsRangeParams): Promise<V4ConversationRowsRangeResult> {
      return codexService.conversationRowsRangeV4(params);
    },
    async plans(_params: V4ConversationPlansParams): Promise<V4ConversationPlansResult> {
      return { plans: [], atSeq: 0, atLogEpoch: "codex" };
    },
    workflowRunEvents: notSupported(),
    workflowRuns: notSupported(),
    workflowRunArtifacts: notSupported(),
    workflowRunArtifactData: notSupported(),
    workflowRunArtifactRead: notSupported(),
    workflowRunWorkspace: notSupported(),
    workflowRunNodeResult: notSupported(),
    fileChanges: notSupported(),
    fileRewindPreview: notSupported(),
    attachmentPut(
      _params: Parameters<ConversationTransport["attachmentPut"]>[0],
      _options?: AttachmentUploadOptions,
    ): ReturnType<ConversationTransport["attachmentPut"]> {
      throw new Error(CODEX_BACKEND_UNSUPPORTED);
    },
    attachmentRead(): Promise<{ bytes: Uint8Array; mediaType: string }> {
      throw new Error(CODEX_BACKEND_UNSUPPORTED);
    },
    attachmentReadRange(): Promise<{
      bytes: Uint8Array;
      mediaType: string;
      totalBytes: number;
      nextOffset: number | null;
    }> {
      throw new Error(CODEX_BACKEND_UNSUPPORTED);
    },
    onFrame(
      listener: (
        frame: ConversationTopicFrame,
        context?: { deliveryKind: TopicFrameDeliveryKind },
      ) => void,
    ): () => void {
      listeners.add(listener);
      if (!upstream) {
        upstream = codexService.onDynamicConversationFrame({})((frame) => accept(frame));
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          upstream?.dispose();
          upstream = null;
        }
      };
    },
    onAssemblyFault(): () => void {
      // 逻辑帧直投，无 physical assembly，不会产生 assembly fault。
      return () => {};
    },
    onRuntimeRestart(_listener: (reason?: "runtimeRestart" | "transportReplaced") => void): () => void {
      // Codex 桥换代经由 ensureRuntime 重建 + logEpoch 更换（快照重放）恢复，不发 restart。
      return () => {};
    },
  };
}

function notSupported(): () => never {
  return () => {
    throw new Error(CODEX_BACKEND_UNSUPPORTED);
  };
}
