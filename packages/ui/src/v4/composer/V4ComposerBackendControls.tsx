// 新任务的供应商选择只写 Renderer 草稿；既定任务的执行后端不可切换。
import { memo, useMemo } from "react";
import { BotIcon, ChevronDownIcon, PackageIcon, SparklesIcon } from "lucide-react";
import { testId, TID_V4_COMPOSER_INPUT, type ZCodeExecutionBackend } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
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
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import type { V4ComposerConfigPicker } from "@/v4/composer/configPickerState.js";
import { COMPOSER_TOOLBAR_TRIGGER_CLASS } from "@/v4/composer/composerToolbarPresentation.js";
import {
  buildComposerAgentProviderChoices,
  resolveComposerProviderChoiceKey,
} from "@/v4/composer/composerProviderChoices.js";

function V4ComposerBackendSwitchImpl({
  backend,
  selectedProviderId,
  modelSelectionView,
  codexAvailable,
  disabled,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSwitchBackend,
  onSelectAgentProvider,
}: {
  backend: ZCodeExecutionBackend;
  selectedProviderId?: string | null;
  modelSelectionView?: ModelSelectionView | null;
  codexAvailable: boolean;
  disabled?: boolean;
  activeConfigPicker: V4ComposerConfigPicker | null;
  onConfigPickerOpenChange: (picker: V4ComposerConfigPicker, open: boolean) => void;
  onSwitchBackend: (backend: ZCodeExecutionBackend) => void;
  onSelectAgentProvider: (providerId: string, modelId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const providerSettings = useProviderSettingsView();
  const settingsView =
    providerSettings.state.status === "ready" ? providerSettings.state.view : null;
  const agentChoices = useMemo(
    () => buildComposerAgentProviderChoices(modelSelectionView, settingsView),
    [modelSelectionView, settingsView],
  );
  const selectedKey =
    backend === "codex"
      ? "codex"
      : selectedProviderId
        ? resolveComposerProviderChoiceKey(selectedProviderId)
        : (agentChoices.find((choice) => choice.providerId)?.key ?? "family:zai");
  const selectedChoice = agentChoices.find((choice) => choice.key === selectedKey);
  const selectedLabel =
    backend === "codex"
      ? intl.formatMessage({ id: "chat.toolbar.backend.codex.label" })
      : (selectedChoice?.label ?? intl.formatMessage({ id: "chat.toolbar.provider.zai.label" }));
  const SelectedIcon =
    backend === "codex" ? BotIcon : selectedKey === "family:zai" ? SparklesIcon : PackageIcon;

  const selectChoice = (key: string) => {
    if (key === "codex") {
      onSwitchBackend("codex");
      return;
    }
    const choice = agentChoices.find((item) => item.key === key);
    if (!choice?.providerId || !choice.modelId) return;
    if (backend === "zcode" && selectedKey === key) return;
    // 修复：从 Codex 切回供应商时一次写入后端与目标模型，避免保留旧的 Agent 选择。
    onSelectAgentProvider(choice.providerId, choice.modelId);
  };

  const renderAgentChoice = (choice: (typeof agentChoices)[number]) => {
    const unavailableId =
      choice.unavailableReason === "add-model"
        ? "chat.toolbar.provider.addModel"
        : "chat.toolbar.provider.finishSetup";
    const ChoiceIcon = choice.key === "family:zai" ? SparklesIcon : PackageIcon;
    return (
      <DropdownMenuRadioItem
        key={choice.key}
        value={choice.key}
        disabled={choice.unavailableReason !== null}
        data-testid={testId("v4-composer-provider-select-item", choice.key)}
        className="min-h-11 items-start gap-3 py-1.5"
      >
        <ChoiceIcon className="mt-0.5 size-4 shrink-0" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate">{choice.label}</span>
          {choice.unavailableReason && (
            <span className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: unavailableId })}
            </span>
          )}
        </span>
      </DropdownMenuRadioItem>
    );
  };

  return (
    <DropdownMenu
      open={activeConfigPicker === "backend"}
      onOpenChange={(open) => onConfigPickerOpenChange("backend", open)}
    >
      <ControlHintTooltip
        title={intl.formatMessage({ id: "chat.toolbar.provider.label" })}
        open={activeConfigPicker === "backend" ? false : undefined}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            data-testid="v4-composer-backend-select-trigger"
            data-composer-collapse-priority="1"
            aria-label={intl.formatMessage({ id: "chat.toolbar.provider.label" })}
            aria-haspopup="menu"
            className={cn(
              "group/backend gap-1 p-0 @xl/composer:w-auto @xl/composer:px-2 data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0",
              COMPOSER_TOOLBAR_TRIGGER_CLASS,
            )}
          >
            <SelectedIcon className="size-4" />
            <span className="hidden max-w-24 truncate @xl/composer:inline group-data-[composer-compact=true]/backend:hidden">
              {selectedLabel}
            </span>
            <ChevronDownIcon className="hidden size-3.5 @xl/composer:block group-data-[composer-compact=true]/backend:hidden" />
          </Button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent
        side="top"
        sideOffset={4}
        className="max-h-80 w-64 overflow-y-auto"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!isCoarseTouchDevice())
            document
              .querySelector<HTMLElement>(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)
              ?.focus();
        }}
      >
        <DropdownMenuRadioGroup value={selectedKey} onValueChange={selectChoice}>
          {agentChoices.filter((choice) => choice.key === "family:zai").map(renderAgentChoice)}
          <DropdownMenuRadioItem
            value="codex"
            disabled={!codexAvailable}
            data-testid={testId("v4-composer-backend-select-item", "codex")}
            className="min-h-11 items-start gap-3 py-1.5"
          >
            <BotIcon className="mt-0.5 size-4 shrink-0" />
            <span className="flex flex-col gap-0.5">
              <span>{intl.formatMessage({ id: "chat.toolbar.backend.codex.label" })}</span>
              {!codexAvailable && (
                <span className="text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: "chat.toolbar.backend.codex.unavailable" })}
                </span>
              )}
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            value="claude-code"
            disabled
            className="min-h-11 items-start gap-3 py-1.5"
          >
            <BotIcon className="mt-0.5 size-4 shrink-0" />
            <span className="flex flex-col gap-0.5">
              <span>{intl.formatMessage({ id: "chat.toolbar.provider.claude.label" })}</span>
              <span className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "chat.toolbar.provider.claude.unavailable" })}
              </span>
            </span>
          </DropdownMenuRadioItem>
          {agentChoices.filter((choice) => choice.key !== "family:zai").map(renderAgentChoice)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const V4ComposerBackendSwitch = memo(V4ComposerBackendSwitchImpl);
