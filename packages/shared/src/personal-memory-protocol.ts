/**
 * Personal Bot 个人记忆上下文的反向 RPC 契约（CLI → host）。
 *
 * 边界（M2 Phase 2 设计，见 docs/specs/personal-bot.md §14）：
 * - 只传**已渲染**的有界上下文文本 + 最小诊断元数据；原始 PersonalMemoryRecord[] 永不跨界。
 * - 刻意不提供 maxRecords / maxBytes：条数与字节预算的唯一所有者是 Bot 模块
 *   （packages/services/src/bot/domain/memory.ts），调用方不得放宽。
 * - 空 text 表示“没有相关记忆”，调用方据此零注入，而不是注入一个空块。
 */
import { z } from "zod";

const idString = z.string().trim().min(1).max(128);

export const zcodePersonalMemoryContextParamsSchema = z
  .object({
    requestId: idString,
    /** 会话围栏与日志关联；host 只用它做归属与诊断，不用它选人。 */
    sessionId: idString,
    /** 当前轮的规范用户输入，与 capability / plugin reminder 使用同一份文本。 */
    query: z.string(),
    turnId: idString.optional(),
  })
  .strict();

export type ZCodePersonalMemoryContextParams = z.infer<
  typeof zcodePersonalMemoryContextParamsSchema
>;

export const zcodePersonalMemoryContextResultSchema = z
  .object({
    /** 已渲染的有界上下文；空串 = 无相关记忆。 */
    text: z.string(),
    /** 命中但未入选的记忆条数（诊断用；调用方可据此提示“还有更多”）。 */
    omittedCount: z.number().int().nonnegative(),
    /** text 的 UTF-8 字节数，便于验证预算在传输前后一致。 */
    byteLength: z.number().int().nonnegative(),
  })
  .strict();

export type ZCodePersonalMemoryContextResult = z.infer<
  typeof zcodePersonalMemoryContextResultSchema
>;
