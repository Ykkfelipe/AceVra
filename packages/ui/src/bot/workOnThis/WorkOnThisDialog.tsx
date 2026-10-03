/**
 * Bot → Coding「Work on this」预览/确认对话框（docs/specs/cross-mode-bot-to-coding.md §2）。
 *
 * 数据面全部来自冻结契约：草稿用 createHandoffPacket 构建，展示用 buildHandoffPreviewViewModel，
 * 勾选用 setHandoffContextItemIncluded，确认用 confirmHandoffPreview——本组件不重算任何上限或规则。
 * 只持有对话框内的编辑态（项目、objective、备注、摘录勾选）；关闭即丢弃。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import {
  beginHandoffPreview,
  buildHandoffPreviewViewModel,
  confirmHandoffPreview,
  setHandoffContextItemIncluded,
  type HandoffConfirmation,
  type HandoffContextItem,
  type HandoffObjectRef,
} from "@zcode/shared/cross-mode";
import { uuidv7 } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConversationRowsSnapshot } from "@/hooks/useConversationRowsSnapshot.js";
import { logger } from "@/logger.js";
import {
  buildExcerptContextItems,
  defaultHandoffObjective,
  extractBotConversationExcerpts,
  tryBuildBotCodingHandoffDraft,
} from "@/bot/workOnThis/botCodingHandoffDraft.js";
import {
  resolveAutomationWorkspaceSelectionKey,
  type AutomationWorkspaceOption,
} from "@/settings/automationWorkspaceOptions.js";

type ExcerptStatus = "loading" | "ready" | "error";

export interface WorkOnThisDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Bot 工作区路径（读取本对话 transcript 用）。 */
  botWorkspacePath: string;
  conversationRef: HandoffObjectRef;
  conversationTitle: string | null;
  projects: readonly AutomationWorkspaceOption[];
  pending: boolean;
  onConfirm: (
    project: AutomationWorkspaceOption,
    confirmation: HandoffConfirmation,
  ) => Promise<{ ok: true } | { ok: false; message: string | null }>;
}

export function WorkOnThisDialog(props: WorkOnThisDialogProps) {
  // 每次打开都是一个新的预览会话（新 handoffId），关闭即丢弃编辑态。
  return props.open ? <WorkOnThisDialogBody {...props} /> : null;
}

function WorkOnThisDialogBody({
  open,
  onOpenChange,
  botWorkspacePath,
  conversationRef,
  conversationTitle,
  projects,
  pending,
  onConfirm,
}: WorkOnThisDialogProps) {
  const { intl } = useZCodeIntl();
  const [identity] = useState(() => ({ handoffId: uuidv7(), createdAt: Date.now() }));
  const [projectKey, setProjectKey] = useState<string | null>(() => {
    const first = projects[0];
    return first ? resolveAutomationWorkspaceSelectionKey(first) : null;
  });
  const [objective, setObjective] = useState(() => defaultHandoffObjective(conversationTitle));
  const [notes, setNotes] = useState("");
  const [excerptItems, setExcerptItems] = useState<HandoffContextItem[]>([]);
  const [excerptStatus, setExcerptStatus] = useState<ExcerptStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 只读取**本**对话的可见行（对话面正在渲染的同一份投影）；记忆是 model-only attachment，
  // 不会成为可见行，读不到也带不走。摘录只在首次就绪时生成一次，之后的流式更新不重置勾选。
  const rowsSnapshot = useConversationRowsSnapshot({
    workspacePath: botWorkspacePath,
    sessionId: conversationRef.id,
  });
  const excerptsBuiltRef = useRef(false);
  useEffect(() => {
    if (excerptsBuiltRef.current) return;
    if (rowsSnapshot.status === "error") {
      logger.warn("[bot] 无法读取对话摘录", { error: rowsSnapshot.message });
      setExcerptStatus("error");
      return;
    }
    if (rowsSnapshot.status !== "ready") return;
    excerptsBuiltRef.current = true;
    setExcerptItems(
      buildExcerptContextItems(extractBotConversationExcerpts(rowsSnapshot.rows), conversationRef, {
        excerpt: (role) =>
          intl.formatMessage({
            id: role === "user" ? "bot.workOnThis.excerpt.user" : "bot.workOnThis.excerpt.ace",
          }),
      }),
    );
    setExcerptStatus("ready");
  }, [conversationRef, intl, rowsSnapshot]);

  const project = useMemo(
    () => projects.find((option) => resolveAutomationWorkspaceSelectionKey(option) === projectKey),
    [projectKey, projects],
  );

  const draft = useMemo(
    () =>
      tryBuildBotCodingHandoffDraft({
        conversationRef,
        objective,
        notes,
        notesLabel: intl.formatMessage({ id: "bot.workOnThis.notesLabel" }),
        excerptItems,
        handoffId: identity.handoffId,
        createdAt: identity.createdAt,
      }),
    [conversationRef, excerptItems, identity, intl, notes, objective],
  );
  const preview = useMemo(
    () => (draft.ok ? beginHandoffPreview(draft.packet, identity.createdAt) : null),
    [draft, identity.createdAt],
  );
  const viewModel = useMemo(
    () => (preview ? buildHandoffPreviewViewModel(preview) : null),
    [preview],
  );
  const blockingIssues = viewModel?.issues.filter((issue) => issue.severity === "error") ?? [];
  const objectiveMissing = objective.trim().length === 0;
  const canStart = Boolean(project && preview && viewModel && !viewModel.blocked) && !pending;

  const toggleExcerpt = (itemId: string, included: boolean) => {
    setExcerptItems(
      (current) => setHandoffContextItemIncluded({ context: current }, itemId, included).context,
    );
  };

  const handleStart = async () => {
    if (!project || !preview || !canStart) return;
    const confirmed = confirmHandoffPreview(preview);
    if (!confirmed.ok || !confirmed.session.confirmation) {
      setError(intl.formatMessage({ id: "bot.workOnThis.error.blocked" }));
      return;
    }
    setError(null);
    const result = await onConfirm(project, confirmed.session.confirmation);
    if (!mountedRef.current) return;
    if (result.ok) {
      onOpenChange(false);
      return;
    }
    setError(result.message ?? intl.formatMessage({ id: "bot.workOnThis.error.generic" }));
  };

  const contextPreview = viewModel?.context;

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent
        data-testid="bot-work-on-this-dialog"
        className="flex max-h-[min(720px,calc(100vh-2rem))] w-[min(560px,calc(100vw-2rem))] max-w-none flex-col gap-4"
      >
        <div className="flex flex-col gap-1">
          <DialogTitle className="text-ui-lg font-medium text-foreground">
            {intl.formatMessage({ id: "bot.workOnThis.title" })}
          </DialogTitle>
          <DialogDescription className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "bot.workOnThis.description" })}
          </DialogDescription>
        </div>

        {error ? (
          <div
            role="alert"
            data-testid="bot-work-on-this-error"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-sm break-words text-destructive"
          >
            {error}
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
          <div className="flex flex-col gap-1.5">
            <Label className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "bot.workOnThis.project" })}
            </Label>
            {projects.length === 0 ? (
              <p
                className="text-ui-sm text-foreground-subtle"
                data-testid="bot-work-on-this-no-projects"
              >
                {intl.formatMessage({ id: "bot.workOnThis.noProjects" })}
              </p>
            ) : (
              <Select
                value={projectKey ?? undefined}
                onValueChange={setProjectKey}
                disabled={pending}
              >
                <SelectTrigger data-testid="bot-work-on-this-project">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((option) => {
                    const key = resolveAutomationWorkspaceSelectionKey(option);
                    return (
                      <SelectItem key={key} value={key}>
                        {option.label}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label
              htmlFor="bot-work-on-this-objective"
              className="text-ui-sm text-foreground-subtle"
            >
              {intl.formatMessage({ id: "bot.workOnThis.objective" })}
            </Label>
            <Textarea
              id="bot-work-on-this-objective"
              data-testid="bot-work-on-this-objective"
              rows={2}
              maxLength={500}
              value={objective}
              disabled={pending}
              onChange={(event) => setObjective(event.target.value)}
              placeholder={intl.formatMessage({ id: "bot.workOnThis.objectivePlaceholder" })}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bot-work-on-this-notes" className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "bot.workOnThis.notesLabel" })}
            </Label>
            <Textarea
              id="bot-work-on-this-notes"
              data-testid="bot-work-on-this-notes"
              rows={3}
              value={notes}
              disabled={pending}
              onChange={(event) => setNotes(event.target.value)}
              placeholder={intl.formatMessage({ id: "bot.workOnThis.notesPlaceholder" })}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "bot.workOnThis.context" })}
              </span>
              {contextPreview ? (
                <span
                  className="text-ui-xs text-foreground-subtlest tabular-nums"
                  data-testid="bot-work-on-this-budget"
                >
                  {intl.formatMessage(
                    { id: "bot.workOnThis.budget" },
                    {
                      count: String(contextPreview.includedCount),
                      used: (contextPreview.includedBytes / 1024).toFixed(1),
                      limit: String(contextPreview.limits.maxIncludedTotalBytes / 1024),
                    },
                  )}
                </span>
              ) : null}
            </div>
            {excerptStatus === "loading" ? (
              <p className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                {intl.formatMessage({ id: "bot.workOnThis.excerptsLoading" })}
              </p>
            ) : excerptStatus === "error" ? (
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "bot.workOnThis.excerptsFailed" })}
              </p>
            ) : excerptItems.length === 0 ? (
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "bot.workOnThis.excerptsEmpty" })}
              </p>
            ) : (
              <ul className="flex flex-col gap-1" data-testid="bot-work-on-this-excerpts">
                {excerptItems.map((item) => (
                  <li key={item.id}>
                    <label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-surface-hover">
                      <Checkbox
                        className="mt-0.5"
                        checked={item.included}
                        disabled={pending}
                        onCheckedChange={(checked) => toggleExcerpt(item.id, checked === true)}
                        aria-label={item.label}
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="text-ui-xs font-medium text-foreground-subtle">
                          {item.label}
                        </span>
                        <span className="line-clamp-3 text-ui-sm break-words whitespace-pre-wrap text-foreground">
                          {item.content}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-ui-xs text-foreground-subtlest">
              {intl.formatMessage({ id: "bot.workOnThis.privacyNote" })}
            </p>
          </div>

          {!objectiveMissing && blockingIssues.length > 0 ? (
            <ul
              className="flex flex-col gap-1 text-ui-sm text-destructive"
              data-testid="bot-work-on-this-issues"
            >
              {blockingIssues.map((issue) => (
                <li key={`${issue.code}:${issue.path}`}>{issue.message}</li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "bot.workOnThis.returnsTo" })}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="lg"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              {intl.formatMessage({ id: "bot.workOnThis.cancel" })}
            </Button>
            <Button
              type="button"
              size="lg"
              data-testid="bot-work-on-this-start"
              disabled={!canStart}
              onClick={() => void handleStart()}
            >
              {pending ? (
                <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden="true" />
              ) : (
                <ArrowRight data-icon="inline-start" aria-hidden="true" />
              )}
              {intl.formatMessage({ id: "bot.workOnThis.start" })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
