// Personal Bot M2 Phase 2：个人记忆上下文反向请求（interaction/personalMemoryContext）的 host 侧中继。
//
// 与 execution-target RPC 同一约束：resolver 经 Promise 边界调用，同步抛错也归一为结构化结果，
// 绝不同步抛进 stdio 分发器（否则会被误判为协议解析错误并关闭整个 agent 连接）。
//
// 失败语义与执行目标相反：个人记忆是**增强**。resolver 缺失（旧 host 装配）或抛错时返回空文本，
// 让 CLI 侧零注入并继续本轮，而不是把一次记忆检索失败升级成用户可见的会话失败。
//
// 隐私边界：中继只搬运 Bot 模块已渲染好的有界文本；host 不在这里读取原始记忆记录，
// 也不接受调用方传入的预算参数（协议 schema 里根本没有这些字段）。
import { zcodePersonalMemoryContextParamsSchema, type ZCodeProtocolRequestId } from "@zcode/shared";

/** Bot 模块提供的渲染器：返回已渲染且已受条数/字节预算约束的文本。 */
export type PersonalMemoryContextResolver = (request: {
  sessionId: string;
  query: string;
  turnId?: string;
}) => Promise<{ text: string; omittedCount: number; byteLength: number }>;

interface PersonalMemoryRpcResponder {
  respond(id: ZCodeProtocolRequestId, result: unknown): Promise<void>;
  respondError(
    id: ZCodeProtocolRequestId,
    error: { code: number; message: string; data?: unknown },
  ): Promise<void>;
}

const EMPTY_PERSONAL_MEMORY_CONTEXT = { text: "", omittedCount: 0, byteLength: 0 } as const;

/**
 * 在协议边界上重新投影一次响应，只留三个字段。
 *
 * 这是“原始记忆记录不跨界”的结构性保证：即便 resolver 顺手把带 `selected`（原始
 * PersonalMemoryRecord[]）的整个上下文对象返回回来，出站载荷也不会带上它。
 * CLI 侧的结果 schema 是 strict 的，多余字段会让整次注入失败——所以这里必须自己收口，
 * 而不是指望上游恰好只传三个字段。
 */
function projectResponse(result: {
  text?: unknown;
  omittedCount?: unknown;
  byteLength?: unknown;
}): { text: string; omittedCount: number; byteLength: number } {
  return {
    text: typeof result.text === "string" ? result.text : "",
    omittedCount:
      typeof result.omittedCount === "number" && Number.isFinite(result.omittedCount)
        ? Math.max(0, Math.trunc(result.omittedCount))
        : 0,
    byteLength:
      typeof result.byteLength === "number" && Number.isFinite(result.byteLength)
        ? Math.max(0, Math.trunc(result.byteLength))
        : 0,
  };
}

export function handlePersonalMemoryContextRequest(context: {
  client: PersonalMemoryRpcResponder;
  resolver: PersonalMemoryContextResolver | undefined;
  requestId: ZCodeProtocolRequestId;
  params: unknown;
}): void {
  const { client, resolver, requestId } = context;
  const parsed = zcodePersonalMemoryContextParamsSchema.safeParse(context.params);
  if (!parsed.success) {
    void client.respondError(requestId, {
      code: -32602,
      message: "Invalid interaction/personalMemoryContext params",
      data: parsed.error.flatten(),
    });
    return;
  }
  if (!resolver) {
    // 宿主没有 Bot 服务：如实回答“没有记忆”。记忆缺失不是协议错误，不该报错。
    void client.respond(requestId, EMPTY_PERSONAL_MEMORY_CONTEXT);
    return;
  }
  const request = parsed.data;
  void Promise.resolve()
    .then(() =>
      resolver({
        sessionId: request.sessionId,
        query: request.query,
        ...(request.turnId ? { turnId: request.turnId } : {}),
      }),
    )
    .then((result) => client.respond(requestId, projectResponse(result)))
    .catch(() => {
      // fail-open：取不到记忆就是没有记忆。
      void client.respond(requestId, EMPTY_PERSONAL_MEMORY_CONTEXT);
    });
}
