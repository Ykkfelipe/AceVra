// ============================================================
// Personal Memory Context Port - turn-time bounded personal memory (Personal Bot M2 Phase 2)
// ============================================================
// 每个 Bot 会话一个 port（bootstrap 注入，仅 personal_bot）。职责只有一个：把 host 已经
// 渲染好的**有界**个人记忆上下文取回来。
//
// 边界（不得放宽）：
// - CLI 侧不持有、不读取、不排序 PersonalMemoryRecord[]；检索/评分/预算的唯一所有者在
//   packages/services/src/bot/domain/memory.ts。
// - 接口不提供 maxRecords / maxBytes：预算参数不跨界，调用方无从放宽。
// - 失败 fail-open：无法取得上下文时返回 null，turn 继续，绝不因为记忆而挡住用户这一轮。

export interface PersonalMemoryContextRequest {
  /** 当前轮的规范用户输入（与 capability / plugin reminder 同一份文本）。 */
  query: string;
  /** 诊断与关联用；不参与检索决策。 */
  turnId?: string;
  toolCallId?: string;
}

export interface PersonalMemoryContextResult {
  /** 已渲染的有界上下文；空串表示没有相关记忆。 */
  text: string;
  /** 命中但未入选的条数（诊断用）。 */
  omittedCount: number;
  /** text 的 UTF-8 字节数。 */
  byteLength: number;
}

export interface PersonalMemoryContextPort {
  /**
   * 取回本轮要注入的个人记忆上下文。
   * 返回 null（或空 text）表示不注入；实现方必须把 host 不可用/超时收敛为 null 而不是抛出。
   */
  requestContext(
    request: PersonalMemoryContextRequest,
  ): Promise<PersonalMemoryContextResult | null>;
}
