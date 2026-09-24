// Codex 后端模型/effort 下拉。
// 旧实现把两组选择塞进一个过高菜单，effort 在小窗口里被裁切；现在分成两个独立按钮。
// - 模型：策划 allow-list（CODEX_MODEL_OPTIONS），null = Default 哨兵（Codex 应用设置）。
// - effort：turn 级覆盖（CODEX_EFFORT_OPTIONS），null = 不覆盖。
// Codex 0.155.0-alpha.16.4 的 turn/start 同时接受 model + effort 覆盖（作用于本 turn
// 及后续 turns），因此既有 Codex 会话同样可交互，不是静态只读。
// 视觉契约与 backend/mode 开关同源（COMPOSER_TOOLBAR_TRIGGER_CLASS）；值经
// useDraftConfigControl 的草稿 store 落到 SessionPane 首发/发送路径。
import { memo } from "react";
import { BotIcon, ChevronDownIcon, GaugeIcon } from "lucide-react";
import {
  CODEX_MODEL_OPTIONS,
  codexModelOptionLabel,
  codexModelReasoningEfforts,
} from "@zcode/shared";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
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
export const V4_COMPOSER_CODEX_EFFORT_TRIGGER_TEST_ID = "v4-composer-codex-effort-select-trigger";

function restoreComposerFocus(event: Event) {
  event.preventDefault();
  if (!isCoarseTouchDevice())
    document.querySelector<HTMLElement>(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)?.focus();
}

function V4ComposerCodexModelSelectImpl({
  modelId,
  actualModelId,
  effort,
  actualEffort,
  disabled,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSelectModel,
  onSelectEffort,
}: {
  /** 显式模型选择；null = 不覆盖（draft 发 Default / 会话沿用 thread 当前读数）。 */
  modelId: string | null;
  /** Codex 回报的实际生效模型；只用于标签，不代表用户显式覆盖。 */
  actualModelId: string | null;
  /** 显式 effort 覆盖；null = 不覆盖。 */
  effort: string | null;
  /** Codex 回报的实际生效档位；只用于标签。 */
  actualEffort: string | null;
  disabled?: boolean;
  activeConfigPicker: V4ComposerConfigPicker | null;
  onConfigPickerOpenChange: (picker: V4ComposerConfigPicker, open: boolean) => void;
  onSelectModel: (modelId: string | null) => void;
  onSelectEffort: (effort: string | null) => void;
}) {
  const { intl } = useZCodeIntl();
  const modelValue = modelId && CODEX_MODEL_OPTIONS.some((o) => o.id === modelId) ? modelId : "";
  const modelEffortOptions = codexModelReasoningEfforts(modelId ?? actualModelId);
  const effortValue = effort && modelEffortOptions.includes(effort as never) ? effort : "";
  const effectiveModelId = modelId ?? actualModelId;
  const modelLabel = effectiveModelId
    ? codexModelOptionLabel(effectiveModelId)
    : intl.formatMessage({ id: "chat.toolbar.backend.codex.modelManaged" });
  const effectiveEffort =
    effortValue ||
    (actualEffort && modelEffortOptions.includes(actualEffort as never) ? actualEffort : null);
  const effortLabel = effectiveEffort
    ? intl.formatMessage({ id: `chat.toolbar.backend.codex.effort.${effectiveEffort}` })
    : intl.formatMessage({ id: "chat.toolbar.backend.codex.effort.default" });

  return (
    <>
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
              <span className="hidden max-w-40 truncate @xl/composer:inline group-data-[composer-compact=true]/codex-model:hidden">
                {modelLabel}
              </span>
              <ChevronDownIcon className="hidden size-3.5 @xl/composer:block group-data-[composer-compact=true]/codex-model:hidden" />
            </Button>
          </DropdownMenuTrigger>
        </ControlHintTooltip>
        <DropdownMenuContent
          side="top"
          sideOffset={4}
          className="w-72 max-w-[calc(100vw-1rem)]"
          onCloseAutoFocus={restoreComposerFocus}
        >
          <DropdownMenuLabel>
            {intl.formatMessage({ id: "chat.toolbar.backend.codex.modelPickerLabel" })}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={modelValue}
            onValueChange={(next) => onSelectModel(next || null)}
            className="max-h-80 overflow-y-auto pr-1"
          >
            <DropdownMenuRadioItem
              value=""
              data-testid="v4-composer-codex-model-select-item-default"
              className="min-h-10 items-start py-1"
            >
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
                className="min-h-10 items-start py-1"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>{option.label}</span>
                  <span className="font-mono text-ui-xs text-foreground-subtlest">{option.id}</span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu
        open={activeConfigPicker === "codexEffort"}
        onOpenChange={(open) => onConfigPickerOpenChange("codexEffort", open)}
      >
        <ControlHintTooltip
          title={intl.formatMessage({ id: "chat.toolbar.backend.codex.effort.label" })}
          open={activeConfigPicker === "codexEffort" ? false : undefined}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              data-testid={V4_COMPOSER_CODEX_EFFORT_TRIGGER_TEST_ID}
              data-composer-collapse-priority="2"
              aria-label={intl.formatMessage({ id: "chat.toolbar.backend.codex.effort.label" })}
              aria-haspopup="menu"
              className={cn(
                "group/codex-effort gap-1 p-0 @xl/composer:w-auto @xl/composer:px-2 data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0",
                COMPOSER_TOOLBAR_TRIGGER_CLASS,
              )}
            >
              <GaugeIcon className="size-4" />
              <span className="hidden max-w-20 truncate @xl/composer:inline group-data-[composer-compact=true]/codex-effort:hidden">
                {effortLabel}
              </span>
              <ChevronDownIcon className="hidden size-3.5 @xl/composer:block group-data-[composer-compact=true]/codex-effort:hidden" />
            </Button>
          </DropdownMenuTrigger>
        </ControlHintTooltip>
        <DropdownMenuContent
          side="top"
          sideOffset={4}
          className="w-44 max-w-[calc(100vw-1rem)]"
          onCloseAutoFocus={restoreComposerFocus}
        >
          <DropdownMenuLabel>
            {intl.formatMessage({ id: "chat.toolbar.backend.codex.effort.label" })}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={effortValue}
            onValueChange={(next) => onSelectEffort(next || null)}
            className="max-h-64 overflow-y-auto pr-1"
          >
            <DropdownMenuRadioItem
              value=""
              data-testid="v4-composer-codex-effort-select-item-default"
              className="min-h-8 py-1"
            >
              {intl.formatMessage({ id: "chat.toolbar.backend.codex.effort.default" })}
            </DropdownMenuRadioItem>
            {modelEffortOptions.map((value) => (
              <DropdownMenuRadioItem
                key={value}
                value={value}
                data-testid={`v4-composer-codex-effort-select-item-${value}`}
                className="min-h-8 py-1"
              >
                <span className="text-ui-base">
                  {intl.formatMessage({ id: `chat.toolbar.backend.codex.effort.${value}` })}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

export const V4ComposerCodexModelSelect = memo(V4ComposerCodexModelSelectImpl);
