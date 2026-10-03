import {
  createHandoffReturnSummary,
  type CreateHandoffReturnSummaryInput,
  type HandoffPacket,
  type HandoffReturnSummary,
} from "@zcode/shared/cross-mode";

// Multitask → Coding 返回：把一次 Multitask 运行的结果映射成冻结的 HandoffReturnSummary。
// status 语义（completed / partial / failed / cancelled）原样透传：partial 不得伪装完成，
// 未完结事项放进 unresolved / blockers，而不是改写成 completed。

/** 调用方（协调方/执行器）提供的项目级结果；handoffId 由 packet 提供，不在调用方输入中。 */
export type MultitaskHandoffRunOutcome = Omit<CreateHandoffReturnSummaryInput, "handoffId">;

/**
 * returnPolicy 映射：
 * - "none"：不做自动回流，返回 null；
 * - "summary"：只回摘要，artifacts 被丢弃；
 * - "summary-and-artifacts"：保留 artifacts。
 */
export function buildMultitaskHandoffReturn(
  packet: HandoffPacket,
  outcome: MultitaskHandoffRunOutcome,
): HandoffReturnSummary | null {
  if (packet.returnPolicy === "none") {
    return null;
  }
  const includeArtifacts = packet.returnPolicy === "summary-and-artifacts";
  return createHandoffReturnSummary({
    ...outcome,
    handoffId: packet.handoffId,
    artifacts: includeArtifacts ? outcome.artifacts : undefined,
  });
}
