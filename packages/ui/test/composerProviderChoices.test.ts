import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelectionView, ProviderSettingsView } from "@zcode/services";
import {
  buildComposerAgentProviderChoices,
  resolveComposerProviderChoiceKey,
} from "../src/v4/composer/composerProviderChoices.js";

const ZAI_INDIVIDUAL = "account:zai-individual-coding-plan";
const ZAI_START_PLAN = "account:zai-start-plan";

function providerSettingsView(providers: ProviderSettingsView["providers"]): ProviderSettingsView {
  return {
    revision: 1,
    providerTemplates: [],
    providerOrder: providers.map((provider) => provider.providerId),
    providers,
  };
}

function selectionView(providers: ModelSelectionView["providers"]): ModelSelectionView {
  return { revision: 1, providers };
}

function settingsProvider(
  overrides: Partial<ProviderSettingsView["providers"][number]> &
    Pick<ProviderSettingsView["providers"][number], "providerId">,
): ProviderSettingsView["providers"][number] {
  return {
    providerName: overrides.providerId,
    templateId: "custom",
    enabled: true,
    executable: true,
    effectiveConfig: { group: "standard-personal", visibility: "visible" } as never,
    issues: [],
    models: [],
    ...overrides,
  } as ProviderSettingsView["providers"][number];
}

function selectionProvider(
  providerId: string,
  models: readonly string[],
): ModelSelectionView["providers"][number] {
  return {
    providerId,
    templateId: "custom",
    providerName: providerId,
    config: {} as never,
    models: models.map((modelId) => ({ modelId, config: {} as never })),
  } as ModelSelectionView["providers"][number];
}

test("the Z.ai family always appears as one provider entry even with no configured providers", () => {
  const choices = buildComposerAgentProviderChoices(null, null);
  assert.deepEqual(
    choices.map((choice) => choice.key),
    ["family:zai"],
  );
  assert.equal(choices[0]?.label, "Z.ai");
  assert.equal(choices[0]?.unavailableReason, "add-model");
});

test("Z.ai Individual and Start Plan collapse into the single Z.ai family choice", () => {
  const settings = providerSettingsView([
    settingsProvider({ providerId: ZAI_INDIVIDUAL, models: [{ modelId: "glm-4.6" } as never] }),
    settingsProvider({ providerId: ZAI_START_PLAN, models: [{ modelId: "glm-4.6" } as never] }),
  ]);
  const selection = selectionView([selectionProvider(ZAI_INDIVIDUAL, ["glm-4.6"])]);
  const choices = buildComposerAgentProviderChoices(selection, settings);
  assert.deepEqual(
    choices.map((choice) => choice.key),
    ["family:zai"],
  );
  assert.equal(choices[0]?.providerId, ZAI_INDIVIDUAL);
  assert.equal(choices[0]?.modelId, "glm-4.6");
  assert.equal(choices[0]?.unavailableReason, null);
});

test("a saved custom provider with no configured model is visible but needs a model added", () => {
  const settings = providerSettingsView([settingsProvider({ providerId: "azure-openai" })]);
  const choices = buildComposerAgentProviderChoices(null, settings);
  const azure = choices.find((choice) => choice.key === "provider:azure-openai");
  assert.ok(azure);
  assert.equal(azure.unavailableReason, "add-model");
  assert.equal(azure.providerId, null);
});

test("a custom provider with a configured but not-yet-executable model needs setup finished", () => {
  const settings = providerSettingsView([
    settingsProvider({ providerId: "azure-openai", models: [{ modelId: "gpt-4o" } as never] }),
  ]);
  // 已配置模型，但目标 Host 的 selection view 还没把它列为可执行——例如 key 尚未生效。
  const choices = buildComposerAgentProviderChoices(null, settings);
  const azure = choices.find((choice) => choice.key === "provider:azure-openai");
  assert.ok(azure);
  assert.equal(azure.unavailableReason, "finish-setup");
  assert.equal(azure.providerId, null);
});

test("a custom provider with a runnable model is selectable and carries its first model", () => {
  const settings = providerSettingsView([
    settingsProvider({ providerId: "azure-openai", models: [{ modelId: "gpt-4o" } as never] }),
  ]);
  const selection = selectionView([selectionProvider("azure-openai", ["gpt-4o"])]);
  const choices = buildComposerAgentProviderChoices(selection, settings);
  const azure = choices.find((choice) => choice.key === "provider:azure-openai");
  assert.ok(azure);
  assert.equal(azure.unavailableReason, null);
  assert.equal(azure.providerId, "azure-openai");
  assert.equal(azure.modelId, "gpt-4o");
  assert.equal(azure.label, "azure-openai");
});

test("resolveComposerProviderChoiceKey routes family providers to the shared family key", () => {
  assert.equal(resolveComposerProviderChoiceKey(ZAI_INDIVIDUAL), "family:zai");
  assert.equal(resolveComposerProviderChoiceKey(ZAI_START_PLAN), "family:zai");
  assert.equal(resolveComposerProviderChoiceKey("azure-openai"), "provider:azure-openai");
});

test("a provider outside the standard-personal group without a family is not surfaced", () => {
  const settings = providerSettingsView([
    settingsProvider({
      providerId: "hidden-builtin",
      effectiveConfig: { group: "zcode-builtin", visibility: "visible" } as never,
    }),
  ]);
  const choices = buildComposerAgentProviderChoices(null, settings);
  assert.equal(
    choices.some((choice) => choice.key === "provider:hidden-builtin"),
    false,
  );
});

test("a BigModel-family account never appears in the Provider menu, connected or not", () => {
  const settings = providerSettingsView([
    settingsProvider({
      providerId: BIGMODEL_INDIVIDUAL,
      models: [{ modelId: "glm-4.6" } as never],
    }),
  ]);
  const selection = selectionView([selectionProvider(BIGMODEL_INDIVIDUAL, ["glm-4.6"])]);
  const choices = buildComposerAgentProviderChoices(selection, settings);
  assert.deepEqual(
    choices.map((choice) => choice.key),
    ["family:zai"],
  );
});

test("a hidden provider is not surfaced even when it is a saved personal provider", () => {
  const settings = providerSettingsView([
    settingsProvider({
      providerId: "azure-openai",
      effectiveConfig: { group: "standard-personal", visibility: "hidden" } as never,
    }),
  ]);
  const choices = buildComposerAgentProviderChoices(null, settings);
  assert.equal(
    choices.some((choice) => choice.key === "provider:azure-openai"),
    false,
  );
});
