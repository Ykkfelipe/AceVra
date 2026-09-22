/**
 * Pins the config-layer half of the "provider-managed effort" fix.
 *
 * Personal rules for models whose provider publishes no reasoning ladder declare exactly one
 * value, `"default"`, with `map: "{}"`. That rule must override the inherited builtin ladder
 * (deepseek-style `["disabled","low","high","max"]`) *and* the inherited builtin map
 * (anthropic-style `output_config.effort`), so the request carries no reasoning parameter at
 * all. Nothing here writes config: the fixtures are literals in the shape the real files use,
 * parsed through the same schemas.
 *
 * Run: mise exec -- node --import tsx --test packages/provider/test/*.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { compileModelOptionMap, type JsonObject } from "@zcode/model-option-map";
import {
  ModelConfigRules,
  parsePersonalModelConfigRules,
  parseZCodeBuiltinModelConfigRules,
} from "@zcode/provider";

const PROVIDER_ID = "command-code";
const MODEL_ID = "deepseek/deepseek-v4-pro";
const ANTHROPIC_EFFORT_MAP =
  '{"thinking": {"type": "enabled"}, "output_config": {"effort": reasoningLevel}}';

function builtinRules(): ModelConfigRules {
  return parseZCodeBuiltinModelConfigRules({
    modelRules: [
      {
        modelMatch: ".*deepseek-v4-pro.*",
        config: {
          optionSpecs: { reasoningLevel: { values: ["disabled", "low", "high", "max"] } },
        },
      },
    ],
    modelApiRules: [
      {
        modelMatch: ".*",
        apiTypeMatch: "anthropic-messages",
        config: { optionSpecs: { reasoningLevel: { map: ANTHROPIC_EFFORT_MAP } } },
      },
    ],
    providerSiteRules: [],
    templateModelRules: [],
    builtinProviderModelRules: [],
  });
}

/** 个人规则：只声明单一名义档 "default" 与空 map，覆盖内建阶梯与内建 map。 */
function personalRules(): ModelConfigRules {
  return parsePersonalModelConfigRules({
    providerModelRules: [
      {
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        config: { optionSpecs: { reasoningLevel: { values: ["default"], map: "{}" } } },
      },
    ],
    manualProviderModelRules: [],
  });
}

function resolveReasoning(rules: ModelConfigRules): {
  readonly values: readonly string[];
  readonly map: string;
} {
  const resolved = rules.resolve({
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
    apiType: "anthropic-messages",
    baseUrl: "https://api.commandcode.ai/provider/v1",
  });
  const reasoning = resolved.optionSpecs?.reasoningLevel;
  assert.ok(reasoning?.values, "resolved reasoningLevel.values must be present");
  assert.ok(reasoning.map, "resolved reasoningLevel.map must be present");
  return { values: reasoning.values, map: reasoning.map };
}

/** Merge-patch 结果用 null 原型对象保存 JSON 事实；按 JSON 语义归一后再断言请求体。 */
function json(body: JsonObject): Record<string, unknown> {
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}

test("the builtin ladder and builtin map alone do emit a reasoning path", () => {
  const builtinOnly = resolveReasoning(builtinRules());
  assert.deepEqual(builtinOnly.values, ["disabled", "low", "high", "max"]);
  assert.equal(builtinOnly.map, ANTHROPIC_EFFORT_MAP);
  assert.deepEqual(json(compileModelOptionMap(builtinOnly.map, "reasoningLevel").evaluate("low")), {
    thinking: { type: "enabled" },
    output_config: { effort: "low" },
  });
});

test("an exact personal ['default'] + '{}' rule overrides the builtin regex ladder and map", () => {
  const effective = resolveReasoning(
    ModelConfigRules.composeEffective(builtinRules(), personalRules()),
  );
  assert.deepEqual(effective.values, ["default"]);
  assert.equal(effective.map, "{}");
  assert.notEqual(effective.map, ANTHROPIC_EFFORT_MAP, "the builtin map must not survive");
});

test("the overridden map writes no reasoning path for 'default'", () => {
  const effective = resolveReasoning(
    ModelConfigRules.composeEffective(builtinRules(), personalRules()),
  );
  const patch = compileModelOptionMap(effective.map, "reasoningLevel").evaluate("default");
  assert.deepEqual(json(patch), {});
  assert.deepEqual(Object.keys(patch), [], "an empty patch owns no JSON path");
});

test("without the personal override the same selection would have written a reasoning path", () => {
  // 反面对照：如果个人规则没覆盖 map，同一模型同一档位会真的写出 output_config.effort。
  const builtinOnly = resolveReasoning(builtinRules());
  const patch = compileModelOptionMap(builtinOnly.map, "reasoningLevel").evaluate("default");
  assert.deepEqual(json(patch), {
    thinking: { type: "enabled" },
    output_config: { effort: "default" },
  });
});
