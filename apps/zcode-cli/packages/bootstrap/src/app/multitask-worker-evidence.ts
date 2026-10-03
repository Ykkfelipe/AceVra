// ============================================================
// Multitask worker 证据：driver 是 `evidence` 的唯一写入者
// ============================================================
// 原因：M1 实测中写 worker 在没有工具可用时只说一句开场白就结束 turn，run 依然显示 2/2 完成——
// 「turn 结束」被当成了「任务完成」。M2 让每个 Multitask 任务成为 typed ask，worker 必须显式
// 声明 status；而能证明它真的动过手的只能是运行时观察到的工具调用，不能是模型自述。
//
// 所以在 submit_result 载荷交给引擎之前，driver 用本 ask 观察到的计数**覆盖** `evidence`：
// 模型自己填的 evidence 一律丢弃。被接受的载荷就是 journal 里的节点结果，因此证据随节点落库、
// resume 时原样重放。普通 Workflow 的 persona 没有 worker 策略，永不加盖。

import type { PersonaSpec } from "@zcode/dynamic-workflow";
import type { ActorToolCounts } from "./workflow-driver-tool-activity.js";
import type { SessionState } from "./workflow-driver-types.js";

/** 这个 actor 是否 Multitask worker（persona 上有冻结的 worker 策略）。 */
export function isMultitaskWorkerPersona(persona: PersonaSpec): boolean {
  return persona.worker !== undefined;
}

/**
 * 把运行时观察到的计数盖到 worker 提交的结果上。非对象载荷原样返回：它反正过不了 schema，
 * 由引擎的 repair 通道照常拒绝，这里不替模型修形状。
 */
export function stampMultitaskEvidence(payload: unknown, counts: ActorToolCounts): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
  return {
    ...(payload as Record<string, unknown>),
    evidence: {
      toolCalls: counts.toolCalls,
      worldToolCalls: counts.worldToolCalls,
      mutatingToolCalls: counts.mutatingToolCalls,
      commandCalls: counts.commandCalls,
      filesChanged: [...counts.filesChanged],
    },
  };
}

/** submit 桥接交给引擎的载荷：Multitask worker 盖上本 ask 的证据，其余原样。 */
export function multitaskSubmission(
  state: Pick<SessionState, "multitaskWorker" | "modelActivity">,
  payload: unknown,
): unknown {
  return state.multitaskWorker
    ? stampMultitaskEvidence(payload, state.modelActivity.toolCounts())
    : payload;
}
