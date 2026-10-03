/**
 * Personal Bot 主视图：一个持续的 Ace 对话空间，而不是一次 coding session。
 *
 * 结构（docs/specs/personal-bot.md §16）：对话是绝对主区域（BotConversation 复用既有单 pane
 * 会话栈），顶部只留一条窄的 Ace 身份/对话标题条，右侧是 Memory / Computers / Capabilities
 * 上下文检查器。Coding 的 WorkspaceHeader（项目、git、终端、侧面板开关）不进入这个视图。
 *
 * 状态全部来自 BotWorkspaceProvider；本组件只持有「检查器是否展开」这一项每位用户的界面偏好。
 */
import { useCallback, useState, type CSSProperties } from "react";
import { PanelRightClose, PanelRightOpen, RefreshCw } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { BotConversation } from "@/bot/BotConversation.js";
import { BotInspector } from "@/bot/BotInspector.js";
import { botAvatarInitial } from "@/bot/BotConversationSidebar.js";
import { useBotWorkspace } from "@/bot/BotWorkspaceProvider.js";

const INSPECTOR_OPEN_STORAGE_KEY = "zcode:bot:inspector-open";
/**
 * 侧栏收起时顶部浮层（红绿灯 + 侧栏开关 + 前进/后退）压在主区左上角，与 WorkspaceHeader 的
 * pl-58 / pl-38 同源；主区左侧已有全局导航栏，所以扣掉栏宽。
 */
const MAC_LEADING_OVERLAY_PX = 232;
const COMPACT_LEADING_OVERLAY_PX = 152;

function readInspectorOpen(): boolean {
  try {
    return window.localStorage.getItem(INSPECTOR_OPEN_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeInspectorOpen(open: boolean): void {
  try {
    window.localStorage.setItem(INSPECTOR_OPEN_STORAGE_KEY, String(open));
  } catch {
    // 本地存储不可用（隐私模式等）时只是不记忆偏好。
  }
}

interface BotSectionProps {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isMacFullscreen?: boolean;
  isWindowsDesktop?: boolean;
  /** 二级侧栏收起时，为左上角浮层让位。 */
  reserveLeadingWindowControls?: boolean;
}

export function BotSection({
  isDesktop = false,
  isMacDesktop = false,
  isMacFullscreen = false,
  isWindowsDesktop = false,
  reserveLeadingWindowControls = false,
}: BotSectionProps) {
  const { intl } = useZCodeIntl();
  const { available, home, rows, selectedSessionId, refreshHistory } = useBotWorkspace();
  const [inspectorOpen, setInspectorOpen] = useState(readInspectorOpen);
  const usesInlineWindowControls = Boolean(isWindowsDesktop || (isDesktop && !isMacDesktop));

  const toggleInspector = useCallback(() => {
    const next = !inspectorOpen;
    setInspectorOpen(next);
    writeInspectorOpen(next);
  }, [inspectorOpen]);

  const handleRefresh = useCallback(() => {
    void home.refresh();
    refreshHistory();
  }, [home, refreshHistory]);

  if (!available) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-background px-6">
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "bot.unavailable" })}
        </p>
      </div>
    );
  }

  const displayName =
    home.identity?.profile.displayName || intl.formatMessage({ id: "bot.fallbackName" });
  const selectedRow = selectedSessionId
    ? rows.find((row) => row.sessionId === selectedSessionId)
    : undefined;
  const conversationTitle =
    selectedRow?.title || intl.formatMessage({ id: "bot.header.newConversation" });
  const leadingOverlayPx =
    isMacDesktop && !isMacFullscreen ? MAC_LEADING_OVERLAY_PX : COMPACT_LEADING_OVERLAY_PX;
  const headerStyle: CSSProperties | undefined =
    isDesktop && reserveLeadingWindowControls
      ? {
          paddingLeft: `calc(${leadingOverlayPx}px - var(--workspace-global-rail-width, 0px))`,
        }
      : undefined;
  const inspectorToggleLabel = intl.formatMessage({
    id: inspectorOpen ? "bot.header.hideInspector" : "bot.header.showInspector",
  });

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background" data-testid="bot-section">
      <header
        style={headerStyle}
        className={cn(
          "flex h-12 shrink-0 items-center gap-2 border-b border-border pl-4",
          usesInlineWindowControls ? "pr-0" : "pr-3",
          isDesktop && "[app-region:drag]",
        )}
      >
        <Avatar size="sm">
          <AvatarFallback>{botAvatarInitial(displayName)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-ui-base font-medium text-foreground">{displayName}</span>
          <span aria-hidden className="shrink-0 text-ui-sm text-foreground-subtlest">
            /
          </span>
          <h1
            className="min-w-0 truncate text-ui-base text-foreground-subtle"
            data-testid="bot-conversation-title"
          >
            {conversationTitle}
          </h1>
        </div>
        {/* 预留给后续显式的「Work on this」交接动作（Cross-Mode）；V2 不渲染任何内容。 */}
        <div
          data-testid="bot-conversation-actions"
          className="flex shrink-0 items-center gap-1 [app-region:no-drag]"
        />
        <div className="flex shrink-0 items-center gap-1 [app-region:no-drag]">
          <ControlHintTooltip title={intl.formatMessage({ id: "bot.refresh" })}>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleRefresh}
              aria-label={intl.formatMessage({ id: "bot.refresh" })}
            >
              <RefreshCw className="size-4" />
            </Button>
          </ControlHintTooltip>
          <ControlHintTooltip title={inspectorToggleLabel}>
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="bot-inspector-toggle"
              aria-pressed={inspectorOpen}
              onClick={toggleInspector}
              aria-label={inspectorToggleLabel}
            >
              {inspectorOpen ? (
                <PanelRightClose className="size-4" />
              ) : (
                <PanelRightOpen className="size-4" />
              )}
            </Button>
          </ControlHintTooltip>
          {usesInlineWindowControls ? <DesktopWindowControls /> : null}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* 对话是主区域：始终渲染，不因检查器数据加载状态而延迟。 */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <BotConversation isDesktop={isDesktop} />
        </div>
        {inspectorOpen ? <BotInspector /> : null}
      </div>
    </div>
  );
}
