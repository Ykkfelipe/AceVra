// 按 session 的执行后端路由 v4 会话传输（ConversationTransport 组合器）。
// zcode topic → agentConversationTransport（zcode-cli runtime）；
// codex topic → codexConversationTransport（ICodexExecutionService）。
// 归属判定走异步 RPC（isCodexTask）并缓存；数据层与 store 不感知后端存在。
import type {
  CommandAck,
  CommandEnvelope,
  CommandsQueryParams,
  CommandsQueryResult,
  ConversationTopicFrame,
  SubscribeParams,
  TopicFrameDeliveryKind,
  V4ConversationPlansParams,
  V4ConversationPlansResult,
  V4ConversationResyncParams,
  V4ConversationResyncResult,
  V4ConversationRowsRangeParams,
  V4ConversationRowsRangeResult,
  V4ConversationSubscribeResult,
} from "@zcode/shared/zcode-protocol-v4";
import { parseConversationTopic } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTransport } from "@/v4/transport.js";

interface BackendRoutingOptions {
  /** zcode-cli runtime 传输（必须）。 */
  readonly agent: ConversationTransport;
  /** Codex 执行后端传输；旧 host 未注册时为 null，codex topic 落回 agent 报错。 */
  readonly codex: ConversationTransport | null;
  /** taskId → 是否 Codex 任务（RPC + 缓存）。 */
  readonly isCodexTask: (taskId: string) => Promise<boolean>;
}

export function createBackendRoutingConversationTransport(
  options: BackendRoutingOptions,
): ConversationTransport {
  const backendBySubscriptionId = new Map<string, ConversationTransport>();
  const cache = new Map<string, boolean>();

  async function isCodexSession(sessionId: string): Promise<boolean> {
    if (!options.codex) return false;
    const cached = cache.get(sessionId);
    if (cached !== undefined) return cached;
    // 只缓存成功判定的结果：瞬态 RPC 失败不缓存，下次路由重试（归属本身不可变，
    // 但连接抖动期间误判会把 Codex 任务永久钉在错误的后端上）。
    const result = await options.isCodexTask(sessionId).catch(() => undefined);
    if (result === undefined) return false;
    cache.set(sessionId, result);
    return result;
  }

  async function routeBySessionId(sessionId: string | null): Promise<ConversationTransport> {
    if (sessionId && (await isCodexSession(sessionId)) && options.codex) {
      return options.codex;
    }
    return options.agent;
  }

  return {
    async subscribe(params: SubscribeParams): Promise<V4ConversationSubscribeResult> {
      const sessionId = parseConversationTopic(params.topic);
      const backend = await routeBySessionId(sessionId);
      const result = await backend.subscribe(params);
      backendBySubscriptionId.set(result.ack.subscriptionId, backend);
      return result;
    },
    activate(subscriptionId: string): void {
      backendBySubscriptionId.get(subscriptionId)?.activate(subscriptionId);
    },
    async resync(params: V4ConversationResyncParams): Promise<V4ConversationResyncResult> {
      const backend =
        backendBySubscriptionId.get(params.subscriptionId) ?? (await routeBySessionId(null));
      return backend.resync(params);
    },
    async unsubscribe(subscriptionId: string): Promise<void> {
      const backend = backendBySubscriptionId.get(subscriptionId) ?? options.agent;
      backendBySubscriptionId.delete(subscriptionId);
      await backend.unsubscribe(subscriptionId);
    },
    async sendCommand(envelope: CommandEnvelope): Promise<CommandAck> {
      const backend = await routeBySessionId(envelope.sessionId);
      return backend.sendCommand(envelope);
    },
    async queryCommands(params: CommandsQueryParams): Promise<CommandsQueryResult> {
      // Codex 后端不保留跨进程命令账本；unknown 让 renderer 静默清账，
      // 失败可见性由 transport error 与投影 watchdog 承担。
      // 先全部置 unknown，再按归属拆分查询覆盖对应下标；结果顺序与请求一致。
      const results: CommandsQueryResult["results"] = params.commands.map((key) => ({
        key,
        result: "unknown" as const,
      }));
      const agentIndexes: number[] = [];
      const codexIndexes: number[] = [];
      await Promise.all(
        params.commands.map(async (key, index) => {
          if (key.sessionId && (await isCodexSession(key.sessionId))) {
            codexIndexes.push(index);
          } else {
            agentIndexes.push(index);
          }
        }),
      );
      const codexBackend = options.codex;
      const [agentResult, codexResult] = await Promise.all([
        agentIndexes.length
          ? options.agent.queryCommands({
              commands: agentIndexes.map((index) => params.commands[index]!),
            })
          : Promise.resolve(null),
        codexIndexes.length && codexBackend
          ? codexBackend.queryCommands({
              commands: codexIndexes.map((index) => params.commands[index]!),
            })
          : Promise.resolve(null),
      ]);
      agentResult?.results.forEach((result, position) => {
        results[agentIndexes[position]!] = result;
      });
      codexResult?.results.forEach((result, position) => {
        results[codexIndexes[position]!] = result;
      });
      return { results };
    },
    async rowsRange(params: V4ConversationRowsRangeParams): Promise<V4ConversationRowsRangeResult> {
      const backend = await routeBySessionId(params.sessionId);
      return backend.rowsRange(params);
    },
    plans(params: V4ConversationPlansParams): Promise<V4ConversationPlansResult> {
      return routeBySessionId(params.sessionId).then((backend) => backend.plans(params));
    },
    workflowRunEvents: (params) => routeTo(params.sessionId, (b) => b.workflowRunEvents(params)),
    workflowRuns: (params) => routeTo(params.sessionId, (b) => b.workflowRuns(params)),
    workflowRunArtifacts: (params) =>
      routeTo(params.sessionId, (b) => b.workflowRunArtifacts(params)),
    workflowRunArtifactData: (params) =>
      routeTo(params.sessionId, (b) => b.workflowRunArtifactData(params)),
    workflowRunArtifactRead: (params) =>
      routeTo(params.sessionId, (b) => b.workflowRunArtifactRead(params)),
    workflowRunWorkspace: (params) =>
      routeTo(params.sessionId, (b) => b.workflowRunWorkspace(params)),
    workflowRunNodeResult: (params) =>
      routeTo(params.sessionId, (b) => b.workflowRunNodeResult(params)),
    fileChanges: (params) => routeTo(params.sessionId, (b) => b.fileChanges(params)),
    fileRewindPreview: (params) => routeTo(params.sessionId, (b) => b.fileRewindPreview(params)),
    attachmentPut(params: Parameters<ConversationTransport["attachmentPut"]>[0], options?: Parameters<ConversationTransport["attachmentPut"]>[1]) {
      return routeBySessionId(params.sessionId).then((backend) =>
        backend.attachmentPut(params, options),
      );
    },
    attachmentRead(params: Parameters<ConversationTransport["attachmentRead"]>[0]) {
      return routeBySessionId(params.sessionId).then((backend) => backend.attachmentRead(params));
    },
    attachmentReadRange(params: Parameters<ConversationTransport["attachmentReadRange"]>[0]) {
      return routeBySessionId(params.sessionId).then((backend) =>
        backend.attachmentReadRange(params),
      );
    },
    onFrame(
      listener: (
        frame: ConversationTopicFrame,
        context?: { deliveryKind: TopicFrameDeliveryKind },
      ) => void,
    ): () => void {
      const offAgent = options.agent.onFrame(listener);
      const offCodex = options.codex?.onFrame(listener) ?? (() => {});
      return () => {
        offAgent();
        offCodex();
      };
    },
    onAssemblyFault(
      listener: Parameters<ConversationTransport["onAssemblyFault"]>[0],
    ): () => void {
      const offAgent = options.agent.onAssemblyFault(listener);
      const offCodex = options.codex?.onAssemblyFault(listener) ?? (() => {});
      return () => {
        offAgent();
        offCodex();
      };
    },
    onRuntimeRestart(
      listener: Parameters<ConversationTransport["onRuntimeRestart"]>[0],
    ): () => void {
      // Codex 侧不发 restart；zcode runtime 换代语义与现状一致。
      return options.agent.onRuntimeRestart(listener);
    },
    onRuntimeLifecycle(
      listener: Parameters<NonNullable<ConversationTransport["onRuntimeLifecycle"]>>[0],
    ): () => void {
      return options.agent.onRuntimeLifecycle?.(listener) ?? (() => {});
    },
  };

  /**
   * 按 sessionId 路由后执行；fileChanges / fileRewindPreview / workflow 系列共用。
   * 调用方以 lambda 携带方法调用，类型全部由实现推断。
   */
  function routeTo<TResult>(
    sessionId: string | null,
    invoke: (backend: ConversationTransport) => Promise<TResult> | TResult,
  ): Promise<TResult> {
    return routeBySessionId(sessionId).then((backend) => invoke(backend));
  }
}
