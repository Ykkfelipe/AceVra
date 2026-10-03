import { useState } from "react";
import { ChevronRightIcon, SquareArrowOutUpRightIcon } from "lucide-react";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildMultitaskBoard,
  type MultitaskEvidence,
  type MultitaskOutcome,
  type MultitaskTaskView,
  type MultitaskWorkerState,
  type MultitaskWorkerView,
} from "./multitask-board-model.js";
import { WorkflowAgentFace } from "./WorkflowAgentFace.js";

/** 打开某个 worker 的 transcript：槽位身份 + 会话 id（有则随行）+ actor 名。 */
export interface MultitaskWorkerOpenRequest {
  siteId: string;
  ordinal: number;
  actorSessionId?: string;
  actorName?: string;
}

type Format = (descriptor: { id: string }, values?: Record<string, string | number>) => string;

/**
 * Multitask 的 worker-first 视图：每个 worker 一行——角色、读写权限、当前状态 / 动作、进度，
 * 结算后是结局与客观证据。证据与结局都不是 UI 推出来的（见 multitask-board-model.ts）。
 * 行可展开看逐任务结局与提交的结果，并打开该 worker 的 transcript。
 */
export function MultitaskWorkerBoard({
  run,
  onOpenWorker,
}: {
  run: WorkflowRunState;
  onOpenWorker?: (request: MultitaskWorkerOpenRequest) => void;
}) {
  const workers = buildMultitaskBoard(run);
  if (workers.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col py-1" data-testid="multitask-board">
      {workers.map((worker) => (
        <MultitaskWorkerRow key={worker.key} worker={worker} onOpenWorker={onOpenWorker} />
      ))}
    </div>
  );
}

function MultitaskWorkerRow({
  worker,
  onOpenWorker,
}: {
  worker: MultitaskWorkerView;
  onOpenWorker?: (request: MultitaskWorkerOpenRequest) => void;
}) {
  const { intl } = useZCodeIntl();
  const format: Format = intl.formatMessage.bind(intl);
  const [open, setOpen] = useState(false);
  const canExpand = worker.tasks.length > 0 || onOpenWorker !== undefined;
  const detail = workerDetail(format, worker);
  return (
    <div
      className="flex min-w-0 flex-col"
      data-multitask-worker={worker.workerId}
      data-multitask-state={worker.state}
      data-testid="multitask-worker"
    >
      <button
        aria-expanded={canExpand ? open : undefined}
        className={cn(
          "flex min-w-0 items-start gap-2 rounded-lg px-1.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          canExpand ? "cursor-pointer hover:bg-hover" : "cursor-default",
        )}
        disabled={!canExpand}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <WorkflowAgentFace
          avatarIndex={worker.avatarIndex}
          className="mt-0.5 size-4 shrink-0"
          name={worker.actorName ?? worker.workerId}
          status={faceStatus(worker.state)}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-ui-base font-medium text-foreground">{worker.role}</span>
            <span className="shrink-0 rounded-md bg-surface px-1.5 text-ui-xs text-foreground-subtle">
              {format({
                id:
                  worker.access === "write"
                    ? "chat.toolCall.multitask.access.write"
                    : "chat.toolCall.multitask.access.read",
              })}
            </span>
            {worker.reused ? (
              <span
                className="shrink-0 rounded-md bg-surface px-1.5 text-ui-xs text-foreground-subtle"
                data-testid="multitask-worker-reused"
              >
                {format({ id: "chat.toolCall.multitask.reused" })}
              </span>
            ) : null}
            <StateLabel format={format} state={worker.state} />
          </span>
          {detail === undefined ? null : (
            <span
              className={cn(
                "min-w-0 truncate text-ui-xs",
                detail.tone === "warning" ? "text-warning" : "text-foreground-subtle",
                detail.mono && "font-mono",
              )}
              data-testid="multitask-worker-detail"
              title={detail.text}
            >
              {detail.text}
            </span>
          )}
        </span>
        {canExpand ? (
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "mt-0.5 size-3.5 shrink-0 text-foreground-subtlest transition-transform",
              open && "rotate-90",
            )}
          />
        ) : null}
      </button>
      {open ? (
        <div className="flex min-w-0 flex-col gap-2 pb-2 pl-8 pr-1.5 pt-0.5">
          {worker.tasks.map((task) => (
            <TaskLine format={format} key={task.task} task={task} />
          ))}
          {onOpenWorker === undefined ? null : (
            <button
              className="flex w-fit items-center gap-1 text-ui-xs font-medium text-foreground-subtle outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
              data-testid="multitask-worker-open"
              onClick={() =>
                onOpenWorker({
                  siteId: worker.siteId,
                  ordinal: worker.ordinal,
                  ...(worker.sessionId === undefined ? {} : { actorSessionId: worker.sessionId }),
                  ...(worker.actorName === undefined ? {} : { actorName: worker.actorName }),
                })
              }
              type="button"
            >
              <SquareArrowOutUpRightIcon aria-hidden className="size-3" />
              {format({ id: "chat.toolCall.multitask.openTranscript" })}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function TaskLine({ format, task }: { format: Format; task: MultitaskTaskView }) {
  const evidence = task.evidence === undefined ? undefined : evidenceText(format, task.evidence);
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-multitask-task={task.task}>
      <span className="flex min-w-0 items-center gap-2 text-ui-xs">
        <span className="truncate font-mono text-foreground-subtle">{task.task}</span>
        <StateLabel format={format} state={task.outcome} />
      </span>
      {task.result.length > 0 ? (
        <p className="line-clamp-4 whitespace-pre-wrap break-words text-ui-xs text-foreground">
          {task.result}
        </p>
      ) : null}
      {evidence === undefined ? null : (
        <span className="text-ui-xs text-foreground-subtlest">{evidence}</span>
      )}
      {task.evidence !== undefined && task.evidence.filesChanged.length > 0 ? (
        <span className="truncate font-mono text-ui-xs text-foreground-subtlest">
          {task.evidence.filesChanged.map(baseName).join(", ")}
        </span>
      ) : null}
    </div>
  );
}

/** 状态词与语义色：done 用 success，需要留意的用 warning，做不成的用 destructive。 */
const STATE_TONE: Record<MultitaskWorkerState, "success" | "warning" | "destructive" | "muted"> = {
  waiting: "muted",
  working: "warning",
  submitting: "warning",
  stopped: "muted",
  failed: "destructive",
  done: "success",
  done_no_changes: "warning",
  unverified: "warning",
  blocked: "destructive",
  skipped: "muted",
};

function StateLabel({ format, state }: { format: Format; state: MultitaskWorkerState }) {
  const tone = STATE_TONE[state];
  return (
    <span
      className={cn(
        "ml-auto flex shrink-0 items-center gap-1 text-ui-xs font-medium",
        tone === "success" && "text-success",
        tone === "warning" && "text-warning",
        tone === "destructive" && "text-destructive",
        tone === "muted" && "text-foreground-subtlest",
      )}
      data-testid="multitask-state"
    >
      {state === "working" || state === "submitting" ? (
        <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-warning" />
      ) : null}
      {format({ id: `chat.toolCall.multitask.state.${state}` })}
    </span>
  );
}

/** 行下那一行说明：进行中说「在做什么」，结算后说证据或为什么不算成功。 */
function workerDetail(
  format: Format,
  worker: MultitaskWorkerView,
): { text: string; tone?: "warning"; mono?: boolean } | undefined {
  switch (worker.state) {
    case "working": {
      const action = worker.action;
      const doing =
        action === undefined
          ? format({ id: "chat.toolCall.multitask.detail.thinking" })
          : [action.name, action.target].filter(Boolean).join(" ");
      // 还没开跑任何工具时只说「思考中」：「0 次工具调用」在进行中读起来像停滞。
      return {
        text: worker.toolCalls > 0 ? `${doing} · ${toolCallsText(format, worker.toolCalls)}` : doing,
        mono: action !== undefined,
      };
    }
    case "submitting":
      return { text: format({ id: "chat.toolCall.multitask.detail.submitting" }) };
    case "waiting":
      return { text: format({ id: "chat.toolCall.multitask.detail.waiting" }) };
    case "unverified":
      return { text: format({ id: "chat.toolCall.multitask.detail.unverified" }), tone: "warning" };
    case "done_no_changes":
      return {
        text: format({ id: "chat.toolCall.multitask.detail.noChanges" }),
        tone: "warning",
      };
    case "blocked":
    case "failed":
    case "skipped": {
      const reason = worker.tasks.find((task) => task.outcome === worker.state)?.result;
      return reason === undefined || reason.length === 0
        ? undefined
        : { text: firstLine(reason) };
    }
    case "stopped":
      return { text: format({ id: "chat.toolCall.multitask.detail.stopped" }) };
    case "done":
      return worker.evidence === undefined
        ? undefined
        : { text: evidenceText(format, worker.evidence) };
  }
}

/** 客观证据：改了几个文件、跑了几条命令、一共几次工具调用（零项不说）。 */
function evidenceText(format: Format, evidence: MultitaskEvidence): string {
  const parts: string[] = [];
  const files = evidence.filesChangedTotal ?? evidence.filesChanged.length;
  if (files > 0) parts.push(countText(format, "chat.toolCall.multitask.evidence.files", files));
  else if (evidence.mutatingToolCalls > 0)
    parts.push(countText(format, "chat.toolCall.multitask.evidence.edits", evidence.mutatingToolCalls));
  if (evidence.commandCalls > 0)
    parts.push(countText(format, "chat.toolCall.multitask.evidence.commands", evidence.commandCalls));
  parts.push(toolCallsText(format, evidence.toolCalls));
  return parts.join(" · ");
}

function toolCallsText(format: Format, count: number): string {
  return countText(format, "chat.toolCall.multitask.evidence.toolCalls", count);
}

function countText(format: Format, base: string, count: number): string {
  return format({ id: count === 1 ? `${base}.one` : `${base}.other` }, { count });
}

function faceStatus(state: MultitaskWorkerState): StepRunStatus {
  switch (state) {
    case "working":
    case "submitting":
      return "running";
    case "done":
    case "done_no_changes":
    case "unverified":
      return "done";
    case "blocked":
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0]!.trim();
}

function baseName(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index >= 0 ? path.slice(index + 1) : path;
}

export type { MultitaskOutcome };
