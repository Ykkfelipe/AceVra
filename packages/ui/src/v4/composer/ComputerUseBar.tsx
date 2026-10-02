// Computer Use composer surface: only the screen takeover approval card.
//
// 产品决定（Felipe，installed d825c492 验收后）：常驻的 "Computer Use · Observing · Control…"
// 状态条在任何状态下都不再渲染。后台工作由 mini Computer 预览呈现；屏幕接管期间由全屏发光层 +
// 提示条承担安全提示（Esc/移动鼠标即收回控制，composer 的停止按钮仍可用）。唯一保留的是
// Allow/Deny 授权卡：同意门必须有可见入口。
//
// 视觉：这张卡走 PermissionDialog 的容器/选项行/键盘模型，不自造一套确认门样式
// （rounded-2xl + bg-popover、编号选项行、Tab/方向键 + Enter、底部品牌色确认按钮）。
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Info, MonitorUpIcon } from "lucide-react";
import {
  TID_V4_COMPUTER_USE_BAR_TAKEOVER,
  TID_V4_COMPUTER_USE_BAR_TAKEOVER_ALLOW,
  TID_V4_COMPUTER_USE_BAR_TAKEOVER_DENY,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
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

type TakeoverDecision = "allow" | "deny";

/**
 * Screen takeover approval (zcode-cua specs "Screen takeover"): the agent asked for the user's
 * screen and waits. The decision is written through the UI-owned service API only.
 */
export function ComputerUseTakeoverCard(props: { session: UseComputerUseSessionResult }) {
  const { session } = props;
  const { intl } = useZCodeIntl();
  const [answered, setAnswered] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const options: TakeoverDecision[] = ["allow", "deny"];
  const decisionAt = (index: number): TakeoverDecision => options[index] ?? "allow";
  const selected = decisionAt(selectedIndex);

  const decide = useCallback(
    (decision: TakeoverDecision): void => {
      if (answered) return;
      setAnswered(true);
      session.decideTakeover(decision);
    },
    [answered, session],
  );

  // 焦点跟随选中项：确认门是键盘优先的，Tab 进来时第一项应当已经可用。
  useEffect(() => {
    optionRefs.current[selectedIndex]?.focus();
  }, [selectedIndex]);

  const moveSelection = useCallback(
    (direction: 1 | -1) => {
      setSelectedIndex((current) => (current + direction + options.length) % options.length);
    },
    [options.length],
  );

  const handleOptionKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "1" || event.key === "2") {
        event.preventDefault();
        const index = Number(event.key) - 1;
        setSelectedIndex(index);
        decide(decisionAt(index));
        return;
      }
      switch (event.key) {
        case "ArrowUp":
        case "ArrowLeft":
          event.preventDefault();
          moveSelection(-1);
          return;
        case "ArrowDown":
        case "ArrowRight":
        case "Tab":
          event.preventDefault();
          moveSelection(event.shiftKey ? -1 : 1);
          return;
        case "Enter":
          event.preventDefault();
          decide(selected);
          return;
        default:
          return;
      }
    },
    [decide, moveSelection, options, selected],
  );

  const title = intl.formatMessage({
    id: "chat.computerUseBar.takeover.title",
  });
  const row = (decision: TakeoverDecision, index: number) => {
    const isSelected = index === selectedIndex;
    return (
      <button
        key={decision}
        data-testid={
          decision === "allow"
            ? TID_V4_COMPUTER_USE_BAR_TAKEOVER_ALLOW
            : TID_V4_COMPUTER_USE_BAR_TAKEOVER_DENY
        }
        ref={(node) => {
          optionRefs.current[index] = node;
        }}
        type="button"
        role="option"
        aria-selected={isSelected}
        aria-label={intl.formatMessage({
          id: `chat.computerUseBar.takeover.${decision}`,
        })}
        tabIndex={isSelected ? 0 : -1}
        disabled={answered}
        onClick={() => {
          setSelectedIndex(index);
          decide(decision);
        }}
        onFocus={() => setSelectedIndex(index)}
        onKeyDown={handleOptionKeyDown}
        className={cn(
          "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left outline-none transition-colors focus-visible:bg-selected disabled:opacity-60",
          isSelected ? "bg-selected" : "hover:bg-hover",
        )}
      >
        <span
          className={cn(
            "w-5 shrink-0 self-center text-ui-base font-medium",
            isSelected ? "text-foreground" : "text-foreground-subtlest",
          )}
        >
          {index + 1}.
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({
              id: `chat.computerUseBar.takeover.${decision}`,
            })}
          </span>
          <span className="text-ui-base leading-4 text-foreground-subtle">
            {intl.formatMessage({
              id: `chat.computerUseBar.takeover.${decision}.description`,
            })}
          </span>
        </span>
      </button>
    );
  };

  return (
    <div className="w-full shrink-0 relative z-1">
      <div
        data-testid={TID_V4_COMPUTER_USE_BAR_TAKEOVER}
        role="alertdialog"
        aria-label={title}
        className="w-full overflow-hidden rounded-2xl border border-border bg-popover shadow-xs"
      >
        <div className="flex flex-col gap-3 p-3">
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <MonitorUpIcon className="size-4 shrink-0 text-foreground-subtle" aria-hidden />
              <p className="text-ui-base font-medium leading-tight text-foreground-subtle">
                {title}
              </p>
            </div>
            <p className="text-ui-base leading-5 text-foreground">
              {intl.formatMessage({ id: "chat.computerUseBar.takeover.body" })}
            </p>
          </div>

          <div role="listbox" aria-label={title} className="space-y-1">
            {options.map((decision, index) => row(decision, index))}
          </div>

          <div className="flex items-center justify-between gap-2 px-1">
            <p className="flex items-center gap-2 text-ui-base text-foreground-subtle">
              <Info className="size-4 shrink-0 text-foreground" aria-hidden />
              {intl.formatMessage({ id: "chat.permission.keyboardHint" })}
            </p>
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "common.confirm" })}
              size="lg"
              disabled={answered}
              onClick={() => decide(selected)}
              className="bg-brand text-foreground-inverse hover:bg-brand/80"
            >
              {intl.formatMessage({ id: "common.confirm" })}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
