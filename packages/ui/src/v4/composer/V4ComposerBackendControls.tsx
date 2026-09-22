// 新任务的执行后端选择器（Agent：ZCode | Codex）。
// 只作用于 draft（新任务）；既定任务的后端不可切换。与 mode/model 开关同构：
// ghost 按钮 + DropdownMenuRadioGroup，仅编辑 Renderer 草稿意图，不发运行时命令。
import { memo } from "react";
import { BotIcon, ChevronDownIcon, SparklesIcon } from "lucide-react";
import { testId, type ZCodeExecutionBackend } from "@zcode/shared";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import type { V4ComposerConfigPicker } from "@/v4/composer/configPickerState.js";

const BACKEND_OPTIONS: ReadonlyArray<{
  value: ZCodeExecutionBackend;
  labelId: string;
  descriptionId: string;
  Icon: typeof BotIcon;
}> = [
  {
    value: "zcode",
    labelId: "chat.toolbar.backend.zcode.label",
    descriptionId: "chat.toolbar.backend.zcode.description",
    Icon: SparklesIcon,
  },
  {
    value: "codex",
    labelId: "chat.toolbar.backend.codex.label",
    descriptionId: "chat.toolbar.backend.codex.description",
    Icon: BotIcon,
  },
];

function V4ComposerBackendSwitchImpl({
  backend,
  codexAvailable,
  disabled,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSwitchBackend,
}: {
  backend: ZCodeExecutionBackend;
  /** host 未注册 codex-execution 服务或 Codex 未安装时为 false，菜单项禁用。 */
  codexAvailable: boolean;
  disabled?: boolean;
  activeConfigPicker: V4ComposerConfigPicker | null;
  onConfigPickerOpenChange: (picker: V4ComposerConfigPicker, open: boolean) => void;
  onSwitchBackend: (backend: ZCodeExecutionBackend) => void;
}) {
  const { intl } = useZCodeIntl();
  const selected = BACKEND_OPTIONS.find((option) => option.value === backend) ?? BACKEND_OPTIONS[0]!;
  return (
    <DropdownMenu
      open={activeConfigPicker === "backend"}
      onOpenChange={(open) => onConfigPickerOpenChange("backend", open)}
    >
      <ControlHintTooltip
        title={intl.formatMessage({ id: "chat.toolbar.backend.label" })}
        open={activeConfigPicker === "backend" ? false : undefined}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            data-testid="v4-composer-backend-select-trigger"
            data-composer-collapse-priority="1"
            aria-label={intl.formatMessage({ id: "chat.toolbar.backend.label" })}
            className={cn(
              "group/backend size-7 gap-1 rounded-lg p-0 text-ui-base @xl/composer:w-auto @xl/composer:px-2 data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0",
            )}
          >
            <selected.Icon className="size-4" />
            <span className="hidden @xl/composer:inline group-data-[composer-compact=true]/backend:hidden">
              {intl.formatMessage({ id: selected.labelId })}
            </span>
            <ChevronDownIcon className="hidden size-3.5 @xl/composer:block group-data-[composer-compact=true]/backend:hidden" />
          </Button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent
        side="top"
        sideOffset={4}
        className="w-64"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!isCoarseTouchDevice())
            document
              .querySelector<HTMLElement>(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)
              ?.focus();
        }}
      >
        <DropdownMenuRadioGroup
          value={selected.value}
          onValueChange={(value) => onSwitchBackend(value as ZCodeExecutionBackend)}
        >
          {BACKEND_OPTIONS.map((option) => {
            const blocked = option.value === "codex" && !codexAvailable;
            return (
              <DropdownMenuRadioItem
                key={option.value}
                value={option.value}
                disabled={blocked}
                data-testid={testId("v4-composer-backend-select-item", option.value)}
                className="min-h-13 items-start gap-3 py-2"
              >
                <option.Icon className="mt-0.5 size-4.5 shrink-0" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>
                    {intl.formatMessage({ id: option.labelId })}
                    {blocked && (
                      <span className="text-ui-sm text-foreground-subtle">
                        {" "}
                        · {intl.formatMessage({ id: "chat.toolbar.backend.codex.unavailable" })}
                      </span>
                    )}
                  </span>
                  <span className="text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({ id: option.descriptionId })}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const V4ComposerBackendSwitch = memo(V4ComposerBackendSwitchImpl);
