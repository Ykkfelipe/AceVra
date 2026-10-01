import { randomUUID } from "node:crypto";
import { parse } from "node:path";
import { createShellService, parseProcessSpec, type ProcessSpec } from "@zcode/node/shell";
import type { ProcessRequest, TaskEvent, TaskView } from "@zcode/shared";

const MAX_TASKS = 25;
const MAX_EVENTS = 2000;
export const LOCAL_TARGET_ID = "local";

interface LocalTask {
  view: TaskView;
  events: TaskEvent[];
  cancel?: () => void;
}

/**
 * This desktop's own execution path: no control plane, no account. It produces the same
 * Task/TaskEvent shape as a Node so the UI (and later the agent) treat local, node and cloud
 * alike. It reuses the node's shell service, so limits, truncation and tree-kill are identical.
 */
export function createLocalProcessRunner() {
  const tasks = new Map<string, LocalTask>();
  const order: string[] = [];

  function push(task: LocalTask, type: string, payload: Record<string, unknown> = {}) {
    if (task.events.length >= MAX_EVENTS && type === "process.output") return; // bounded; truncation already recorded
    const sequence = task.events.length + 1;
    task.events.push({ sequence, type, ts: new Date().toISOString(), payload });
    task.view.lastSequence = sequence;
  }

  return {
    start(request: ProcessRequest): { ok: true; taskId: string } | { ok: false } {
      const spec: ProcessSpec | null = parseProcessSpec({
        executable: request.executable,
        args: request.args ?? [],
        cwd: request.cwd,
        env: request.env ?? {},
        timeoutMs: request.timeoutMs ?? 600_000,
      });
      if (!spec) return { ok: false };
      const id = `local-${randomUUID()}`;
      const task: LocalTask = {
        view: {
          id,
          targetId: LOCAL_TARGET_ID,
          state: "queued",
          process: {
            executable: spec.executable,
            args: spec.args,
            cwd: spec.cwd,
            timeoutMs: spec.timeoutMs,
          },
          createdAt: new Date().toISOString(),
          startedAt: null,
          finishedAt: null,
          result: null,
          lastSequence: 0,
        },
        events: [],
      };
      tasks.set(id, task);
      order.unshift(id);
      for (const old of order.splice(MAX_TASKS)) tasks.delete(old);
      push(task, "task.created", { executable: spec.executable });
      void execute(task, spec);
      return { ok: true, taskId: id };
    },
    list: (): TaskView[] => order.map((id) => tasks.get(id)!.view),
    events: (id: string, after: number): TaskEvent[] | null =>
      tasks.get(id)?.events.filter((e) => e.sequence > after) ?? null,
    cancel(id: string): TaskView | null {
      const task = tasks.get(id);
      if (!task) return null;
      if (task.view.state === "running") {
        task.view.state = "cancelling";
        push(task, "task.cancel_requested");
        task.cancel?.();
      }
      return task.view;
    },
    /** App shutdown: nothing started here is left running unattended. */
    shutdown() {
      for (const task of tasks.values()) task.cancel?.();
    },
  };

  async function execute(task: LocalTask, spec: ProcessSpec) {
    // The user chose this directory for their own machine; confine to its drive root only to
    // satisfy the shared policy (existence + absolute path are still enforced).
    const shell = createShellService({ roots: [parse(spec.cwd).root || "/"] });
    const prepared = await shell.prepare(spec);
    if ("error" in prepared) {
      task.view.state = "failed";
      task.view.finishedAt = new Date().toISOString();
      task.view.result = {
        reason: "rejected",
        detail: "cwd must be an existing absolute directory",
      };
      return push(task, "process.failed", task.view.result);
    }
    task.view.state = "running";
    task.view.startedAt = new Date().toISOString();
    push(task, "task.accepted");
    const run = shell.run(prepared, {
      started: (pid) => push(task, "process.started", { pid }),
      output: (stream, text, bytes) => (
        push(task, "process.output", { stream, text, bytes }), true
      ),
      truncated: (limitBytes) => push(task, "process.truncated", { stream: "both", limitBytes }),
      onDrain: () => undefined,
    });
    task.cancel = run.cancel;
    const outcome = await run.done;
    task.view.finishedAt = new Date().toISOString();
    const result = {
      exitCode: outcome.kind === "exit" ? outcome.exitCode : null,
      signal: outcome.kind === "exit" ? outcome.signal : null,
      durationMs: outcome.durationMs,
      droppedBytes: outcome.droppedBytes,
      timedOut: outcome.kind === "timeout",
    };
    if (outcome.kind === "cancelled") {
      task.view.state = "cancelled";
      task.view.result = { ...result, reason: "cancelled", acknowledged: true };
      push(task, "task.cancelled", { acknowledged: true });
    } else if (outcome.kind === "exit" && outcome.exitCode === 0) {
      task.view.state = "completed";
      task.view.result = result;
      push(task, "process.completed", result);
    } else {
      task.view.state = "failed";
      const reason =
        outcome.kind === "timeout"
          ? "timeout"
          : outcome.kind === "spawn_failed"
            ? "spawn_failed"
            : "exit_nonzero";
      task.view.result = { ...result, reason };
      push(task, "process.failed", task.view.result);
    }
  }
}
export type LocalProcessRunner = ReturnType<typeof createLocalProcessRunner>;
