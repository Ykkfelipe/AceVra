import { useCallback, useEffect, useRef, useState } from "react";
import type { ExecutionTarget, TaskEvent, TaskView } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { splitArgs } from "./splitArgs.js";
import { useAccountText } from "./useAccountText.js";
import { useAceVraAccount } from "./useAceVraAccount.js";

const ACTIVE = ["queued", "dispatching", "running", "running_unknown", "cancelling"];
const MAX_LINES = 400;

const STATE_LABEL: Record<string, string> = {
  queued: "Queued",
  dispatching: "Starting",
  running: "Running",
  running_unknown: "Running (connection lost)",
  cancelling: "Cancelling",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
const REASON_TEXT: Record<string, string> = {
  not_signed_in: "Sign in to run on another device.",
  target_unavailable: "That device is offline or can't run processes right now.",
  target_not_found: "That device no longer exists.",
  invalid_request: "Check the command and working directory.",
  unavailable: "The control plane is unreachable.",
};

/** One display line per event, derived only from TaskEvents (never invented text). */
function describeEvent(event: TaskEvent): { text: string; tone: "out" | "err" | "info" } | null {
  const p = event.payload;
  switch (event.type) {
    case "process.output":
      return { text: String(p.text ?? ""), tone: p.stream === "stderr" ? "err" : "out" };
    case "process.started":
      return { text: "Process started", tone: "info" };
    case "process.progress":
      return { text: String(p.message ?? ""), tone: "info" };
    case "process.truncated":
      return { text: "— output truncated —", tone: "info" };
    case "task.assigned":
      return { text: "Sent to device", tone: "info" };
    case "task.accepted":
      return { text: "Device accepted the task", tone: "info" };
    case "task.node_disconnected":
      return {
        text: "Connection to the device was lost; the process may still be running",
        tone: "info",
      };
    case "task.reconciled":
      return { text: "Device reconnected", tone: "info" };
    case "task.cancel_requested":
      return { text: "Cancel requested", tone: "info" };
    case "task.cancelled":
      return {
        text: p.acknowledged === false ? "Cancelled (the device did not confirm)" : "Cancelled",
        tone: "info",
      };
    case "process.completed":
      return { text: `Exited ${String(p.exitCode ?? 0)}`, tone: "info" };
    case "process.failed":
      return {
        text: `Failed: ${String(p.reason ?? "error")}${p.exitCode != null ? ` (exit ${String(p.exitCode)})` : ""}${p.detail ? ` — ${String(p.detail)}` : ""}`,
        tone: "info",
      };
    default:
      return null;
  }
}

/** Run a process on an execution target and watch it live. Local runs need no account. */
export function AceVraTasksSection() {
  const account = usePlatform().account;
  const text = useAccountText();
  const phase = useAceVraAccount().view?.phase;
  const [targets, setTargets] = useState<ExecutionTarget[]>([]);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [targetId, setTargetId] = useState("local");
  const [executable, setExecutable] = useState("");
  const [argLine, setArgLine] = useState("");
  const [cwd, setCwd] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [lines, setLines] = useState<{ key: number; text: string; tone: string }[]>([]);
  const after = useRef(0);

  const refreshTargets = useCallback(
    async () => setTargets((await account?.listTargets().catch(() => [])) ?? []),
    [account],
  );
  const refreshTasks = useCallback(
    async () => setTasks((await account?.listTasks().catch(() => [])) ?? []),
    [account],
  );

  useEffect(() => {
    void refreshTargets();
    const timer = setInterval(() => void refreshTargets(), 5000);
    return () => clearInterval(timer);
  }, [refreshTargets, phase]);
  const anyActive = tasks.some((t) => ACTIVE.includes(t.state));
  useEffect(() => {
    void refreshTasks();
    const timer = setInterval(() => void refreshTasks(), anyActive ? 1500 : 8000);
    return () => clearInterval(timer);
  }, [refreshTasks, anyActive, phase]);

  const selectedTask = tasks.find((t) => t.id === selected) ?? null;
  const selectedActive = selectedTask ? ACTIVE.includes(selectedTask.state) : false;
  useEffect(() => {
    after.current = 0;
    setLines([]);
  }, [selected]);
  useEffect(() => {
    if (!account || !selected) return;
    let live = true;
    const poll = async () => {
      const events = await account.getTaskEvents(selected, after.current).catch(() => []);
      if (!live || events.length === 0) return;
      after.current = events[events.length - 1]!.sequence;
      setLines((prev) =>
        [
          ...prev,
          ...events.flatMap((e) =>
            describeEvent(e) ? [{ key: e.sequence, ...describeEvent(e)! }] : [],
          ),
        ].slice(-MAX_LINES),
      );
    };
    void poll();
    // Keep polling while active; one trailing poll after it ends picks up the final events.
    const timer = setInterval(() => void poll(), selectedActive ? 700 : 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [account, selected, selectedActive]);

  if (!account) return null;
  const current = targets.find((t) => t.id === targetId);
  const nameOf = (id: string) =>
    targets.find((t) => t.id === id)?.displayName ?? text("tasks.unknownTarget", "Device");

  const run = async () => {
    setError(null);
    const result = await account.startRemoteProcess({
      targetId,
      process: { executable: executable.trim(), args: splitArgs(argLine), cwd: cwd.trim() },
    });
    if (result.ok) {
      setSelected(result.taskId);
      await refreshTasks();
    } else {
      setError(
        text(
          `tasks.error.${result.reason}`,
          REASON_TEXT[result.reason] ?? "Could not start the task.",
        ),
      );
    }
  };

  return (
    <div className="space-y-3" data-testid="acevra-tasks-section">
      <h3 className="font-medium">{text("tasks.title", "Run a process")}</h3>
      <p className="text-xs text-muted-foreground">
        {text(
          "tasks.note",
          "Runs a program with arguments (no shell) in a folder that already exists on the chosen device.",
        )}
      </p>
      <div className="grid gap-2 text-sm">
        <label className="grid gap-1">
          <span>{text("tasks.runOn", "Run on")}</span>
          <select
            className="rounded-md border bg-background p-2"
            data-testid="acevra-run-target"
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
          >
            {targets.map((target) => (
              <option key={target.id} value={target.id} disabled={!target.available}>
                {`${target.isThisDevice ? `${target.displayName} (this device)` : target.displayName} — ${
                  target.available
                    ? text("tasks.available", "available")
                    : target.unavailableReason === "offline"
                      ? text("tasks.offline", "offline")
                      : text("tasks.unavailable", "unavailable")
                }`}
              </option>
            ))}
          </select>
          {current && current.capabilities.length > 0 && (
            <span className="text-xs text-muted-foreground">{current.capabilities.join(", ")}</span>
          )}
        </label>
        <Input
          aria-label={text("tasks.executable", "Program")}
          placeholder={text("tasks.executable", "Program")}
          value={executable}
          onChange={(event) => setExecutable(event.target.value)}
        />
        <Input
          aria-label={text("tasks.args", "Arguments")}
          placeholder={text("tasks.args", "Arguments")}
          value={argLine}
          onChange={(event) => setArgLine(event.target.value)}
        />
        <Input
          aria-label={text("tasks.cwd", "Working directory")}
          placeholder={text("tasks.cwd", "Working directory (absolute path)")}
          value={cwd}
          onChange={(event) => setCwd(event.target.value)}
        />
        <div>
          <Button
            size="sm"
            data-testid="acevra-run-start"
            disabled={!executable.trim() || !cwd.trim() || !current?.available}
            onClick={() => void run()}
          >
            {text("tasks.run", "Run")}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive" data-testid="acevra-run-error">
            {error}
          </p>
        )}
      </div>

      {tasks.length > 0 && (
        <ul className="space-y-1" data-testid="acevra-task-list">
          {tasks.slice(0, 8).map((task) => (
            <li
              key={task.id}
              className="rounded-md border p-2 text-sm"
              data-testid="acevra-task-row"
              data-state={task.state}
            >
              <div className="flex items-center justify-between gap-2">
                <button
                  className="text-left"
                  data-testid="acevra-task-open"
                  onClick={() => setSelected(task.id)}
                >
                  <span className="font-medium">{nameOf(task.targetId)}</span>
                  <span className="text-muted-foreground">
                    {` · ${task.process.executable} ${task.process.args.join(" ")}`.slice(0, 80)}
                  </span>
                </button>
                <span data-testid="acevra-task-state">{STATE_LABEL[task.state] ?? task.state}</span>
              </div>
              {ACTIVE.includes(task.state) && (
                <div className="mt-1 flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="acevra-task-cancel"
                    onClick={() => void account.cancelTask(task.id).then(refreshTasks)}
                  >
                    {text("tasks.cancel", "Cancel")}
                  </Button>
                  {(task.state === "cancelling" || task.state === "running_unknown") &&
                    !task.id.startsWith("local-") && (
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid="acevra-task-force"
                        onClick={() => void account.cancelTask(task.id, true).then(refreshTasks)}
                      >
                        {text("tasks.force", "Mark cancelled anyway")}
                      </Button>
                    )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {selectedTask && (
        <div data-testid="acevra-task-output-panel">
          <p className="mb-1 text-sm font-medium">
            {nameOf(selectedTask.targetId)} ·{" "}
            {STATE_LABEL[selectedTask.state] ?? selectedTask.state}
          </p>
          <pre
            className="max-h-64 overflow-auto rounded-md border bg-muted p-2 text-xs whitespace-pre-wrap"
            data-testid="acevra-task-output"
          >
            {lines.map((line) => (
              <span
                key={line.key}
                className={
                  line.tone === "err"
                    ? "text-destructive"
                    : line.tone === "info"
                      ? "text-muted-foreground"
                      : ""
                }
              >
                {line.tone === "info" ? `${line.text}\n` : line.text}
              </span>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}
