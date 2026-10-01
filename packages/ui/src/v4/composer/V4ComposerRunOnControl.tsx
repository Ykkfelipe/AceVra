/**
 * Composer「Run on」次级控件（M2E）。
 *
 * 只读真实 ExecutionTarget（本机 + 已配对节点），选择写入对话级 executionTargetStore；
 * 渲染与打开菜单都不会启动任务或任何捕获。M2F 起选中远端节点时 agent 运行的命令路由到该节点，
 * 文件与 Computer 工具仍在本机，菜单如实说明这一边界。
 */
import { memo, useState } from "react";
import { ChevronDownIcon, ServerIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useExecutionTargets } from "@/hooks/useExecutionTargets.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildTargetOptions,
  resolveSelectedTarget,
  type TargetOptionView,
} from "@/account/executionPresentation.js";
import { AUTO_TARGET, useExecutionTargetStore } from "@/store/executionTargetStore.js";
import { COMPOSER_TOOLBAR_TRIGGER_CLASS } from "@/v4/composer/composerToolbarPresentation.js";

interface V4ComposerRunOnControlProps {
  scopeKey: string;
  disabled?: boolean;
}

function V4ComposerRunOnControlImpl(props: V4ComposerRunOnControlProps) {
  // 没有桌面账号桥（Web / 手机远控 / 组件级测试）时连内层都不挂载，不建立任何轮询。
  if (!useOptionalPlatform()?.account) return null;
  return <RunOnControlMounted {...props} />;
}

function RunOnControlMounted({ scopeKey, disabled = false }: V4ComposerRunOnControlProps) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string>) =>
    intl.formatMessage({ id: `acevra.execution.${id}` }, values);
  const { targets, refresh } = useExecutionTargets();
  const selection = useExecutionTargetStore((state) => state.selectionByScope[scopeKey]);
  const select = useExecutionTargetStore((state) => state.select);
  const [open, setOpen] = useState(false);
  const current = selection ?? AUTO_TARGET;
  const selected = resolveSelectedTarget(current, targets);
  const options = targets ? buildTargetOptions(targets) : [];
  const statusLabel = (option: TargetOptionView) =>
    option.status === "offline"
      ? t("target.offline")
      : option.status === "cannotRun"
        ? t("target.cannotRun")
        : null;
  const triggerName =
    selected.kind === "target"
      ? selected.option.label
      : selected.kind === "missing"
        ? t("target.missing")
        : selected.kind === "loading"
          ? t("target.loading")
          : t("automatic");
  const triggerWarning =
    selected.kind === "missing" || (selected.kind === "target" && selected.option.disabled);
  const remoteSelected = selected.kind === "target" && !selected.option.isThisDevice;
  const label = t("runOnValue", { target: triggerName });

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void refresh();
      }}
    >
      <ControlHintTooltip title={label} open={open ? false : undefined}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            data-testid="v4-composer-run-on"
            data-run-on={current}
            data-composer-collapse-priority="1"
            aria-label={label}
            aria-haspopup="menu"
            className={cn(
              "group/runon gap-1 p-0 @xl/composer:w-auto @xl/composer:px-2 data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0",
              COMPOSER_TOOLBAR_TRIGGER_CLASS,
              "text-foreground-subtle",
              triggerWarning && "text-warning hover:text-warning",
            )}
          >
            <ServerIcon className="size-4 shrink-0" aria-hidden />
            <span className="hidden max-w-40 truncate @xl/composer:inline group-data-[composer-compact=true]/runon:hidden">
              {label}
            </span>
            <ChevronDownIcon className="hidden size-3.5 @xl/composer:block group-data-[composer-compact=true]/runon:hidden" />
          </Button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={4}
        className="w-64"
        data-testid="v4-composer-run-on-menu"
      >
        <DropdownMenuRadioGroup value={current} onValueChange={(value) => select(scopeKey, value)}>
          <DropdownMenuRadioItem
            value={AUTO_TARGET}
            data-testid="v4-composer-run-on-option"
            data-target-id={AUTO_TARGET}
            className="min-h-13 items-start py-2"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span>{t("automatic")}</span>
              <span className="text-ui-sm text-foreground-subtle">{t("automaticDescription")}</span>
            </span>
          </DropdownMenuRadioItem>
          {options.length > 0 && <DropdownMenuSeparator />}
          {options.map((option) => {
            const status = statusLabel(option);
            return (
              <DropdownMenuRadioItem
                key={option.id}
                value={option.id}
                disabled={option.disabled}
                data-testid="v4-composer-run-on-option"
                data-target-id={option.id}
                data-target-status={option.status}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate">{option.label}</span>
                  {option.isThisDevice && (
                    <span className="shrink-0 text-ui-sm text-foreground-subtle">
                      {t("target.thisDevice")}
                    </span>
                  )}
                  {status && (
                    <span className="ml-auto shrink-0 text-ui-sm text-foreground-subtle">
                      {status}
                    </span>
                  )}
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
        {remoteSelected && (
          <>
            <DropdownMenuSeparator />
            <RunOnRemoteCaption targetName={triggerName} />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Truthful routing boundary for a remote selection: commands go to the node, the rest stays. */
export function RunOnRemoteCaption({ targetName }: { targetName: string }) {
  const { intl } = useZCodeIntl();
  return (
    <p
      className="px-2 py-1.5 text-ui-sm text-foreground-subtle"
      data-testid="v4-composer-run-on-gap"
    >
      {intl.formatMessage({ id: "acevra.execution.agentCommandsOnTarget" }, { target: targetName })}
    </p>
  );
}

export const V4ComposerRunOnControl = memo(V4ComposerRunOnControlImpl);
