/**
 * Cross-Mode 采用点（仅限已发布契约层）：把 Bot 对话外壳投影成跨模式可引用的对象引用。
 *
 * 契约来源：`@zcode/shared/cross-mode` 的冻结快照（v1），本模块只消费它，不重新定义、
 * 不放宽它的校验。Bot 侧不创建任何 handoff 准入记录，也不实现 HandoffExecutionPort——
 * 目的侧工作（session / run）的创建属于 Cross-Mode 的执行方里程碑。
 *
 * 隐私边界：本投影只暴露“哪个会话”这个不透明 id。个人记忆绝不进入任何 handoff 上下文——
 * 冻结契约要求 personal/sensitive 上下文项默认排除并由用户显式勾选，自动携带记忆会同时绕过
 * 该规则和 M1 §6.2 的有界检索边界。
 */
import { handoffObjectRefSchema, type HandoffObjectRef } from "@zcode/shared/cross-mode";
import type { BotConversationShell } from "./shell.js";

/**
 * Bot 对话在 Cross-Mode 对象图里的引用（`{ kind: "conversation", id }`）。
 *
 * 返回 null 表示**当前没有可引用的 Bot 对话**：要么还没开始过对话，要么指针不是合法的契约
 * 引用（会话 id 不满足冻结契约的字符集/长度）。调用方必须把 null 当作“不能引用”，
 * 不得自行拼装这个引用绕过校验。
 */
export function toBotConversationRef(
  shell: BotConversationShell | null | undefined,
): HandoffObjectRef | null {
  const sessionId = shell?.sessionId?.trim();
  if (!sessionId) return null;
  const parsed = handoffObjectRefSchema.safeParse({ kind: "conversation", id: sessionId });
  return parsed.success ? parsed.data : null;
}
