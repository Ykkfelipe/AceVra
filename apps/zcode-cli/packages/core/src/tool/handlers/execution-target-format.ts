import type {
  ExecutionTargetFailure,
  ExecutionTaskEventRecord,
  ExecutionTaskSnapshot,
  TargetTaskResult,
} from "@zcode/contracts";

const OUTPUT_TAIL_CHARS = 16_000;

type FailureSubject = { targetId: string; targetName?: string; taskId?: string };

const label = (subject?: FailureSubject) =>
  subject?.targetName
    ? `"${subject.targetName}"`
    : subject?.targetId
      ? `target ${subject.targetId}`
      : "the target";

const NOTHING_LOCAL = "Nothing was run on this Mac instead.";

/** 失败原因 → 给模型的真实、可行动说明（不暗示可以改在本机执行）。 */
export function describeExecutionTargetFailure(
  result: ExecutionTargetFailure,
  subject?: FailureSubject,
): string {
  const who = label(subject);
  switch (result.reason) {
    case "not_signed_in":
      return `AceVra is not signed in to an account on this Mac, so other devices are unavailable. ${NOTHING_LOCAL} Ask the user to sign in (Settings → AceVra Account), or do the work on this Mac if they agree.`;
    case "unavailable":
      return `Running on other devices is unavailable right now (${result.detail ?? "host unavailable"}). ${NOTHING_LOCAL}`;
    case "target_not_found":
      return `${who} is not a paired device of this account. Call ExecutionTargets to see available targets. ${NOTHING_LOCAL}`;
    case "target_unavailable": {
      const why =
        result.detail === "target_offline"
          ? "is offline"
          : result.detail === "target_revoked"
            ? "has been revoked"
            : result.detail === "target_lacks_shell"
              ? "does not run commands (no shell service)"
              : result.detail === "target_not_node"
                ? "is not an AceVra Node; only Nodes run remote commands"
                : "cannot run tasks right now";
      return `${who} ${why}. ${NOTHING_LOCAL} Tell the user; do not retry elsewhere without asking.`;
    }
    case "target_is_local":
      return `${who} is this Mac. Use Bash for commands on this Mac.`;
    case "invalid_request":
      return result.detail === "workspace_mismatch"
        ? "This request does not belong to the current workspace."
        : "The request was rejected as invalid (check executable, args ≤64, cwd ≤512 chars, env ≤16, timeout 1–3600 s).";
    case "task_not_found":
    case "task_not_in_session":
      return `${subject?.taskId ? `Task ${subject.taskId}` : "That task"} was not started by this conversation (or no longer exists).`;
    case "timeout":
      return result.detail === "task_may_have_started"
        ? `Starting the task on ${who} timed out; it may have started. Check the task card before retrying.`
        : `Talking to ${who} timed out. The task, if any, keeps its last known state.`;
    case "computer_paused":
      return result.detail === "user_active" || result.detail === "physical_input"
        ? `The user is using ${who} right now, so you were paused. ${NOTHING_LOCAL} Wait for them to resume you in the Computer panel; do not retry in a loop.`
        : `${who} is paused or the user took control (${result.detail ?? "paused"}). ${NOTHING_LOCAL} Wait until the user gives control back; do not retry in a loop.`;
    case "computer_busy":
      return result.detail === "user_in_control"
        ? `The user is controlling ${who} from the Computer panel. ${NOTHING_LOCAL} Wait until they give it back.`
        : `${who} is busy with another job (${result.detail ?? "busy"}). ${NOTHING_LOCAL} Tell the user.`;
    case "computer_offline":
      return `${who} is offline or unreachable over SSH (${result.detail ?? "offline"}). ${NOTHING_LOCAL} Tell the user; do not do the work on this Mac instead.`;
    default:
      return `Running on ${who} failed (${result.reason}${result.detail ? `: ${result.detail}` : ""}). ${NOTHING_LOCAL}`;
  }
}

/** 只保留输出尾部；节点侧截断或本地丢弃都如实标记 outputTruncated。 */
export class TargetOutputTail {
  private text = "";
  private truncated = false;

  add(event: ExecutionTaskEventRecord): void {
    if (event.type === "process.truncated") {
      this.truncated = true;
      return;
    }
    if (event.type !== "process.output") return;
    const chunk = typeof event.payload.text === "string" ? event.payload.text : "";
    if (!chunk) return;
    const prefix = event.payload.stream === "stderr" ? "[stderr] " : "";
    this.text += prefix ? chunk.replace(/^(?=.)/gmu, prefix) : chunk;
    if (this.text.length > OUTPUT_TAIL_CHARS) {
      this.text = this.text.slice(-OUTPUT_TAIL_CHARS);
      this.truncated = true;
    }
  }

  toResult(
    ids: { taskId: string; targetId: string; targetName?: string },
    task: ExecutionTaskSnapshot,
    finished: boolean,
  ): TargetTaskResult {
    const result = task.result ?? {};
    const exitCode = typeof result.exitCode === "number" ? result.exitCode : undefined;
    const reason = typeof result.reason === "string" ? result.reason : undefined;
    const detail = typeof result.detail === "string" ? result.detail : undefined;
    if (typeof result.droppedBytes === "number" && result.droppedBytes > 0) this.truncated = true;
    return {
      taskId: ids.taskId,
      targetId: task.targetId || ids.targetId,
      ...(ids.targetName ? { targetName: ids.targetName } : {}),
      state: task.state,
      finished,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(reason ? { reason: detail ? `${reason} (${detail})` : reason } : {}),
      output: this.text,
      outputTruncated: this.truncated,
      message: describeState(task.state, finished, exitCode, result.timedOut === true),
    };
  }
}

function describeState(
  state: string,
  finished: boolean,
  exitCode: number | undefined,
  timedOut: boolean,
): string {
  if (state === "completed") return `Finished with exit code ${exitCode ?? 0}.`;
  if (state === "failed") {
    return timedOut
      ? "The process hit its timeout and was killed on the node."
      : `Failed${exitCode !== undefined ? ` with exit code ${exitCode}` : ""}.`;
  }
  if (state === "cancelled") return "The task was stopped.";
  if (state === "running_unknown") {
    return "The node lost its connection while running; the process may still be running. AceVra reconciles when the node reconnects. The user can see this on the task card.";
  }
  if (state === "cancelling") return "Stop requested; waiting for the node to confirm.";
  return finished
    ? `Task ended in state ${state}.`
    : `Still ${state === "running" ? "running" : state}. It keeps going on the node and the user sees live progress; call TargetTask to wait for it or stop it.`;
}
