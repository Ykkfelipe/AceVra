// Computer Use composer surface: only the screen takeover approval card.
//
// 产品决定（Felipe，installed d825c492 验收后）：常驻的 "Computer Use · Observing · Control…"
// 状态条在任何状态下都不再渲染。后台工作由 mini Computer 预览呈现；屏幕接管期间由全屏发光层 +
// 提示条承担安全提示（Esc/移动鼠标即收回控制，composer 的停止按钮仍可用）。唯一保留的是
// Allow/Deny 授权卡：同意门必须有可见入口。
import { useState } from "react";
import { MonitorUpIcon } from "lucide-react";
import {
  TID_V4_COMPUTER_USE_BAR_TAKEOVER,
  TID_V4_COMPUTER_USE_BAR_TAKEOVER_ALLOW,
  TID_V4_COMPUTER_USE_BAR_TAKEOVER_DENY,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { UseComputerUseSessionResult } from "@/hooks/useComputerUseSession.js";

export interface ComputerUseBarProps {
  /** The shared `useComputerUseSession` poll hoisted by the composer. */
  session: UseComputerUseSessionResult;
}

/** Renders the takeover approval card while the agent waits for Allow / Deny; otherwise nothing. */
export function ComputerUseBar(props: ComputerUseBarProps) {
  const { session } = props;
  if (!session.view.takeoverPending) return null;
  return <ComputerUseTakeoverCard session={session} />;
}

/**
 * Screen takeover approval (zcode-cua specs "Screen takeover"): the agent asked for the user's
 * screen and waits. The decision is written through the UI-owned service API only.
 */
export function ComputerUseTakeoverCard(props: { session: UseComputerUseSessionResult }) {
  const { session } = props;
  const { intl } = useZCodeIntl();
  const [answered, setAnswered] = useState(false);
  const decide = (decision: "allow" | "deny"): void => {
    if (answered) return;
    setAnswered(true);
    session.decideTakeover(decision);
  };
  return (
    <div
      data-testid={TID_V4_COMPUTER_USE_BAR_TAKEOVER}
      role="alertdialog"
      aria-label={intl.formatMessage({ id: "chat.computerUseBar.takeover.title" })}
      className="mb-2 flex w-full items-start gap-3 rounded-lg border border-[var(--color-primary)] bg-surface px-3 py-2.5 text-ui-base text-foreground"
    >
      <MonitorUpIcon className="mt-0.5 size-4 shrink-0 text-[var(--color-primary)]" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium">
          {intl.formatMessage({ id: "chat.computerUseBar.takeover.title" })}
        </span>
        <span className="opacity-80">
          {intl.formatMessage({ id: "chat.computerUseBar.takeover.body" })}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={TID_V4_COMPUTER_USE_BAR_TAKEOVER_DENY}
          disabled={answered}
          onClick={() => decide("deny")}
        >
          {intl.formatMessage({ id: "chat.computerUseBar.takeover.deny" })}
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid={TID_V4_COMPUTER_USE_BAR_TAKEOVER_ALLOW}
          disabled={answered}
          onClick={() => decide("allow")}
        >
          {intl.formatMessage({ id: "chat.computerUseBar.takeover.allow" })}
        </Button>
      </div>
    </div>
  );
}
