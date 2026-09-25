import { completeNewModelSelection } from "@zcode/provider";
import {
  MODEL_PROVIDER_FAMILY_SPECS,
  formatModelPickerValue,
  resolveModelProviderFamilyIdByProviderId,
} from "@zcode/shared";
import type { ModelSelectionView, ProviderSettingsView } from "@zcode/services";

export interface ComposerAgentProviderChoice {
  key: string;
  label: string;
  providerId: string | null;
  modelId: string | null;
  unavailableReason: "add-model" | "finish-setup" | null;
}

export function resolveComposerProviderChoiceKey(providerId: string): string {
  const familyId = resolveModelProviderFamilyIdByProviderId(providerId);
  return familyId ? `family:${familyId}` : `provider:${providerId}`;
}

/**
 * Provider/backend migration and the ordinary composer picker must serialize the same completed
 * model selection. In particular, providers such as Azure require a reasoning level even when the
 * user only chose a provider/model pair.
 */
export function formatComposerAgentModelSelection(
  selectionView: ModelSelectionView | null | undefined,
  providerId: string,
  modelId: string,
): string {
  const selected = { providerId, modelId };
  const completed = selectionView
    ? (completeNewModelSelection(selectionView, selected) ?? selected)
    : selected;
  return formatModelPickerValue(completed);
}

export function buildComposerAgentProviderChoices(
  selectionView: ModelSelectionView | null | undefined,
  settingsView: ProviderSettingsView | null | undefined,
): ComposerAgentProviderChoice[] {
  const sources = new Map<
    string,
    { label: string; providerIds: Set<string>; hasConfiguredModel: boolean }
  >();
  for (const family of MODEL_PROVIDER_FAMILY_SPECS) {
    if (family.id === "zai") {
      sources.set(`family:${family.id}`, {
        label: family.label,
        providerIds: new Set([
          family.individualCodingPlanProviderId,
          family.startPlanProviderId,
          family.teamCodingPlanProviderId,
        ]),
        hasConfiguredModel: false,
      });
    }
  }

  const include = (providerId: string, label: string, hasConfiguredModel: boolean) => {
    const key = resolveComposerProviderChoiceKey(providerId);
    const family = MODEL_PROVIDER_FAMILY_SPECS.find((item) => key === `family:${item.id}`);
    const current = sources.get(key) ?? {
      label: family?.label ?? label,
      providerIds: new Set<string>(),
      hasConfiguredModel: false,
    };
    current.providerIds.add(providerId);
    current.hasConfiguredModel ||= hasConfiguredModel;
    sources.set(key, current);
  };

  for (const provider of settingsView?.providers ?? []) {
    if (provider.effectiveConfig.visibility === "hidden") continue;
    const familyId = resolveModelProviderFamilyIdByProviderId(provider.providerId);
    // Provider 菜单只启用 Z.ai family；BigModel 等其他 family 账号尚未在本产品线路由，
    // 不能作为可选/不可选条目出现，否则会跟未接入的账号体系混在一起造成误导。
    if (familyId && familyId !== "zai") continue;
    if (!familyId && provider.effectiveConfig.group !== "standard-personal") continue;
    include(
      provider.providerId,
      provider.providerName?.trim() || provider.providerId,
      provider.models.length > 0,
    );
  }
  for (const provider of selectionView?.providers ?? []) {
    const familyId = resolveModelProviderFamilyIdByProviderId(provider.providerId);
    if (familyId && familyId !== "zai") continue;
    include(
      provider.providerId,
      provider.providerName?.trim() || provider.providerId,
      provider.models.length > 0,
    );
  }

  return [...sources].map(([key, source]) => {
    const first = selectionView?.providers
      .filter((provider) => source.providerIds.has(provider.providerId))
      .flatMap((provider) =>
        provider.models.map((model) => ({
          providerId: provider.providerId,
          modelId: model.modelId,
        })),
      )[0];
    return {
      key,
      label: source.label,
      providerId: first?.providerId ?? null,
      modelId: first?.modelId ?? null,
      unavailableReason: first ? null : source.hasConfiguredModel ? "finish-setup" : "add-model",
    };
  });
}
