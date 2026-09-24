// Codex 后端的策划模型下拉（draft 首发、thread 级）。
// 列表是 shared codex-execution 契约里的 exact allow-list；null = Default 哨兵。
// 视觉契约与 backend/mode 开关同源（COMPOSER_TOOLBAR_TRIGGER_CLASS），
// 状态由 useDraftConfigControl 拥有，本组件是纯展示 + 单选回调。
import { memo } from "react";
import { BotIcon, CheckIcon, ChevronDownIcon, CircleDotIcon } from "lucide-react";
import { CODEX_MODEL_OPTIONS, codexModelOptionLabel } from "@zcode/shared";
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
import { COMPOSER_TOOLBAR_TRIGGER_CLASS } from "@/v4/composer/composerToolbarPresentation.js";

export const V4_COMPOSER_CODEX_MODEL_TRIGGER_TEST_ID = "v4-composer-codex-model-select-trigger";

function V4ComposerCodexModelSelectImpl({
  modelId,
  disabled,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSelectModel,
}: {
  /** null = Default 哨兵（Codex 应用自身设置）。 */
  modelId: string | null;
  disabled?: boolean;
  activeConfigPicker: V4ComposerConfigPicker | null;
  onConfigPickerOpenChange: (picker: V4ComposerConfigPicker, open: boolean) => void;
  onSelectModel: (modelId: string | null) => void;
}) {
  const { intl } = useZCodeIntl();
  const value = modelId ?? "";
  const triggerLabel = modelId
    ? codexModelOptionLabel(modelId)
    : intl.formatMessage({ id: "chat.toolbar.backend.codex.modelManaged" });

  return (
    <DropdownMenu
      open={activeConfigPicker === "codexModel"}
      onOpenChange={(open) => onConfigPickerOpenChange("codexModel", open)}
    >
      <ControlHintTooltip
        title={intl.formatMessage({ id: "chat.toolbar.backend.codex.modelPickerLabel" })}
        open={activeConfigPicker === "codexModel" ? false : undefined}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            data-testid={V4_COMPOSER_CODEX_MODEL_TRIGGER_TEST_ID}
            data-composer-collapse-priority="1"
            aria-label={intl.formatMessage({
              id: "chat.toolbar.backend.codex.modelPickerLabel",
            })}
            aria-haspopup="menu"
            className={cn(
              "group/codex-model gap-1 p-0 @xl/composer:w-auto @xl/composer:px-2 data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0",
              COMPOSER_TOOLBAR_TRIGGER_CLASS,
            )}
          >
            <BotIcon className="size-4" />
            <span className="hidden @xl/composer:inline group-data-[composer-compact=true]/codex-model:hidden">
              {triggerLabel}
            </span>
            <ChevronDownIcon className="hidden size-3.5 @xl/composer:block group-data-[composer-compact=true]/codex-model:hidden" />
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
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onSelectModel(next || null)}>
          <DropdownMenuRadioItem
            value=""
            data-testid="v4-composer-codex-model-select-item-default"
            className="min-h-13 items-start gap-3 py-2"
          >
            <CircleDotIcon className="mt-0.5 size-4.5 shrink-0" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span>{intl.formatMessage({ id: "chat.toolbar.backend.codex.modelDefault" })}</span>
              <span className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "chat.toolbar.backend.codex.modelManaged" })}
              </span>
            </span>
          </DropdownMenuRadioItem>
          {CODEX_MODEL_OPTIONS.map((option) => (
            <DropdownMenuRadioItem
              key={option.id}
              value={option.id}
              data-testid={`v4-composer-codex-model-select-item-${option.id}`}
              className="min-h-13 items-start gap-3 py-2"
            >
              <CheckIcon className="mt-0.5 size-4.5 shrink-0 opacity-0" aria-hidden />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span>{option.label}</span>
                <span className="font-mono text-ui-xs text-foreground-subtlest">{option.id}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const V4ComposerCodexModelSelect = memo(V4ComposerCodexModelSelectImpl);
