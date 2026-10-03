import type { HandoffPacket } from "./handoff-packet.js";
import type { HandoffObjectRef } from "./modes.js";

/**
 * M2 集成点（隔离契约）：cross-mode 只依赖这些端口，永远不 import Bot / Multitask / UI 的实现。
 * 在兄弟分支稳定之前，端口只有类型与测试用假实现；真正的接线发生在后续里程碑。
 */

/** 准入后交给执行方的请求：packet 从冻结快照重新解析并通过准入校验，是只读值。 */
export interface HandoffExecutionRequest {
  readonly packet: HandoffPacket;
  readonly confirmedAt: number;
}

export type HandoffExecutionOutcome =
  | {
      /** 目的侧工作已创建（coding session / multitask run 等）。 */
      readonly status: "accepted";
      /** 目的侧工作的稳定引用，用于回链与状态卡。 */
      readonly externalRef: HandoffObjectRef;
      readonly displayName?: string;
    }
  | {
      /** 执行方拒绝（例如目的不可用、被策略拦截）；理由必须是可展示的短文本。 */
      readonly status: "rejected";
      readonly reason: string;
    };

/**
 * 执行端口：由后续的 admission / 协调方实现（Desktop 服务、CLI 或跨模式接线工作）。
 * cross-mode 只负责校验、记录与调用；目的侧工作的创建与生命周期由实现方拥有。
 * 实现方不得把未校验的内容带回流程层（只能返回 externalRef / reason）。
 */
export interface HandoffExecutionPort {
  execute(request: HandoffExecutionRequest): Promise<HandoffExecutionOutcome>;
}
