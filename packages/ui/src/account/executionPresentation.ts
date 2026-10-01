import type { AccountDevice, TaskEvent, TaskState } from "@zcode/shared";

export const ACTIVE_TASK_STATES: readonly TaskState[] = [
  "queued",
  "dispatching",
  "running",
  "running_unknown",
  "cancelling",
];

export type TaskStatusId =
  | "queued"
  | "starting"
  | "running"
  | "connectionLost"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled"
  | "cancelledUnconfirmed"
  | "unknown";

export interface TaskStatusView {
  id: TaskStatusId;
  active: boolean;
  exitCode?: number;
}

const STATE_STATUS: Record<TaskState, TaskStatusId> = {
  queued: "queued",
  dispatching: "starting",
  running: "running",
  running_unknown: "connectionLost",
  cancelling: "stopping",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

/** Status comes from the real task state; terminal detail only from terminal TaskEvents. */
export function resolveTaskStatus(
  state: TaskState | null,
  events: readonly TaskEvent[],
): TaskStatusView {
  if (!state) return { id: "unknown", active: false };
  const active = ACTIVE_TASK_STATES.includes(state);
  if (state === "cancelled") {
    const cancelled = events.findLast((e) => e.type === "task.cancelled");
    return {
      id: cancelled?.payload.acknowledged === false ? "cancelledUnconfirmed" : "cancelled",
      active,
    };
  }
  const view: TaskStatusView = { id: STATE_STATUS[state], active };
  if (state === "completed" || state === "failed") {
    const terminal = events.findLast(
      (e) => e.type === "process.completed" || e.type === "process.failed",
    );
    if (typeof terminal?.payload.exitCode === "number") view.exitCode = terminal.payload.exitCode;
  }
  return view;
}

export interface TaskLiveLine {
  key: string;
  text: string;
  stream: "stdout" | "stderr" | "progress";
}

const MAX_LIVE_LINES = 3;

/**
 * Latest output/progress lines only, derived from TaskEvents. Lifecycle events (created,
 * assigned, started…) carry no user text and the command line is never surfaced.
 */
export function appendTaskEvents(
  previous: readonly TaskLiveLine[],
  events: readonly TaskEvent[],
  lastSequence = previous.length > 0 ? Number(previous.at(-1)!.key.split(":")[0]) : 0,
): TaskLiveLine[] {
  const next = [...previous];
  let cursor = lastSequence;
  for (const event of events) {
    if (event.sequence <= cursor) continue;
    cursor = event.sequence;
    if (event.type === "process.output") {
      const stream = event.payload.stream === "stderr" ? "stderr" : "stdout";
      String(event.payload.text ?? "")
        .split(/\r?\n/)
        .forEach((text, index) => {
          if (text.trim()) next.push({ key: `${event.sequence}:${index}`, text, stream });
        });
    } else if (event.type === "process.progress" && event.payload.message) {
      next.push({
        key: `${event.sequence}:0`,
        text: String(event.payload.message),
        stream: "progress",
      });
    }
  }
  return next.slice(-MAX_LIVE_LINES);
}

export type DeviceRole = "thisDevice" | "node" | "otherDesktop";

export function describeDeviceRole(device: AccountDevice, thisDeviceId: string | null): DeviceRole {
  if (device.id === thisDeviceId) return "thisDevice";
  return device.type === "node" ? "node" : "otherDesktop";
}
