/**
 * Typed node → server task messages. Strict: unknown keys, wrong types, oversize text and
 * unknown event types are all rejected. There is deliberately no generic command message.
 */
const ID = /^[A-Za-z0-9-]{8,64}$/;
export const MAX_OUTPUT_TEXT = 8192;
export const EVENT_TYPES = [
  "process.started",
  "process.output",
  "process.progress",
  "process.truncated",
] as const;
export type NodeEventType = (typeof EVENT_TYPES)[number];

export type TaskMessage =
  | { type: "task.accept"; taskId: string; attempt: number }
  | { type: "task.reject"; taskId: string; attempt: number; reason: string }
  | {
      type: "task.event";
      taskId: string;
      attempt: number;
      seq: number;
      event: NodeEventType;
      payload: Record<string, unknown>;
    }
  | { type: "task.complete"; taskId: string; attempt: number; seq: number; result: TaskResult }
  | {
      type: "task.fail";
      taskId: string;
      attempt: number;
      seq: number;
      reason: FailReason;
      result: TaskResult;
    }
  | { type: "task.sync"; active: { taskId: string; attempt: number }[] };

export const FAIL_REASONS = [
  "exit_nonzero",
  "timeout",
  "spawn_failed",
  "cancelled",
  "interrupted",
  "policy",
] as const;
export type FailReason = (typeof FAIL_REASONS)[number];
export interface TaskResult {
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  droppedBytes: number;
  timedOut: boolean;
  /** Short, sanitized human text (e.g. a spawn error message). */
  detail?: string;
}

const int = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const keysOk = (o: Record<string, unknown>, allowed: string[]) =>
  Object.keys(o).every((k) => allowed.includes(k));

function parseResult(raw: unknown): TaskResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!keysOk(r, ["exitCode", "signal", "durationMs", "droppedBytes", "timedOut", "detail"]))
    return null;
  const exitCode = r.exitCode === null || r.exitCode === undefined ? null : r.exitCode;
  if (exitCode !== null && !int(exitCode, -2147483648, 2147483647)) return null;
  const signal = r.signal === null || r.signal === undefined ? null : r.signal;
  if (signal !== null && (typeof signal !== "string" || signal.length > 16)) return null;
  if (!int(r.durationMs ?? 0, 0, 2 ** 31 - 1) || !int(r.droppedBytes ?? 0, 0, 2 ** 31 - 1))
    return null;
  const detail = r.detail;
  if (detail !== undefined && (typeof detail !== "string" || detail.length > 300)) return null;
  return {
    exitCode,
    signal,
    durationMs: (r.durationMs as number) ?? 0,
    droppedBytes: (r.droppedBytes as number) ?? 0,
    timedOut: r.timedOut === true,
    ...(detail !== undefined ? { detail } : {}),
  };
}

function parsePayload(event: NodeEventType, raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  switch (event) {
    case "process.output":
      if (!keysOk(p, ["stream", "text", "bytes"])) return null;
      if (
        (p.stream !== "stdout" && p.stream !== "stderr") ||
        typeof p.text !== "string" ||
        p.text.length > MAX_OUTPUT_TEXT
      )
        return null;
      if (!int(p.bytes, 0, 65536)) return null;
      return { stream: p.stream, text: p.text, bytes: p.bytes };
    case "process.progress":
      if (!keysOk(p, ["message"]) || typeof p.message !== "string" || p.message.length > 300)
        return null;
      return { message: p.message };
    case "process.started":
      if (!keysOk(p, ["pid"]) || (p.pid !== undefined && !int(p.pid, 0, 2 ** 31 - 1))) return null;
      return p.pid === undefined ? {} : { pid: p.pid };
    case "process.truncated":
      if (
        !keysOk(p, ["stream", "limitBytes"]) ||
        (p.stream !== "stdout" && p.stream !== "stderr" && p.stream !== "both") ||
        !int(p.limitBytes, 0, 2 ** 31 - 1)
      )
        return null;
      return { stream: p.stream, limitBytes: p.limitBytes };
  }
}

/** Returns the typed message, or null if it is not a valid task message. */
export function parseTaskMessage(message: Record<string, unknown>): TaskMessage | null {
  const type = message.type;
  if (type === "task.sync") {
    if (
      !keysOk(message, ["type", "active"]) ||
      !Array.isArray(message.active) ||
      message.active.length > 16
    )
      return null;
    const active = [];
    for (const item of message.active) {
      if (!item || typeof item !== "object") return null;
      const { taskId, attempt } = item as Record<string, unknown>;
      if (typeof taskId !== "string" || !ID.test(taskId) || !int(attempt, 0, 1000)) return null;
      active.push({ taskId, attempt });
    }
    return { type, active };
  }
  const taskId = message.taskId;
  const attempt = message.attempt;
  if (typeof taskId !== "string" || !ID.test(taskId) || !int(attempt, 0, 1000)) return null;
  if (type === "task.accept")
    return keysOk(message, ["type", "taskId", "attempt"]) ? { type, taskId, attempt } : null;
  if (type === "task.reject") {
    if (
      !keysOk(message, ["type", "taskId", "attempt", "reason"]) ||
      typeof message.reason !== "string" ||
      message.reason.length > 200
    )
      return null;
    return { type, taskId, attempt, reason: message.reason };
  }
  if (type === "task.event") {
    if (!keysOk(message, ["type", "taskId", "attempt", "seq", "event", "payload"])) return null;
    const event = EVENT_TYPES.find((e) => e === message.event);
    if (!event || !int(message.seq, 1, 2 ** 31 - 1)) return null;
    const payload = parsePayload(event, message.payload);
    return payload ? { type, taskId, attempt, seq: message.seq as number, event, payload } : null;
  }
  if (type === "task.complete" || type === "task.fail") {
    if (
      !keysOk(message, ["type", "taskId", "attempt", "seq", "reason", "result"]) ||
      !int(message.seq, 1, 2 ** 31 - 1)
    )
      return null;
    const result = parseResult(message.result);
    if (!result) return null;
    if (type === "task.complete")
      return message.reason === undefined
        ? { type, taskId, attempt, seq: message.seq as number, result }
        : null;
    const reason = FAIL_REASONS.find((r) => r === message.reason);
    return reason ? { type, taskId, attempt, seq: message.seq as number, reason, result } : null;
  }
  return null;
}
