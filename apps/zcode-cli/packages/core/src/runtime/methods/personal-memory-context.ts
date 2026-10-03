// personal_memory_context 的 runtime 侧：把 host 已经渲染好的**有界**个人记忆注入本轮。
// 规范：docs/specs/personal-bot.md §14。
//
// 边界（不得放宽）：
// - CLI 不读取、不排序、不裁剪个人记忆。检索/评分/条数与字节预算的唯一所有者在 host 的
//   Bot 模块（packages/services/src/bot/domain/memory.ts）；这里只搬运渲染结果。
// - 门禁：只有 taskType === "personal_bot" 的会话才有这个机会；其它会话连 port 都不调用。
// - 失败 fail-open：记忆取不到绝不能挡住用户这一轮，异常只记 debug。
// - 不持久化、不落成用户可见内容：与 capability_context 一样走 model-only attachment，
//   每轮重算，热会话内按正文去重。
import type { TraceContext } from "@zcode/contracts";
import { traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

const PERSONAL_MEMORY_CONTEXT_SOURCE = "personal_memory_context";

function alreadyInHistory(runtime: AgentRuntimeInternal, body: string): boolean {
  // 热会话里同一份记忆上下文已在历史中：不重复追加，避免每轮堆积。
  return runtime.messageHistory
    .borrowReadOnlyRuntimeEntries()
    .some((entry) => "kind" in entry && entry.kind === "attachment" && entry.content === body);
}

export async function injectPersonalMemoryContextFromTurn(
  runtime: AgentRuntimeInternal,
  input: { userInput: string; traceContext: TraceContext },
): Promise<void> {
  // 门禁必须在最前面：非 Bot 会话不产生任何 host 往返，也不可能注入记忆。
  if (runtime.config.taskType !== "personal_bot") return;
  const port = runtime.personalMemoryPort;
  if (!port) return;

  const startedAt = Date.now();
  try {
    const result = await port.requestContext({
      query: input.userInput,
      ...(input.traceContext.turnId ? { turnId: String(input.traceContext.turnId) } : {}),
    });
    // 空上下文 = 没有相关记忆：零注入，而不是注入一个空块。
    const body = result?.text.trim();
    if (!body) return;
    if (alreadyInHistory(runtime, body)) return;

    runtime.messageHistory.addAttachment(PERSONAL_MEMORY_CONTEXT_SOURCE, body);
    runtime.logger?.debug("Personal memory context injected", {
      ...traceContextToLogContext(input.traceContext),
      byteLength: result?.byteLength ?? 0,
      durationMs: Date.now() - startedAt,
      event: "personal_memory.context.injected",
      module: "core.runtime",
      omittedCount: result?.omittedCount ?? 0,
    });
  } catch (error) {
    // fail-open：记忆是增强，不是前置条件。异常绝不能阻止本轮模型请求。
    runtime.logger?.debug("Personal memory context injection failed", {
      ...traceContextToLogContext(input.traceContext),
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      event: "personal_memory.context.failed",
      module: "core.runtime",
    });
  }
}
