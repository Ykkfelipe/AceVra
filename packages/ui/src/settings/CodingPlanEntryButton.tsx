import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { resolveCodingPlanEntryPresentation } from "./model-provider-section/codingPlanEntryPresentation.js";

export function useCodingPlanEntryGate() {
  const dialog = useOptionalCodingPlanUpgradeDialog();
  const { intl } = useZCodeIntl();
  const status = dialog?.inventory?.status ?? "ready";
  const label =
    status === "ready"
      ? undefined
      : intl.formatMessage({
          id: status === "loading" ? "purchase.entry.loading" : "purchase.entry.retry",
        });
  return { status, label, retry: dialog?.inventory?.retry };
}

/** 各入口共享同一查询状态；失败时按钮只重试，不继续执行购买动作。 */
export function CodingPlanEntryButton({
  children,
  disabled,
  onClick,
  bypassGate = false,
  quietError = false,
  ...props
}: ComponentProps<typeof Button> & {
  bypassGate?: boolean;
  /**
   * 目录查询失败时保留按钮本来的文案，只做禁用。
   *
   * 默认行为（false）会把整段文案换成“套餐查询失败，重试”，因为购买入口本身无法工作。
   * 但对于「已购套餐卡上的升级/续期」按钮，账号身份与额度来自另一条链路且已经有效，
   * 把主操作整块换成错误文案会让一个正常的账号看起来是坏的。此时改为禁用 + 由调用方
   * 在状态行内提供行内重试提示。
   */
  quietError?: boolean;
}) {
  const gate = useCodingPlanEntryGate();
  const presentation = resolveCodingPlanEntryPresentation(gate.status, {
    bypassGate,
    quietError,
  });
  return (
    <Button
      {...props}
      disabled={disabled || presentation.disabled}
      // 静默失败时按钮保留自身语义（文案、aria-label、title 都不再被错误串替换），
      // 说明与重试由调用方的行内提示承担；此时按钮是禁用的，不会执行购买动作。
      aria-label={presentation.showChildren ? props["aria-label"] : gate.label}
      aria-busy={presentation.status === "loading"}
      title={presentation.showChildren ? props.title : gate.label}
      onClick={(event) => {
        if (presentation.activation === "retry") {
          event.preventDefault();
          event.stopPropagation();
          gate.retry?.();
          return;
        }
        if (presentation.activation === "run") onClick?.(event);
      }}
    >
      {presentation.showChildren ? children : gate.label}
    </Button>
  );
}
