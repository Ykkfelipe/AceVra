/**
 * 对话内的实时任务卡（M2E）。
 *
 * 纯投影：状态来自真实 TaskView（listTasks），输出行来自 TaskEvents；Stop 走既有 cancelTask。
 * 只渲染归属当前 scope 的任务（由发起任务的代码挂到 executionTargetStore），从不展示
 * executable / args / cwd，渲染本身不会启动任务、捕获或工具调用。
 */
import { memo } from "react";
import { XIcon } from "lucide-react";
import type { TaskState } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useAttachedTasks, useTaskEventLines } from "@/hooks/useAttachedTasks.js";
import { useExecutionTargets } from "@/hooks/useExecutionTargets.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  resolveTaskStatus,
  type TaskLiveLine,
  type TaskStatusView,
} from "@/account/executionPresentation.js";
import { useExecutionTargetStore } from "@/store/executionTargetStore.js";

const MAX_CARDS = 3;
const EMPTY: readonly string[] = [];

interface ExecutionTaskCardViewProps {
  taskId: string;
  targetName: string;
  status: TaskStatusView;
  lines: readonly TaskLiveLine[];
  onStop: () => void;
  onDismiss: () => void;
}

/** Presentational card; every value comes from the caller's TaskView/TaskEvent projection. */
export function ExecutionTaskCardView({
  taskId,
  targetName,
  status,
  lines,
  onStop,
  onDismiss,
}: ExecutionTaskCardViewProps) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string>) =>
    intl.formatMessage({ id: `acevra.execution.${id}` }, values);
  const failed = status.id === "failed" || status.id === "connectionLost";
  return (
    <div
      className="pointer-events-auto w-full rounded-xl border border-card-border bg-card px-3 py-2 text-ui-sm"
      data-testid="acevra-task-card"
      data-task-id={taskId}
      data-task-status={status.id}
      role="status"
      aria-live="polite"
    >
      <div className="flex min-h-6 items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            status.active
              ? "bg-success animate-pulse"
              : failed
                ? "bg-destructive"
                : "bg-foreground-subtlest",
          )}
        />
        <p className="min-w-0 flex-1 truncate text-ui-base text-foreground">
          <span className="font-medium">{targetName}</span>
          <span className="text-foreground-subtle">
            {" · "}
            <span data-testid="acevra-task-card-status">{t(`status.${status.id}`)}</span>
            {status.exitCode !== undefined && status.exitCode !== 0
              ? ` · ${t("exitCode", { code: String(status.exitCode) })}`
              : null}
          </span>
        </p>
        {status.active ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid="acevra-task-card-stop"
            disabled={status.id === "stopping"}
            onClick={onStop}
          >
            {t("stop")}
          </Button>
        ) : (
          <Button
            size="icon-sm"
            variant="ghost"
            data-testid="acevra-task-card-dismiss"
            aria-label={t("dismiss")}
            onClick={onDismiss}
          >
            <XIcon className="size-3.5" />
          </Button>
        )}
      </div>
      {lines.length > 0 && (
        <div
          className="mt-1 space-y-0.5 font-mono text-ui-xs text-foreground-subtle"
          data-testid="acevra-task-card-lines"
        >
          {lines.map((line) => (
            <p
              key={line.key}
              className={cn("truncate", line.stream === "stderr" && "text-destructive")}
            >
              {line.text}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function AttachedTaskCard({
  scopeKey,
  taskId,
  state,
  loaded,
  targetName,
}: {
  scopeKey: string;
  taskId: string;
  state: TaskState | null;
  loaded: boolean;
  targetName: string;
}) {
  const account = useOptionalPlatform()?.account;
  const pending = state === null && !loaded;
  const active = pending || resolveTaskStatus(state, []).active;
  const { lines, terminalEvents } = useTaskEventLines(taskId, active);
  const dismiss = useExecutionTargetStore((s) => s.dismissTask);
  return (
    <ExecutionTaskCardView
      taskId={taskId}
      targetName={targetName}
      status={pending ? { id: "starting", active: true } : resolveTaskStatus(state, terminalEvents)}
      lines={lines}
      onStop={() => void account?.cancelTask(taskId)}
      onDismiss={() => dismiss(scopeKey, taskId)}
    />
  );
}

function ExecutionTaskCardsMounted({ scopeKey }: { scopeKey: string }) {
  const { intl } = useZCodeIntl();
  const taskIds = useExecutionTargetStore((s) => s.tasksByScope[scopeKey] ?? EMPTY);
  const visible = taskIds.slice(-MAX_CARDS);
  const { tasks, loaded } = useAttachedTasks(visible);
  const { targets } = useExecutionTargets(visible.length > 0);
  if (visible.length === 0) return null;
  const nameOf = (targetId: string | undefined) =>
    targets?.find((t) => t.id === targetId)?.displayName ??
    intl.formatMessage({ id: "acevra.execution.target.unknown" });
  return (
    <div className="mb-2 flex w-full flex-col gap-1.5" data-testid="acevra-task-cards">
      {visible.map((taskId) => (
        <AttachedTaskCard
          key={taskId}
          scopeKey={scopeKey}
          taskId={taskId}
          state={tasks[taskId]?.state ?? null}
          loaded={loaded}
          targetName={nameOf(tasks[taskId]?.targetId)}
        />
      ))}
    </div>
  );
}

function ExecutionTaskCardsImpl({ scopeKey }: { scopeKey: string }) {
  if (!useOptionalPlatform()?.account) return null;
  return <ExecutionTaskCardsMounted scopeKey={scopeKey} />;
}

export const ExecutionTaskCards = memo(ExecutionTaskCardsImpl);
