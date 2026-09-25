import assert from "node:assert/strict";
import test from "node:test";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import {
  buildRegistryModelSelectGroups,
  resolveModelSelectScopeProviderIds,
} from "../src/lib/modelSelectionGroups.js";

const ZAI_INDIVIDUAL = "account:zai-individual-coding-plan";
const ZAI_START_PLAN = "account:zai-start-plan";
const ZAI_TEAM = "account:zai-team-coding-plan";

function selectionProvider(
  providerId: string,
  models: readonly string[],
  access?: unknown,
): ModelSelectionView["providers"][number] {
  return {
    providerId,
    templateId: "custom",
    providerName: providerId,
    // buildRegistryModelSelectGroups 只处理 ZCode Agent 能力用的 provider（api.type 非空）；
    // 真实值不影响这几个测试，随便给一个非空 apiFormat 让它通过 supportsRegistryApiFormat 门禁。
    config: { access, api: { type: "openai-completions" } } as never,
    models: models.map((modelId) => ({ modelId, config: {} as never })),
  } as ModelSelectionView["providers"][number];
}

test("resolveModelSelectScopeProviderIds expands a Z.ai account id to the whole family", () => {
  const scope = resolveModelSelectScopeProviderIds(ZAI_INDIVIDUAL);
  assert.deepEqual([...scope].sort(), [ZAI_INDIVIDUAL, ZAI_START_PLAN, ZAI_TEAM].sort());
});

test("resolveModelSelectScopeProviderIds maps a custom provider to just itself", () => {
  const scope = resolveModelSelectScopeProviderIds("azure-openai");
  assert.deepEqual([...scope], ["azure-openai"]);
});

test("resolveModelSelectScopeProviderIds defaults to the Z.ai family when nothing is selected", () => {
  const scope = resolveModelSelectScopeProviderIds(null);
  assert.deepEqual([...scope].sort(), [ZAI_INDIVIDUAL, ZAI_START_PLAN, ZAI_TEAM].sort());
});

test("buildRegistryModelSelectGroups only returns groups for providers inside the scope", () => {
  const view: ModelSelectionView = {
    revision: 1,
    providers: [
      selectionProvider(ZAI_INDIVIDUAL, ["glm-4.6"], { mode: "individual-coding-plan" }),
      selectionProvider("azure-openai", ["gpt-4o"]),
    ],
  };
  const scope = resolveModelSelectScopeProviderIds(ZAI_INDIVIDUAL);
  const groups = buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, view, {}, scope);
  assert.deepEqual(
    groups.map((group) => group.key),
    [`registry-provider:${ZAI_INDIVIDUAL}`],
  );
});

test("a single scoped custom provider renders as one flat, borderless group", () => {
  const view: ModelSelectionView = {
    revision: 1,
    providers: [selectionProvider("azure-openai", ["gpt-4o", "gpt-4o-mini"])],
  };
  const scope = resolveModelSelectScopeProviderIds("azure-openai");
  const groups = buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, view, {}, scope);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.directItems, true);
  assert.deepEqual(
    groups[0]?.items.map((item) => item.name),
    ["gpt-4o", "gpt-4o-mini"],
  );
});

test("omitting the scope keeps every provider visible (Settings/Subagent/Workflow pickers)", () => {
  const view: ModelSelectionView = {
    revision: 1,
    providers: [
      selectionProvider(ZAI_INDIVIDUAL, ["glm-4.6"], { mode: "individual-coding-plan" }),
      selectionProvider("azure-openai", ["gpt-4o"]),
    ],
  };
  const groups = buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, view, {});
  assert.deepEqual(
    groups.map((group) => group.key).sort(),
    [`registry-provider:${ZAI_INDIVIDUAL}`, "registry-provider:azure-openai"].sort(),
  );
});
