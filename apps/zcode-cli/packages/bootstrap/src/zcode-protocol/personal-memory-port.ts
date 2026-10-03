// Personal Bot M2 Phase 2：personal_memory_context 的反向 RPC 适配器（CLI → host）。
//
// 与 execution-target-port 同一形态：每会话一个 port，经 context.requestClient 打到 host。
// 差别在失败语义——执行目标必须保真报错（fail closed），个人记忆是**增强**，
// 任何失败（旧 host -32601、传输失败、超时）都收敛为“本轮不注入”，绝不阻塞用户这一轮。
//
// 只搬运 host 渲染好的有界文本；CLI 侧不读取、不排序、不裁剪个人记忆，也不传预算参数。
import { randomUUID } from "node:crypto";
import type {
  PersonalMemoryContextPort,
  PersonalMemoryContextRequest,
  PersonalMemoryContextResult,
} from "@zcode/contracts";
import { zcodePersonalMemoryContextResultSchema, zcodeProtocolMethods } from "@zcode/shared";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";

/**
 * 记忆注入的等待上限。取值与 execution-target 的列表刷新同量级（亚秒级）：
 * 记忆检索是本地文件读取，正常情况下是毫秒级；宁可这一轮不注入，也不要让用户多等。
 */
const PERSONAL_MEMORY_CONTEXT_TIMEOUT_MS = 1_000;

export function createProtocolPersonalMemoryContextPort(
  context: ZCodeProtocolAgentServerContext,
  resolveOwnSession: () => ZCodeProtocolSessionRecord | undefined,
): PersonalMemoryContextPort {
  return {
    async requestContext(
      request: PersonalMemoryContextRequest,
    ): Promise<PersonalMemoryContextResult | null> {
      const record = resolveOwnSession();
      // 会话已关闭：没有可归属的 Bot 对话，不注入。
      if (!record) return null;
      try {
        const result = await context.requestClient(
          zcodeProtocolMethods.interactionPersonalMemoryContext,
          {
            requestId: randomUUID(),
            sessionId: record.app.sessionId,
            query: request.query,
            ...(request.turnId ? { turnId: request.turnId } : {}),
          },
          zcodePersonalMemoryContextResultSchema,
          { timeoutMs: PERSONAL_MEMORY_CONTEXT_TIMEOUT_MS },
        );
        // 空文本 = 没有相关记忆：返回 null，调用方零注入。
        if (result.text.trim().length === 0) return null;
        return {
          text: result.text,
          omittedCount: result.omittedCount,
          byteLength: result.byteLength,
        };
      } catch (error) {
        context.logger?.debug("personal memory context request failed", {
          error: error instanceof Error ? error.message : String(error),
          event: "personal_memory.context.request.failed",
          module: "bootstrap.zcode_protocol",
          sessionId: record.app.sessionId,
        });
        return null;
      }
    },
  };
}
