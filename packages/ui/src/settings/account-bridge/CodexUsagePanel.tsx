/**
 * Codex included-usage windows.
 *
 * Renders the same shapes the Z.ai quota cards use (`settings.usage.quotaTitle`, the shipped
 * "5-hour remaining" / "Weekly remaining" labels, the same value + reset line and the same
 * 1.5px progress bar) so Codex usage reads as part of ZCode rather than a second design.
 *
 * It never estimates: a window is rendered only when Codex reported a used percentage for it,
 * and a reset time only when Codex reported one. When nothing usable is reported the panel
 * says so instead of drawing an empty bar.
 */
import type { AccountBridgeStatus, AccountBridgeUsage } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatQuotaResetTime,
  formatRemainingPercentage,
} from "@/lib/codingPlanQuotaPresentation.js";
import {
  resolveCodexUsageWindowLabel,
  resolveCodexUsageWindows,
  resolveUsageBlockedLabelId,
  type CodexUsageWindowView,
} from "@/settings/account-bridge/accountBridgePresentation.js";

/** Matches the Coding Plan usage summary palette so both surfaces share one visual language. */
const USAGE_WINDOW_COLOR = "var(--color-usage-chart-1)";

export function CodexUsagePanel({ status }: { status?: AccountBridgeStatus }) {
  const { intl } = useZCodeIntl();
  if (!status) {
    // 尚无快照：不能提前断言“没有可用量”，否则首帧会给出一个还没查询过的结论。
    return (
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "common.loading" })}
      </p>
    );
  }
  if (status.sourceSignInChecked !== true) {
    // 未查询过 Codex 账号（桥接未启用）：同样不下结论，等用户连接后再展示。
    return null;
  }

  const usage: AccountBridgeUsage | undefined = status.usage;
  const windows = resolveCodexUsageWindows(usage);
  const usageBlocked = usage?.ordinaryUsageAllowed === false;

  if (windows.length === 0 && !usageBlocked) {
    return (
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.accounts.usage.unavailable" })}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <h4 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.quotaTitle" })}
        </h4>
      </div>
      {usageBlocked ? (
        // 后端明确下发的权限位，不能用百分比或重置时间反推恢复。
        <p className="flex w-fit items-center gap-1.5 text-ui-base text-warning">
          <span>
            {intl.formatMessage({ id: resolveUsageBlockedLabelId(usage?.blockedReason) })}
          </span>
        </p>
      ) : null}
      {windows.length > 0 ? (
        <div className="flex w-full gap-2 max-sm:flex-col">
          {windows.map((window) => (
            <UsageWindowCard key={window.key} window={window} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function UsageWindowCard({ window }: { window: CodexUsageWindowView }) {
  const { intl, locale } = useZCodeIntl();
  const label = resolveCodexUsageWindowLabel(window.windowDurationMins);
  const remainingPercent = window.remainingPercent;
  const resetTime = formatQuotaResetTime({
    locale,
    value: window.resetsAt ? Date.parse(window.resetsAt) : null,
    format: "dateTime",
    compactToday: true,
  });

  return (
    <div className="min-w-0 flex-1 rounded-lg bg-surface p-3">
      <div className="flex min-h-6 min-w-0 items-center gap-1">
        <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: label.id }, label.values)}
        </span>
      </div>
      <div className="mt-2 flex min-w-0 items-baseline gap-1.5">
        <span className="text-ui-lg font-semibold leading-none text-foreground">
          {formatRemainingPercentage(locale, remainingPercent)}
        </span>
        {resetTime ? (
          <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">{resetTime}</span>
        ) : null}
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{ width: `${remainingPercent}%`, backgroundColor: USAGE_WINDOW_COLOR }}
        />
      </div>
    </div>
  );
}
