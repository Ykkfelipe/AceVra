import {
  MODEL_PROVIDER_FAMILY_SPECS,
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
    if (!familyId && provider.effectiveConfig.group !== "standard-personal") continue;
    include(
      provider.providerId,
      provider.providerName?.trim() || provider.providerId,
      provider.models.length > 0,
    );
  }
  for (const provider of selectionView?.providers ?? []) {
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
