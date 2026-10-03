/**
 * 无表单「Work on this」（docs/specs/cross-mode-bot-to-coding.md §10）。
 *
 * 默认路径：点按钮 → 读本对话投影 → 自动构建交接（objective + 最近摘录 + origin）→
 * 目标明确则立刻创建 Coding/Tasks 会话并切过去；不明确则只弹轻量 Work in… 选择器，选中即开始。
 * 「…」里的 Review context… 打开原有的详细对话框（显式控制，从不在默认路径上）。
 *
 * 本组件不持有交接状态：契约、准入、origin、模型继承都沿用已接受的实现。
 */
import { useCallback, useRef, useState } from "react";
import { FolderGit2, Hammer, ListTodo, Loader2, MoreHorizontal } from "lucide-react";
import {
  beginHandoffPreview,
  confirmHandoffPreview,
  type HandoffConfirmation,
  type HandoffObjectRef,
} from "@zcode/shared/cross-mode";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { readConversationSnapshotOnce } from "@/hooks/useConversationRowsSnapshot.js";
import type {
  CrossModeCodingLaunchResult,
  CrossModeCodingTarget,
} from "@/hooks/useCrossModeCodingLaunch.js";
import { logger } from "@/logger.js";
import { WorkOnThisDialog, type WorkOnThisTarget } from "@/bot/workOnThis/WorkOnThisDialog.js";
import { buildAutomaticHandoff, inferWorkDestination } from "@/bot/workOnThis/seamlessHandoff.js";
import {
  resolveAutomationWorkspaceSelectionKey,
  type AutomationWorkspaceOption,
} from "@/settings/automationWorkspaceOptions.js";

type ModelSelection = SessionConfigState["modelSelection"];

interface PendingChoice {
  confirmation: HandoffConfirmation;
  modelSelection: ModelSelection;
}

export interface WorkOnThisActionProps {
  botWorkspacePath: string;
  conversationRef: HandoffObjectRef;
  conversationTitle: string | null;
  projects: readonly AutomationWorkspaceOption[];
  onResolveTasksWorkspace?: () => Promise<string>;
  launch: (
    target: CrossModeCodingTarget,
    confirmation: HandoffConfirmation,
    modelSelection?: ModelSelection,
  ) => Promise<CrossModeCodingLaunchResult>;
  pending: boolean;
}

export function WorkOnThisAction({
  botWorkspacePath,
  conversationRef,
  conversationTitle,
  projects,
  onResolveTasksWorkspace,
  launch,
  pending,
}: WorkOnThisActionProps) {
  const { intl } = useZCodeIntl();
  const { zcodeAgentService } = useServices();
  const [preparing, setPreparing] = useState(false);
  const [choice, setChoice] = useState<PendingChoice | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const busyRef = useRef(false);
  const tasksAvailable = Boolean(onResolveTasksWorkspace);
  const busy = preparing || pending;

  const resolveTarget = useCallback(
    async (target: WorkOnThisTarget): Promise<CrossModeCodingTarget> => {
      if (target.kind === "project") {
        return {
          workspacePath: target.project.workspacePath,
          ...(target.project.workspaceIdentity
            ? { workspaceIdentity: target.project.workspaceIdentity }
            : {}),
        };
      }
      if (!onResolveTasksWorkspace) throw new Error("Tasks is unavailable");
      return { workspacePath: await onResolveTasksWorkspace(), workspacePurpose: "conversation" };
    },
    [onResolveTasksWorkspace],
  );

  const start = useCallback(
    async (
      target: WorkOnThisTarget,
      confirmation: HandoffConfirmation,
      modelSelection: ModelSelection,
    ): Promise<{ ok: true } | { ok: false; message: string | null }> => {
      try {
        const result = await launch(await resolveTarget(target), confirmation, modelSelection);
        return result.ok ? { ok: true } : { ok: false, message: result.message };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : null };
      }
    },
    [launch, resolveTarget],
  );

  const reportFailure = useCallback(
    (message: string | null) => {
      toast(message ?? intl.formatMessage({ id: "bot.workOnThis.error.generic" }));
    },
    [intl],
  );

  const handleWorkOnThis = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setPreparing(true);
    try {
      const { rows, modelSelection } = await readConversationSnapshotOnce({
        workspacePath: botWorkspacePath,
        sessionId: conversationRef.id,
        agentService: zcodeAgentService,
      });
      const { packet, excerpts } = buildAutomaticHandoff({
        conversationRef,
        title: conversationTitle,
        rows,
        notesLabel: intl.formatMessage({ id: "bot.workOnThis.notesLabel" }),
        placeholderTitles: [intl.formatMessage({ id: "bot.header.newConversation" })],
        labels: {
          excerpt: (role) =>
            intl.formatMessage({
              id: role === "user" ? "bot.workOnThis.excerpt.user" : "bot.workOnThis.excerpt.ace",
            }),
        },
      });
      const confirmed = confirmHandoffPreview(beginHandoffPreview(packet));
      if (!confirmed.ok || !confirmed.session.confirmation) {
        // 自动草稿过不了契约（例如对话还没有任何可用文本）：交给 Review 让用户补全。
        setReviewOpen(true);
        return;
      }
      const confirmation = confirmed.session.confirmation;
      const inference = inferWorkDestination(conversationTitle, excerpts, projects);
      logger.info("[cross-mode] Work on this destination inference", {
        decision: inference.kind,
        matchedCount: inference.kind === "ask" ? inference.matchedCount : 1,
      });
      if (inference.kind === "project") {
        const result = await start(
          { kind: "project", project: inference.project },
          confirmation,
          modelSelection,
        );
        if (!result.ok) reportFailure(result.message);
        return;
      }
      if (!tasksAvailable && projects.length === 0) {
        reportFailure(intl.formatMessage({ id: "bot.workOnThis.noProjects" }));
        return;
      }
      setChoice({ confirmation, modelSelection });
    } catch (error) {
      logger.warn("[cross-mode] Work on this failed to prepare", {
        error: error instanceof Error ? error.message : String(error),
      });
      reportFailure(null);
    } finally {
      busyRef.current = false;
      setPreparing(false);
    }
  }, [
    botWorkspacePath,
    conversationRef,
    conversationTitle,
    intl,
    projects,
    reportFailure,
    start,
    tasksAvailable,
    zcodeAgentService,
  ]);

  const handlePick = useCallback(
    async (target: WorkOnThisTarget) => {
      if (!choice || busyRef.current) return;
      busyRef.current = true;
      try {
        const result = await start(target, choice.confirmation, choice.modelSelection);
        if (result.ok) setChoice(null);
        else reportFailure(result.message);
      } finally {
        busyRef.current = false;
      }
    },
    [choice, reportFailure, start],
  );

  return (
    <>
      <ControlHintTooltip title={intl.formatMessage({ id: "bot.workOnThis.hint" })}>
        <Button
          variant="ghost"
          size="sm"
          data-testid="bot-work-on-this"
          disabled={busy}
          onClick={() => void handleWorkOnThis()}
        >
          {busy ? (
            <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden="true" />
          ) : (
            <Hammer data-icon="inline-start" aria-hidden="true" />
          )}
          {intl.formatMessage({ id: "bot.workOnThis.action" })}
        </Button>
      </ControlHintTooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="bot-work-on-this-more"
            disabled={busy}
            aria-label={intl.formatMessage({ id: "bot.workOnThis.more" })}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setReviewOpen(true)}>
            {intl.formatMessage({ id: "bot.workOnThis.review" })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={choice !== null} onOpenChange={(open) => (open ? undefined : setChoice(null))}>
        <DialogContent
          data-testid="bot-work-in-picker"
          className="flex w-[min(360px,calc(100vw-2rem))] max-w-none flex-col gap-3"
        >
          <div className="flex flex-col gap-1">
            <DialogTitle className="text-ui-lg font-medium text-foreground">
              {intl.formatMessage({ id: "bot.workOnThis.pickerTitle" })}
            </DialogTitle>
            <DialogDescription className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "bot.workOnThis.pickerDescription" })}
            </DialogDescription>
          </div>
          <div className="flex flex-col gap-1">
            {tasksAvailable ? (
              <Button
                variant="ghost"
                className="justify-start"
                data-testid="bot-work-in-tasks"
                disabled={pending}
                onClick={() => void handlePick({ kind: "tasks" })}
              >
                <ListTodo data-icon="inline-start" aria-hidden="true" />
                {intl.formatMessage({ id: "bot.workOnThis.tasksTarget" })}
              </Button>
            ) : null}
            {projects.map((project) => (
              <Button
                key={resolveAutomationWorkspaceSelectionKey(project)}
                variant="ghost"
                className="justify-start"
                disabled={pending}
                onClick={() => void handlePick({ kind: "project", project })}
              >
                <FolderGit2 data-icon="inline-start" aria-hidden="true" />
                <span className="truncate">{project.label}</span>
              </Button>
            ))}
          </div>
          {pending ? (
            <p className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "bot.workOnThis.starting" })}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>

      <WorkOnThisDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        botWorkspacePath={botWorkspacePath}
        conversationRef={conversationRef}
        conversationTitle={conversationTitle}
        projects={projects}
        tasksAvailable={tasksAvailable}
        pending={pending}
        onConfirm={(target, confirmation, modelSelection) =>
          start(target, confirmation, modelSelection)
        }
      />
    </>
  );
}
