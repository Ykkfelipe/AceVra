import type { SubmissionExecutionTarget } from "@zcode/shared";
import type { V4SessionRecordView } from "../types.js";

/**
 * M2F：用户输入携带的 Run-on 选择写入会话 record（唯一写入口）。
 * 缺省 = 不改变（旧客户端/非桌面）；automatic = 清除（Bash 恢复本机）；target = 进程执行走该节点。
 */
export function applySubmittedExecutionTarget(
  record: V4SessionRecordView,
  submitted: SubmissionExecutionTarget | undefined,
): void {
  if (!submitted) return;
  if (submitted.kind === "automatic") {
    delete record.executionTarget;
    return;
  }
  record.executionTarget = {
    targetId: submitted.targetId,
    ...(submitted.displayName ? { displayName: submitted.displayName } : {}),
  };
}
