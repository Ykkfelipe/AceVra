import assert from "node:assert/strict";
import test from "node:test";
import { compileModelOptionMap, type JsonObject } from "@zcode/model-option-map";
import {
  applyCommandCodeReasoningCapabilitiesToPersonalConfig,
  COMMAND_CODE_GOAT_REASONING_CAPABILITIES,
  COMMAND_CODE_REASONING_EFFORT_MAP,
  commandCodeReasoningCapability,
} from "@zcode/provider";

const PROVIDER_ID = "command-code";
const ZAI_PROVIDER_ID = "account:zai-individual-coding-plan";
/** Z.ai Coding Plan 的内建 anthropic map：产出 output_config.effort，绝不能被本同步器改写。 */
const ZAI_EFFORT_MAP =
  '{"thinking": {"type": "adaptive"}, "output_config": {"effort": reasoningLevel}}';

/**
 * 29 个 GOAT 模型的权威档位表，独立于 manifest 抄录自 Command Code 自带的
 * reasoningEfforts 注册表（@commandcode/shared MODEL_OPTIONS）与自带 models.md 的
 * Efforts 列——两处均逐条核对一致。写死在此处，manifest 打错字时测试才会失败。
 */
const EXPECTED_LADDERS: Record<string, readonly string[]> = {
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "deepseek/deepseek-v4-pro": ["high", "max"],
  "deepseek/deepseek-v4-flash": ["high", "max"],
  "deepseek/deepseek-v4-flash-vision-exp": ["high", "max"],
  "deepseek/deepseek-v4-flash-fast": ["low", "high", "max"],
  "deepseek/deepseek-v4.1-flash": ["low", "high", "max"],
  "moonshotai/Kimi-K3": ["low", "high", "max"],
  "z-ai/glm-5.3-flash": ["low", "high", "max"],
  "z-ai/glm-5.3-flashx": ["low", "high", "max"],
  "zai-org/GLM-5.3": ["low", "high", "max"],
  "zai-org/GLM-5.2": ["high", "max"],
  "MiniMaxAI/MiniMax-M3": ["low", "medium", "high"],
  "Qwen/Qwen3.8-Omni-Flash": ["low", "medium", "xhigh"],
  "Qwen/Qwen3.8-Max-0902": ["low", "medium", "xhigh"],
  "Qwen/Qwen3.8-Max": ["low", "medium", "xhigh"],
  "Qwen/Qwen3.8-27B": ["low", "medium", "xhigh"],
  "Qwen/Qwen3.8-Flash": ["low", "medium", "xhigh"],
  "stepfun/Step-5-Preview": ["low", "medium", "high"],
  "tencent/hy4-preview": ["low", "medium", "high"],
  "google/gemini-3.8-flash": ["low", "medium", "high"],
  "google/gemini-3.7-flash": ["low", "medium", "high"],
  "meta/muse-spark-1.2": ["low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.2-contributor": ["low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.3-contributor": ["low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.3": ["low", "medium", "high", "xhigh", "max"],
  "xai/grok-4.5": ["low", "medium", "high"],
  "xai/grok-4.6": ["low", "medium", "high", "xhigh"],
  "xai/grok-4.7": ["low", "medium", "high", "xhigh"],
};

function fixture() {
  const commandModels = [
    ...COMMAND_CODE_GOAT_REASONING_CAPABILITIES.map((entry) => modelRule(entry.modelId)),
    modelRule("gpt-5.6-terra"),
    // 已配置但被 "Pro and above" 档位挡住的模型：必须保持 provider-managed。
    modelRule("google/gemini-3.6-flash"),
  ];
  return {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: PROVIDER_ID,
            config: { personalModelIds: commandModels.map((rule) => rule.modelId) },
          },
          { providerId: "azure-openai", config: { personalModelIds: ["gpt-5-mini"] } },
        ],
      },
      modelConfigRules: {
        providerModelRules: [
          ...commandModels,
          {
            providerId: "azure-openai",
            modelId: "gpt-5-mini",
            config: { optionSpecs: { reasoningLevel: { values: ["low"], map: "{}" } } },
          },
          {
            providerId: ZAI_PROVIDER_ID,
            modelId: "GLM-5.3",
            config: {
              optionSpecs: {
                reasoningLevel: { values: ["low", "high", "max"], map: ZAI_EFFORT_MAP },
              },
            },
          },
        ],
        manualProviderModelRules: [],
      },
    },
  };
}

function modelRule(modelId: string) {
  return {
    providerId: PROVIDER_ID,
    modelId,
    config: {
      properties: { contextWindow: 1_000_000 },
      optionSpecs: {
        reasoningLevel: { values: ["default"], map: "{}" },
        maxOutputTokens: { max: 16_384, map: '{"max_tokens": maxOutputTokens}' },
      },
    },
  };
}

function commandRules(input: ReturnType<typeof fixture>) {
  return input.config.modelConfigRules.providerModelRules.filter(
    (rule) => rule.providerId === PROVIDER_ID,
  );
}

function json(body: JsonObject): Record<string, unknown> {
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}

test("the manifest is an exact 29-model Command Code allow-list", () => {
  assert.equal(COMMAND_CODE_GOAT_REASONING_CAPABILITIES.length, 29);
  assert.equal(
    new Set(COMMAND_CODE_GOAT_REASONING_CAPABILITIES.map((entry) => entry.modelId)).size,
    29,
  );
  assert.equal(commandCodeReasoningCapability("gpt-5.6-terra"), undefined);
  assert.equal(commandCodeReasoningCapability("moonshotai/Kimi-K2.7-Code"), undefined);
});

test("every approved model receives its exact ladder and the shared public request map", () => {
  const result = applyCommandCodeReasoningCapabilitiesToPersonalConfig(fixture()) as ReturnType<
    typeof fixture
  >;
  const actual = new Map(commandRules(result).map((rule) => [rule.modelId, rule]));

  for (const capability of COMMAND_CODE_GOAT_REASONING_CAPABILITIES) {
    const reasoning = actual.get(capability.modelId)?.config.optionSpecs.reasoningLevel;
    assert.deepEqual(reasoning?.values, capability.reasoningLevels, capability.modelId);
    assert.equal(reasoning?.map, COMMAND_CODE_REASONING_EFFORT_MAP, capability.modelId);
  }
});

test("the shared map compiles reasoning_effort and no vendor-specific request field", () => {
  for (const capability of COMMAND_CODE_GOAT_REASONING_CAPABILITIES) {
    const selected = capability.reasoningLevels.at(-1)!;
    assert.deepEqual(
      json(
        compileModelOptionMap(COMMAND_CODE_REASONING_EFFORT_MAP, "reasoningLevel").evaluate(
          selected,
        ),
      ),
      { reasoning_effort: selected },
      capability.modelId,
    );
  }
});

test("provider-managed Command Code and Azure rules remain byte-for-byte semantically unchanged", () => {
  const input = fixture();
  const result = applyCommandCodeReasoningCapabilitiesToPersonalConfig(input) as ReturnType<
    typeof fixture
  >;
  const managed = commandRules(result).find((rule) => rule.modelId === "gpt-5.6-terra");
  assert.deepEqual(managed?.config.optionSpecs.reasoningLevel, { values: ["default"], map: "{}" });
  const azure = result.config.modelConfigRules.providerModelRules.find(
    (rule) => rule.providerId === "azure-openai",
  );
  const azureBefore = input.config.modelConfigRules.providerModelRules.find(
    (rule) => rule.providerId === "azure-openai",
  );
  assert.deepEqual(azure, azureBefore);
});

test("synchronization is idempotent", () => {
  const once = applyCommandCodeReasoningCapabilitiesToPersonalConfig(fixture());
  const twice = applyCommandCodeReasoningCapabilitiesToPersonalConfig(once);
  assert.deepEqual(twice, once);
});

test("all 29 ladders equal the bundled reasoningEfforts registry exactly", () => {
  assert.equal(Object.keys(EXPECTED_LADDERS).length, 29);
  assert.deepEqual(
    [...COMMAND_CODE_GOAT_REASONING_CAPABILITIES.map((entry) => entry.modelId)].sort(),
    Object.keys(EXPECTED_LADDERS).sort(),
  );
  for (const capability of COMMAND_CODE_GOAT_REASONING_CAPABILITIES) {
    assert.deepEqual(
      [...capability.reasoningLevels],
      EXPECTED_LADDERS[capability.modelId],
      capability.modelId,
    );
  }
});

test("Z.ai Coding Plan rules pass through untouched and keep their anthropic map", () => {
  const input = fixture();
  const result = applyCommandCodeReasoningCapabilitiesToPersonalConfig(input) as ReturnType<
    typeof fixture
  >;
  const before = input.config.modelConfigRules.providerModelRules.find(
    (rule) => rule.providerId === ZAI_PROVIDER_ID,
  );
  const after = result.config.modelConfigRules.providerModelRules.find(
    (rule) => rule.providerId === ZAI_PROVIDER_ID,
  );
  assert.deepEqual(after, before, "the Z.ai rule must be byte-identical");
  assert.deepEqual(
    json(compileModelOptionMap(ZAI_EFFORT_MAP, "reasoningLevel").evaluate("high")),
    { thinking: { type: "adaptive" }, output_config: { effort: "high" } },
    "Z.ai keeps output_config.effort and never gains reasoning_effort",
  );
});

test("provider-managed and above-GOAT models emit no reasoning field at all", () => {
  const result = applyCommandCodeReasoningCapabilitiesToPersonalConfig(fixture()) as ReturnType<
    typeof fixture
  >;
  const rules = commandRules(result);
  for (const modelId of ["gpt-5.6-terra", "google/gemini-3.6-flash"]) {
    const reasoning = rules.find((rule) => rule.modelId === modelId)?.config.optionSpecs
      .reasoningLevel;
    assert.deepEqual(reasoning, { values: ["default"], map: "{}" }, modelId);
    assert.equal(commandCodeReasoningCapability(modelId), undefined, modelId);
    const patch = compileModelOptionMap(reasoning!.map, "reasoningLevel").evaluate("default");
    assert.deepEqual(json(patch), {}, modelId);
    assert.deepEqual(Object.keys(patch), [], `${modelId} owns no JSON path`);
  }
});
