/**
 * 会话顶部的 Cross-Mode 来源提示：「Started from Ace」+ objective +「Continue with Ace」。
 *
 * 数据只来自 `snapshot.crossModeOrigin`（CLI 从 `v4/cross_mode_origin` 投影，重启后仍在）；
 * 回链能力由壳层经 CrossModeOriginNavigation 注入，本组件不认识 Bot 的实现。
 */
import { memo } from "react";
import { ArrowLeftRight } from "lucide-react";
import type { CrossModeOriginState } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useCrossModeOriginNavigation } from "@/crossMode/CrossModeOriginNavigation.js";

export const CrossModeOriginNotice = memo(function CrossModeOriginNotice({
  origin,
}: {
  origin: CrossModeOriginState;
}) {
  const { intl } = useZCodeIntl();
  const navigation = useCrossModeOriginNavigation();
  const canOpen = navigation?.canOpenOrigin(origin) ?? false;
  const fromBot = origin.sourceMode === "bot";
  return (
    <div
      data-testid="cross-mode-origin-notice"
      data-handoff-id={origin.handoffId}
      className="mb-4 flex w-full items-start gap-3 rounded-lg border border-border bg-surface px-3 py-2.5"
    >
      <ArrowLeftRight
        className="mt-0.5 size-4 shrink-0 text-foreground-subtle"
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-ui-xs font-medium text-foreground-subtle">
          {intl.formatMessage({
            id: fromBot ? "crossMode.origin.fromBot" : "crossMode.origin.fromOther",
          })}
        </span>
        <span className="line-clamp-2 text-ui-sm break-words text-foreground">
          {origin.objective}
        </span>
      </div>
      {canOpen && navigation ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          data-testid="cross-mode-origin-open"
          onClick={() => navigation.openOrigin(origin)}
        >
          {intl.formatMessage({ id: "crossMode.origin.continueWithAce" })}
        </Button>
      ) : null}
    </div>
  );
});
