/**
 * Bot 工作区的二级侧栏（docs/specs/personal-bot.md §16.1）：替代 Coding 的 Project/Tasks 侧栏。
 *
 * 只渲染 Bot 自己的东西：Ace 身份、「新对话」、按最近活动分组的历史。
 * 数据全部来自 BotWorkspaceProvider（指针 + session store 投影），本组件不持有业务状态。
 */
import { useEffect, useMemo, useState } from "react";
import { MessageCirclePlus, RotateCw } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { TaskTitleOverflowText } from "@/components/TaskTitleOverflowText.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { groupBotConversationRows, type BotConversationRow } from "@/bot/botConversationHistory.js";
import { useBotWorkspace, type BotHistoryStatus } from "@/bot/BotWorkspaceProvider.js";

/** 分组标题依赖「今天」的日界；跨午夜不必实时重算，分钟级刷新足够且不会触发数据读取。 */
const GROUPING_CLOCK_INTERVAL_MS = 60_000;

export function botAvatarInitial(displayName: string): string {
  return displayName.trim().slice(0, 1).toUpperCase() || "A";
}

function useGroupingClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), GROUPING_CLOCK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function ConversationRow({
  row,
  selected,
  onSelect,
}: {
  row: BotConversationRow;
  selected: boolean;
  onSelect: (sessionId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const title = row.title || intl.formatMessage({ id: "bot.sidebar.untitled" });
  return (
    <li>
      <button
        type="button"
        data-testid="bot-conversation-row"
        data-session-id={row.sessionId}
        aria-current={selected ? "page" : undefined}
        onClick={() => onSelect(row.sessionId)}
        className={cn(
          "flex h-8 w-full min-w-0 items-center gap-2 rounded-lg pr-2 pl-2.5 text-left transition-colors",
          selected ? "bg-selected text-foreground" : "text-foreground hover:bg-surface-hover",
        )}
      >
        <TaskTitleOverflowText as="span" className="min-w-0 flex-1 text-ui-base">
          {title}
        </TaskTitleOverflowText>
        <span className="shrink-0 text-ui-xs text-foreground-subtlest">
          {formatTaskRelativeTime(row.updatedAt, intl)}
        </span>
      </button>
    </li>
  );
}

export interface BotConversationSidebarViewProps {
  displayName: string;
  descriptor: string;
  rows: readonly BotConversationRow[];
  historyStatus: BotHistoryStatus;
  selectedSessionId: string | null;
  /** 分组用的「现在」；视图本身不读时钟，便于测试与 SSR。 */
  now: number;
  onSelectConversation: (sessionId: string) => void;
  onNewConversation: () => void;
  onRetry: () => void;
}

/** 绑定 BotWorkspaceProvider 的侧栏。 */
export function BotConversationSidebar() {
  const { intl } = useZCodeIntl();
  const {
    home,
    rows,
    historyStatus,
    selectedSessionId,
    selectConversation,
    startNewConversation,
    refreshHistory,
  } = useBotWorkspace();
  const now = useGroupingClock();
  return (
    <BotConversationSidebarView
      displayName={
        home.identity?.profile.displayName || intl.formatMessage({ id: "bot.fallbackName" })
      }
      descriptor={home.identity?.profile.descriptor ?? ""}
      rows={rows}
      historyStatus={historyStatus}
      selectedSessionId={selectedSessionId}
      now={now}
      onSelectConversation={selectConversation}
      onNewConversation={startNewConversation}
      onRetry={refreshHistory}
    />
  );
}

export function BotConversationSidebarView({
  displayName,
  descriptor,
  rows,
  historyStatus,
  selectedSessionId,
  now,
  onSelectConversation,
  onNewConversation,
  onRetry,
}: BotConversationSidebarViewProps) {
  const { intl } = useZCodeIntl();
  const groups = useMemo(() => groupBotConversationRows(rows, now), [now, rows]);
  const isDraftSelected = selectedSessionId === null;

  return (
    <aside
      data-testid="bot-sidebar"
      aria-label={intl.formatMessage({ id: "bot.sidebar.label" })}
      className="flex h-full min-h-0 flex-col overflow-hidden"
    >
      {/* 与 Coding 侧栏同高的窗口拖拽带：顶部浮层（侧栏开关、前进/后退）叠在这里。 */}
      <div className="h-12 shrink-0 [app-region:drag]" />
      <div className="flex shrink-0 flex-col gap-1 px-2 py-3">
        <div className="flex min-w-0 items-center gap-2 px-2.5 pb-2">
          <Avatar size="sm">
            <AvatarFallback>{botAvatarInitial(displayName)}</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-ui-base font-medium text-foreground">{displayName}</span>
            {descriptor ? (
              <span className="truncate text-ui-sm text-foreground-subtle">{descriptor}</span>
            ) : null}
          </div>
        </div>
        <Button
          variant="ghost"
          size="lg"
          data-icon="inline-start"
          data-testid="bot-new-conversation"
          aria-pressed={isDraftSelected}
          onClick={onNewConversation}
          className={cn(
            "w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground",
            isDraftSelected && "bg-selected",
          )}
        >
          <MessageCirclePlus className="size-4" />
          {intl.formatMessage({ id: "bot.sidebar.newConversation" })}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 pb-4">
        {historyStatus === "error" ? (
          <div className="flex items-center justify-between gap-2 px-2.5 py-1">
            <span className="min-w-0 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "bot.sidebar.loadFailed" })}
            </span>
            <Button variant="ghost" size="sm" onClick={onRetry}>
              <RotateCw className="size-3.5" />
              {intl.formatMessage({ id: "bot.sidebar.retry" })}
            </Button>
          </div>
        ) : null}

        {historyStatus === "loading" && rows.length === 0 ? (
          <div className="flex items-center gap-2 px-2.5 py-1 text-ui-sm text-foreground-subtle">
            <Spinner className="size-3.5" />
            {intl.formatMessage({ id: "bot.sidebar.loading" })}
          </div>
        ) : null}

        {historyStatus === "ready" && rows.length === 0 ? (
          <p className="px-2.5 py-1 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "bot.sidebar.empty" })}
          </p>
        ) : null}

        {groups.map((group) => (
          <section key={group.id} className="flex flex-col gap-0.5" data-bot-group={group.id}>
            <h3 className="px-2.5 pb-0.5 text-ui-sm font-medium text-foreground-subtle">
              {intl.formatMessage({ id: `bot.sidebar.group.${group.id}` })}
            </h3>
            <ul className="flex flex-col gap-0.5">
              {group.rows.map((row) => (
                <ConversationRow
                  key={row.sessionId}
                  row={row}
                  selected={row.sessionId === selectedSessionId}
                  onSelect={onSelectConversation}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}
