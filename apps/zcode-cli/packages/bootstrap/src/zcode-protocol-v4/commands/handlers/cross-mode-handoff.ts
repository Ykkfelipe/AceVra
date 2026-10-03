import {
  MULTITASK_HANDOFF_START_REJECTED_FAULT_PREFIX,
  type CommandEnvelope,
  type CommandPayloadMap,
  type CommandResult,
  type MultitaskHandoffStartRejectionReason,
} from "@zcode/shared/zcode-protocol-v4";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
import { V4CapabilityUnsupportedError } from "./interaction-background.js";

// 跨模式交接命令组（生产 handoff executor 里程碑）：startMultitaskHandoff。
// - 能力缺席（宿主 App 未接 startMultitaskHandoff）→ V4CapabilityUnsupportedError（与
//   savedWorkflowStart / resumeWorkflowRun 家族同一条语义），客户端原样显示「当前 agent 不支持」。
// - 业务拒绝（invalid_input / session_busy / start_failed）以
//   `fault.command.multitaskHandoffStartRejected.<reason>` 的 reasonCode 回 ACK；`message` 携带
//   人可读诊断（冻结契约校验摘要等）。网关对携带 reasonCode 的领域错误原样上行，UI 按词表分流——
//   不用错误文本做流程判断。
// - 成功以 `{ type: "startMultitaskHandoff", handoffId, status, externalRef, reason }` 回 ACK.result：
//   accepted 时 externalRef 即 Handoff 记录 ↔ Multitask run 的回链；rejected 携带可展示原因
//   （用户拒绝运行确认 / 目标不可用 / 权限不足），记录保持可重试语义。
//   注：本命令等待运行确认闸门裁决后才回 ACK——与 Multitask 工具调用同一条等待语义，
//   绝不静默绕过确认。

class V4MultitaskHandoffStartRejectedError extends Error {
  readonly reasonCode: string;
  constructor(reason: MultitaskHandoffStartRejectionReason, message?: string) {
    super(message ?? `multitask handoff start rejected: ${reason}`);
    this.name = "V4MultitaskHandoffStartRejectedError";
    this.reasonCode = `${MULTITASK_HANDOFF_START_REJECTED_FAULT_PREFIX}${reason}`;
  }
}

async function startMultitaskHandoff(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["startMultitaskHandoff"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.startMultitaskHandoff) {
    throw new V4CapabilityUnsupportedError("startMultitaskHandoff", record.app.sessionId);
  }
  // 注意：方法必须经 app 调用（不可解构，实现可能依赖 this 绑定）。
  const result = await record.app.startMultitaskHandoff({
    ...payload,
    sessionId: record.app.sessionId ?? envelope.sessionId ?? "unknown",
    plan: {
      ...payload.plan,
      tasks: payload.plan.tasks.map((task) => ({ ...task, dependsOn: task.dependsOn ?? [] })),
    },
  });
  if (!result.ok) {
    throw new V4MultitaskHandoffStartRejectedError(result.reason, result.message);
  }
  return {
    type: "startMultitaskHandoff",
    handoffId: result.handoffId,
    status: result.status,
    externalRef: result.externalRef,
    reason: result.reason,
  };
}

export const crossModeHandoffHandlers = {
  startMultitaskHandoff,
} as const;
