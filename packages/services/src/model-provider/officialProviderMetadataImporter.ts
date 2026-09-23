import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  type ProviderConfigLayerUpdate,
  type ProviderConfigLayerSnapshot,
} from "@zcode/provider";
import { decodeProviderConfigFile } from "@zcode/provider-node";

const IMPORTABLE_PROVIDER_IDS = ["azure-openai", "command-code"] as const;

export interface OfficialProviderMetadataImportResult {
  readonly importedProviderIds: readonly string[];
  readonly skippedProviderIds: readonly string[];
}

/** Copy only selected metadata into missing fork providers; source is strictly read-only. */
export async function importOfficialProviderMetadata(options: {
  readonly sourceFilePath: string;
  readonly targetFilePath: string;
  readonly updateTarget: (
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ) => Promise<ProviderConfigLayerSnapshot>;
}): Promise<OfficialProviderMetadataImportResult> {
  if (resolve(options.sourceFilePath) === resolve(options.targetFilePath)) {
    return { importedProviderIds: [], skippedProviderIds: [...IMPORTABLE_PROVIDER_IDS] };
  }

  const raw = await readFile(options.sourceFilePath, "utf8");
  const source = decodeProviderConfigFile(JSON.parse(raw));
  const sourceProviders = source.providers;
  const availableIds = IMPORTABLE_PROVIDER_IDS.filter((id) => sourceProviders.has(id));
  if (availableIds.length === 0) {
    return { importedProviderIds: [], skippedProviderIds: [...IMPORTABLE_PROVIDER_IDS] };
  }

  let importedProviderIds: string[] = [];
  let skippedProviderIds: string[] = [];
  await options.updateTarget((current) => {
    let providers = current.providers;
    const newlyImportedIds = availableIds.filter((id) => !providers.has(id));
    skippedProviderIds = IMPORTABLE_PROVIDER_IDS.filter((id) => !newlyImportedIds.includes(id));
    for (const providerId of newlyImportedIds) {
      const sourceRule = sourceProviders.getRule(providerId);
      if (!sourceRule) continue;
      providers = providers.setRule({
        ...sourceRule,
        config: stripProviderSecrets(sourceRule.config),
      });
    }
    importedProviderIds = newlyImportedIds.filter((id) => providers.has(id));
    if (importedProviderIds.length === 0) return current;

    let models = current.models;
    for (const rule of source.models.rules()) {
      if (
        (rule.type !== "provider-model" && rule.type !== "manual-provider-model") ||
        !importedProviderIds.includes(rule.providerId)
      ) {
        continue;
      }
      models = models.setExact(
        rule.providerId,
        rule.modelId,
        rule.config,
        rule.type !== "manual-provider-model",
      );
    }
    const providerOrder = [
      ...(current.providerOrder ?? []),
      ...importedProviderIds.filter((id) => !(current.providerOrder ?? []).includes(id)),
    ];
    return {
      ...current,
      providers,
      models,
      ...(providerOrder.length > 0 ? { providerOrder } : {}),
    };
  });

  return Object.freeze({
    importedProviderIds: Object.freeze(importedProviderIds),
    skippedProviderIds: Object.freeze(skippedProviderIds),
  });
}

function stripProviderSecrets(config: ProviderConfig): ProviderConfig {
  return new ProviderConfig({
    group: config.group,
    logo: config.logo,
    access:
      config.access?.type === "api-key" || config.access?.type === "zhipu-coding-plan-api-key"
        ? new ApiKeyAccessConfig({ type: config.access.type })
        : config.access,
    api: config.api
      ? new ProviderApiConfig({
          type: config.api.type,
          baseUrl: stripUrlCredentials(config.api.baseUrl ?? undefined),
          // Header values are not provider metadata and may include bearer/API credentials.
        })
      : config.api,
    builtinModelIds: config.builtinModelIds,
    personalModelIds: config.personalModelIds,
    modelOrder: config.modelOrder,
    visibility: config.visibility,
  });
}

function stripUrlCredentials(value: string | undefined): string | undefined {
  if (!value) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}
