/** Codex account quota in the composer. The host account service remains the only source of truth. */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { AccountBridgeStatus } from "@zcode/shared";
import { Loader2Icon } from "lucide-react";
import { UsageRing } from "@/components/UsageRing.js";
import { Button } from "@/components/ui/button.js";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card.js";
import { useAccountsService } from "@/hooks/useAccountsService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { readAccountStatusWithDeadline } from "@/lib/accountStatusRequest.js";
import {
  formatQuotaResetTime,
  formatRemainingPercentage,
} from "@/lib/codingPlanQuotaPresentation.js";
import {
  resolveCodexUsageWindowLabel,
  resolveCodexUsageWindows,
  resolveUsageBlockedLabelId,
} from "@/settings/account-bridge/accountBridgePresentation.js";

const USAGE_WINDOW_COLOR = "var(--color-usage-chart-1)";

function CodexComposerUsageImpl() {
  const accountsService = useAccountsService();
  const { intl, locale } = useZCodeIntl();
  const [status, setStatus] = useState<AccountBridgeStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(false);
  const requestSequence = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setRefreshing(true);
    const next = await readAccountStatusWithDeadline("codex", () =>
      accountsService.readAccountStatus("codex"),
    );
    // 账号响应可能跨越后端/任务切换；过期结果绝不能覆盖新的 Composer 快照。
    if (requestSequence.current === sequence) {
      setStatus(next);
      setRefreshing(false);
    }
  }, [accountsService]);

  useEffect(() => {
    void refresh();
    return () => {
      requestSequence.current += 1;
    };
  }, [refresh]);

  const onOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen) void refresh();
    },
    [refresh],
  );

  const windows = resolveCodexUsageWindows(status?.usage);
  const primaryWindow = windows[0];
  const usageBlocked = status?.usage?.ordinaryUsageAllowed === false;

  return (
    <HoverCard open={open} onOpenChange={onOpenChange} closeDelay={0} openDelay={0}>
      <HoverCardTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          className="shrink-0 text-foreground-subtle"
          aria-label={intl.formatMessage({ id: "chat.toolbar.backend.codex.usage.label" })}
          data-chat-toolbar-popover-trigger="true"
          data-testid="v4-composer-codex-usage-trigger"
          onPointerDown={(event) => {
            // 与 Agent 的用量轮一致：触屏没有 hover，pointerdown 直接打开同一面板。
            if (
              event.pointerType === "touch" &&
              typeof window !== "undefined" &&
              window.matchMedia?.("(hover: none)").matches &&
              !open
            ) {
              onOpenChange(true);
            }
          }}
        >
          <span style={{ color: primaryWindow ? USAGE_WINDOW_COLOR : undefined }}>
            <UsageRing percent={(primaryWindow?.remainingPercent ?? 0) / 100} />
          </span>
        </Button>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        sideOffset={2}
        className="!w-80 max-w-[calc(100vw-1rem)] space-y-2 !rounded-xl border border-border bg-tooltip p-3 text-tooltip-foreground !shadow-md"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-ui-base font-medium">
            {intl.formatMessage({ id: "sidebar.usage.plan.title" })}
          </span>
          {refreshing ? (
            <Loader2Icon
              className="size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : null}
        </div>
        {usageBlocked ? (
          <p className="text-ui-sm text-warning">
            {intl.formatMessage({ id: resolveUsageBlockedLabelId(status?.usage?.blockedReason) })}
          </p>
        ) : null}
        {windows.length > 0 ? (
          <div className="space-y-2">
            {windows.map((usageWindow) => {
              const label = resolveCodexUsageWindowLabel(usageWindow.windowDurationMins);
              const resetTime = formatQuotaResetTime({
                locale,
                value: usageWindow.resetsAt ? Date.parse(usageWindow.resetsAt) : null,
                format: "dateTime",
                compactToday: true,
              });
              return (
                <div
                  key={usageWindow.key}
                  data-testid={`v4-composer-codex-usage-window-${usageWindow.key}`}
                  className="space-y-1.5 rounded-md border border-border bg-surface p-2"
                >
                  <div className="flex min-w-0 items-center justify-between gap-2 text-ui-sm">
                    <span className="min-w-0 truncate text-foreground-subtle">
                      {intl.formatMessage({ id: label.id }, label.values)}
                    </span>
                    <span className="shrink-0 font-mono text-foreground">
                      {formatRemainingPercentage(locale, usageWindow.remainingPercent)}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface-hover">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${usageWindow.remainingPercent}%`,
                        backgroundColor: USAGE_WINDOW_COLOR,
                      }}
                    />
                  </div>
                  {resetTime ? (
                    <p className="text-ui-xs text-foreground-subtle">{resetTime}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({
              id: status ? "settings.accounts.usage.unavailable" : "common.loading",
            })}
          </p>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

export const CodexComposerUsage = memo(CodexComposerUsageImpl);
