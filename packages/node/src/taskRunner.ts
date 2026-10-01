import type { Outcome, ShellService } from "./shell/executor.js";
import { parseProcessSpec } from "./shell/spec.js";

export interface RunnerLink {
  /** Returns false if the socket is not open. */
  send(frame: Record<string, unknown>): boolean;
  bufferedAmount(): number;
}
export interface RunnerLimits {
  maxUnackedEvents: number;
  maxUnackedBytes: number;
  /** Pause child pipes while the socket's send buffer exceeds this. */
  maxSocketBuffered: number;
}
const DEFAULT_LIMITS: RunnerLimits = {
  maxUnackedEvents: 256,
  maxUnackedBytes: 512 * 1024,
  maxSocketBuffered: 256 * 1024,
};

interface Unacked {
  seq: number;
  frame: Record<string, unknown>;
  bytes: number;
}
interface Active {
  taskId: string;
  attempt: number;
  seq: number;
  unacked: Unacked[];
  unackedBytes: number;
  handle?: { cancel(): void };
  finished: boolean;
  full: boolean;
  resume?: () => void;
}

/**
 * Executes offered tasks through the shell service and reports them over the channel.
 * One task at a time. Frames are sequence-numbered and kept until the control plane acks
 * them, so a dropped connection loses nothing: they are re-sent on reconnect (the server
 * dedupes by seq). The buffer is bounded; when it fills the child's pipes are paused, so
 * output can never grow node memory, the socket or the database without limit.
 */
export function createTaskRunner(deps: {
  shell: ShellService;
  /** Whether the shell service passed its readiness check (never inferred from the OS). */
  shellReady: () => boolean;
  link: () => RunnerLink | null;
  log?: (event: string, facts?: Record<string, string | number | undefined>) => void;
  limits?: Partial<RunnerLimits>;
}) {
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const tasks = new Map<string, Active>();
  let pollTimer: NodeJS.Timeout | null = null;

  const send = (frame: Record<string, unknown>) => deps.link()?.send(frame) ?? false;
  const hasRoom = (a: Active) =>
    a.unacked.length < limits.maxUnackedEvents &&
    a.unackedBytes < limits.maxUnackedBytes &&
    (deps.link()?.bufferedAmount() ?? 0) < limits.maxSocketBuffered;

  /** Sequence, retain until acked, send if connected. Returns false when downstream is full. */
  function emit(a: Active, frame: Record<string, unknown>): boolean {
    const seq = ++a.seq;
    const full = { ...frame, seq };
    const bytes = JSON.stringify(full).length;
    a.unacked.push({ seq, frame: full, bytes });
    a.unackedBytes += bytes;
    send(full);
    const ok = hasRoom(a);
    if (!ok) {
      a.full = true;
      startPolling();
    }
    return ok;
  }
  function startPolling() {
    pollTimer ??= setInterval(() => {
      let any = false;
      for (const a of tasks.values()) {
        if (a.full && hasRoom(a)) {
          a.full = false;
          a.resume?.();
        }
        any ||= a.full;
      }
      if (!any && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }, 100);
    pollTimer.unref();
  }

  const reasonOf = (o: Outcome): "exit_nonzero" | "timeout" | "spawn_failed" | "cancelled" => {
    if (o.kind === "timeout") return "timeout";
    if (o.kind === "cancelled") return "cancelled";
    if (o.kind === "spawn_failed") return "spawn_failed";
    return "exit_nonzero";
  };

  async function onOffer(m: { taskId: string; attempt: number; process: unknown }) {
    const existing = tasks.get(m.taskId);
    if (existing) {
      // Never run a task twice: an offer for a known task is answered, not executed again.
      if (existing.attempt === m.attempt && !existing.finished)
        send({ type: "task.accept", taskId: m.taskId, attempt: m.attempt });
      return;
    }
    const reject = (reason: string) =>
      send({ type: "task.reject", taskId: m.taskId, attempt: m.attempt, reason });
    const spec = parseProcessSpec(m.process);
    if (!spec) return reject("invalid_process");
    if (!deps.shellReady()) return reject("shell_not_ready");
    if ([...tasks.values()].some((t) => !t.finished)) return reject("busy");
    const prepared = await deps.shell.prepare(spec);
    if ("error" in prepared) return reject("policy");

    const a: Active = {
      taskId: m.taskId,
      attempt: m.attempt,
      seq: 0,
      unacked: [],
      unackedBytes: 0,
      finished: false,
      full: false,
    };
    tasks.set(m.taskId, a);
    send({ type: "task.accept", taskId: m.taskId, attempt: m.attempt });
    deps.log?.("task-accepted");
    const base = { type: "task.event", taskId: a.taskId, attempt: a.attempt };
    const run = deps.shell.run(prepared, {
      started: (pid) => void emit(a, { ...base, event: "process.started", payload: { pid } }),
      output: (stream, text, bytes) =>
        emit(a, { ...base, event: "process.output", payload: { stream, text, bytes } }),
      truncated: (limitBytes) =>
        void emit(a, {
          ...base,
          event: "process.truncated",
          payload: { stream: "both", limitBytes },
        }),
      onDrain: (resume) => (a.resume = resume),
    });
    a.handle = run;
    const outcome = await run.done;
    a.finished = true;
    const result = {
      exitCode: outcome.kind === "exit" ? outcome.exitCode : null,
      signal: outcome.kind === "exit" ? outcome.signal : null,
      durationMs: outcome.durationMs,
      droppedBytes: outcome.droppedBytes,
      timedOut: outcome.kind === "timeout",
      ...(outcome.kind === "spawn_failed" ? { detail: outcome.detail.slice(0, 200) } : {}),
    };
    const ok = outcome.kind === "exit" && outcome.exitCode === 0;
    emit(
      a,
      ok
        ? { type: "task.complete", taskId: a.taskId, attempt: a.attempt, result }
        : {
            type: "task.fail",
            taskId: a.taskId,
            attempt: a.attempt,
            reason: reasonOf(outcome),
            result,
          },
    );
    deps.log?.("task-finished", { outcome: outcome.kind });
  }

  return {
    onOffer: (m: { taskId: string; attempt: number; process: unknown }) =>
      onOffer(m).catch(() => undefined),
    onCancel(m: { taskId: string }) {
      const a = tasks.get(m.taskId);
      if (a && !a.finished) a.handle?.cancel();
    },
    onAck(m: { taskId: string; seq: number; terminal?: boolean }) {
      const a = tasks.get(m.taskId);
      if (!a) return;
      a.unacked = a.unacked.filter((u) => u.seq > m.seq);
      a.unackedBytes = a.unacked.reduce((n, u) => n + u.bytes, 0);
      if (m.terminal && a.finished) tasks.delete(m.taskId);
      else if (a.full && hasRoom(a)) {
        a.full = false;
        a.resume?.();
      }
    },
    /**
     * After (re)authentication: re-assert accepted tasks, replay everything the control plane
     * has not acknowledged (events, then terminal results), and only then sync. Terminal
     * results go first so a finished task is never misread as "interrupted".
     */
    onConnected() {
      for (const a of tasks.values()) {
        if (!a.finished) send({ type: "task.accept", taskId: a.taskId, attempt: a.attempt });
        for (const u of a.unacked) send(u.frame);
      }
      send({
        type: "task.sync",
        active: [...tasks.values()]
          .filter((t) => !t.finished)
          .map((t) => ({ taskId: t.taskId, attempt: t.attempt })),
      });
    },
    activeTaskIds: () => [...tasks.values()].filter((t) => !t.finished).map((t) => t.taskId),
    /** Process shutdown: stop children; nothing is left running unattended. */
    shutdown() {
      for (const a of tasks.values()) if (!a.finished) a.handle?.cancel();
      if (pollTimer) clearInterval(pollTimer);
    },
  };
}
export type TaskRunner = ReturnType<typeof createTaskRunner>;
