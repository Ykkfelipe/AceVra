import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ProcessRequest, TaskEvent, TaskView } from "@zcode/shared";
import { SSH_BASE_OPTIONS, powershellArgs, type SpawnFn } from "./sshCommand.js";

const MAX_TASKS = 25;
const MAX_EVENTS = 2000;
const MAX_OUTPUT_BYTES = 1_000_000;
export const SSH_TASK_PREFIX = "ssh-";

interface SshTask {
  view: TaskView;
  events: TaskEvent[];
  outputBytes: number;
  child?: ChildProcess;
  cancelRequested: boolean;
}

const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * Builds the PowerShell script for one process. No string is interpolated unquoted: every value
 * is a single-quoted literal, and the exit code is the process's own.
 */
export function buildPowerShellScript(request: ProcessRequest): string {
  const lines = ["$ErrorActionPreference = 'Stop'", "$ProgressPreference = 'SilentlyContinue'"];
  for (const [key, value] of Object.entries(request.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    lines.push(`Set-Item -LiteralPath ${psQuote(`Env:${key}`)} -Value ${psQuote(value)}`);
  }
  lines.push(`Set-Location -LiteralPath ${psQuote(request.cwd)}`);
  const args = (request.args ?? []).map(psQuote).join(" ");
  lines.push(`& ${psQuote(request.executable)}${args ? ` ${args}` : ""}`);
  lines.push("if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } else { exit 0 }");
  return lines.join("\n");
}

/**
 * Runs processes on SSH computers (`ssh <alias> powershell -EncodedCommand`). Same TaskView /
 * TaskEvent shape as the local runner, so the existing work card shows live output and Stop.
 * Stop kills the ssh client, which closes the channel and ends the remote process tree.
 */
export function createSshProcessRunner(deps: { spawn: SpawnFn }) {
  const tasks = new Map<string, SshTask>();
  const order: string[] = [];

  function push(task: SshTask, type: string, payload: Record<string, unknown> = {}) {
    if (task.events.length >= MAX_EVENTS && type === "process.output") return;
    const sequence = task.events.length + 1;
    task.events.push({ sequence, type, ts: new Date().toISOString(), payload });
    task.view.lastSequence = sequence;
  }

  function finish(
    task: SshTask,
    state: TaskView["state"],
    result: Record<string, unknown>,
    type: string,
  ) {
    if (task.view.finishedAt) return;
    task.view.state = state;
    task.view.finishedAt = new Date().toISOString();
    task.view.result = result;
    push(task, type, result);
  }

  return {
    start(input: { targetId: string; hostAlias: string; process: ProcessRequest }): {
      ok: true;
      taskId: string;
    } {
      const id = `${SSH_TASK_PREFIX}${randomUUID()}`;
      const timeoutMs = input.process.timeoutMs ?? 600_000;
      const task: SshTask = {
        view: {
          id,
          targetId: input.targetId,
          state: "running",
          process: {
            executable: input.process.executable,
            args: input.process.args ?? [],
            cwd: input.process.cwd,
            timeoutMs,
          },
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          finishedAt: null,
          result: null,
          lastSequence: 0,
        },
        events: [],
        outputBytes: 0,
        cancelRequested: false,
      };
      tasks.set(id, task);
      order.unshift(id);
      for (const old of order.splice(MAX_TASKS)) tasks.delete(old);
      push(task, "task.created", { executable: input.process.executable });
      push(task, "task.accepted");
      const started = Date.now();
      let child: ChildProcess;
      try {
        child = deps.spawn(
          "ssh",
          [
            ...SSH_BASE_OPTIONS,
            input.hostAlias,
            ...powershellArgs(buildPowerShellScript(input.process)),
          ],
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
        );
      } catch {
        finish(task, "failed", { reason: "spawn_failed", exitCode: null }, "process.failed");
        return { ok: true, taskId: id };
      }
      task.child = child;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      push(task, "process.started", {});
      const onData = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
        if (task.outputBytes >= MAX_OUTPUT_BYTES) return;
        task.outputBytes += chunk.length;
        push(task, "process.output", { stream, text: chunk.toString("utf8"), bytes: chunk.length });
        if (task.outputBytes >= MAX_OUTPUT_BYTES)
          push(task, "process.truncated", { stream: "both", limitBytes: MAX_OUTPUT_BYTES });
      };
      child.stdout?.on("data", onData("stdout"));
      child.stderr?.on("data", onData("stderr"));
      child.on("error", () => undefined);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const result = {
          exitCode: code,
          signal: signal ?? null,
          durationMs: Date.now() - started,
          droppedBytes: 0,
          timedOut,
        };
        if (task.cancelRequested) {
          finish(
            task,
            "cancelled",
            { ...result, reason: "cancelled", acknowledged: true },
            "task.cancelled",
          );
        } else if (code === 0) {
          finish(task, "completed", result, "process.completed");
        } else {
          // ssh 自身失败（连不上/认证）返回 255：如实报告，绝不改在本机执行。
          const reason = timedOut ? "timeout" : code === 255 ? "ssh_failed" : "exit_nonzero";
          finish(task, "failed", { ...result, reason }, "process.failed");
        }
      });
      return { ok: true, taskId: id };
    },
    list: (): TaskView[] => order.map((id) => tasks.get(id)!.view),
    get: (id: string): TaskView | null => tasks.get(id)?.view ?? null,
    events: (id: string, after: number): TaskEvent[] | null =>
      tasks.get(id)?.events.filter((e) => e.sequence > after) ?? null,
    cancel(id: string): TaskView | null {
      const task = tasks.get(id);
      if (!task) return null;
      if (task.view.state === "running") {
        task.cancelRequested = true;
        task.view.state = "cancelling";
        push(task, "task.cancel_requested");
        task.child?.kill();
      }
      return task.view;
    },
    cancelForTarget(targetId: string) {
      for (const task of tasks.values()) {
        if (task.view.targetId === targetId && task.view.state === "running")
          this.cancel(task.view.id);
      }
    },
    shutdown() {
      for (const task of tasks.values()) task.child?.kill();
    },
  };
}
export type SshProcessRunner = ReturnType<typeof createSshProcessRunner>;
