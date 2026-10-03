/**
 * 全局导航栏（docs/specs/personal-bot.md §16.1）。
 *
 * 规则：全局导航保持全局，二级工作区导航随目的地整体切换。本栏只承载顶层目的地
 * （Coding、Bot、Search、Automations、Plugins）与底部的账户/设置，并且只派发既有处理函数，
 * 不引入新的导航状态。Bot 入口仅在 IBotService 存在时出现（M1 规则不变）。
 */
import type { ComponentType } from "react";
import type { UserInfo } from "@zcode/shared";
import { TID_AUTOMATIONS_OPEN } from "@zcode/shared";
import { Blocks, Bot, CalendarClock, Code2, Search } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import type { Theme } from "@/useTheme.js";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import { useWorkspaceSidebarFooterControls } from "@/hooks/useWorkspaceSidebarFooterControls.js";

export type GlobalNavDestination = "coding" | "bot" | "automations" | "plugin-store";

/** 全局导航栏宽度；同时写入 `--workspace-global-rail-width`，供顶部浮层与主区留白扣除。 */
export const GLOBAL_NAV_RAIL_WIDTH_PX = 52;

function RailButton({
  label,
  shortcut,
  icon: Icon,
  active = false,
  testId,
  onClick,
}: {
  label: string;
  shortcut?: string;
  icon: ComponentType<{ className?: string }>;
  active?: boolean;
  testId?: string;
  onClick: () => void;
}) {
  return (
    <ControlHintTooltip title={label} shortcut={shortcut} side="right">
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        data-testid={testId}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        // 不把 click 事件透传：既有处理函数（如 handleOpenAutomations(automationId?)）会把它当参数。
        onClick={() => onClick()}
        className={cn(
          active
            ? "bg-selected text-foreground hover:bg-selected"
            : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
        )}
      >
        <Icon className="size-4" />
      </Button>
    </ControlHintTooltip>
  );
}

interface GlobalNavRailProps {
  activeDestination: GlobalNavDestination;
  onOpenCoding: () => void;
  /** 缺省 = Bot 服务不可用，隐藏入口。 */
  onOpenBot?: () => void;
  onOpenSearch: () => void;
  onOpenAutomations: () => void;
  onOpenPluginStore: () => void;
  theme: Theme;
  user?: UserInfo | null;
  onLogin?: () => void;
  onLogout?: () => void;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  activeTaskId?: string | null;
  isDesktop?: boolean;
  className?: string;
}

export function GlobalNavRail({
  activeDestination,
  onOpenCoding,
  onOpenBot,
  onOpenSearch,
  onOpenAutomations,
  onOpenPluginStore,
  theme,
  user,
  onLogin,
  onLogout,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  activeTaskId,
  isDesktop = false,
  className,
}: GlobalNavRailProps) {
  const { intl } = useZCodeIntl();
  const footerControls = useWorkspaceSidebarFooterControls();
  const commandCenterShortcutLabel = useShortcutCommandLabel("openCommandCenter");

  return (
    <nav
      data-testid="global-nav-rail"
      aria-label={intl.formatMessage({ id: "globalNav.label" })}
      className={cn(
        "flex h-full w-[var(--workspace-global-rail-width)] flex-none flex-col items-center overflow-hidden select-none",
        className,
      )}
    >
      {/* 顶部窗口拖拽带：红绿灯与侧栏开关/前进后退浮层叠在这一带，图标从其下方开始。 */}
      <div className="h-12 w-full shrink-0 [app-region:drag]" />
      <div className="flex flex-col items-center gap-1 pt-3">
        <RailButton
          label={intl.formatMessage({ id: "globalNav.coding" })}
          icon={Code2}
          active={activeDestination === "coding"}
          testId="global-nav-coding"
          onClick={onOpenCoding}
        />
        {onOpenBot ? (
          <RailButton
            label={intl.formatMessage({ id: "bot.nav.open" })}
            icon={Bot}
            active={activeDestination === "bot"}
            testId="bot-sidebar-open"
            onClick={onOpenBot}
          />
        ) : null}
        <RailButton
          label={intl.formatMessage({ id: "commandCenter.open" })}
          shortcut={commandCenterShortcutLabel}
          icon={Search}
          testId="global-nav-search"
          onClick={onOpenSearch}
        />
        <RailButton
          label={intl.formatMessage({ id: "workspace.openScheduledSettings" })}
          icon={CalendarClock}
          active={activeDestination === "automations"}
          testId={TID_AUTOMATIONS_OPEN}
          onClick={onOpenAutomations}
        />
        <RailButton
          label={intl.formatMessage({ id: "workspace.openPluginsSettings" })}
          icon={Blocks}
          active={activeDestination === "plugin-store"}
          testId="plugin-store-sidebar-open"
          onClick={onOpenPluginStore}
        />
      </div>
      <div className="min-h-0 flex-1" />
      <WorkspaceSidebarFooter
        layout="rail"
        theme={theme}
        {...footerControls}
        onLogin={onLogin}
        onLogout={onLogout}
        user={user}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        workspaceRemoteSessionId={workspaceRemoteSessionId}
        activeTaskId={activeTaskId}
        isDesktop={isDesktop}
      />
    </nav>
  );
}
