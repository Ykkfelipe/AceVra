/**
 * Pins what the three real provider maps emit, so "provider-managed effort" stays an empty
 * patch rather than a silently-defaulted parameter.
 *
 * The personal config sets `reasoningLevel: { values: ["default"], map: "{}" }` for every
 * model whose provider publishes no reasoning ladder. An empty merge patch must write
 * nothing at all — not `reasoning_effort`, not `thinking`, nothing — while the two maps that
 * do mean something (GPT-5-mini's `reasoning_effort`, GLM's `output_config.effort`) and the
 * GPT-5 output-parameter rewrite must keep working untouched.
 *
 * Run: mise exec -- node --import tsx --test packages/model-option-map/test/*.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyOrderedJsonMergePatches,
  compileModelOptionMap,
  type JsonObject,
} from "../src/index.js";

function applyMap(
  map: string,
  value: string | number,
  body: JsonObject,
  option = "reasoningLevel",
): JsonObject {
  const program = compileModelOptionMap(map, option as "reasoningLevel" | "maxOutputTokens");
  return applyOrderedJsonMergePatches(body, [{ option, patch: program.evaluate(value) }]);
}

/**
 * Merge-patch 结果用 null 原型对象保存 JSON 事实；比较请求体时按 JSON 语义归一，
 * 否则断言会退化成“原型是否相同”而不是“发出去的 JSON 是否相同”。
 */
function json(body: JsonObject): Record<string, unknown> {
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}

test("an empty map writes nothing for reasoningLevel", () => {
  const program = compileModelOptionMap("{}", "reasoningLevel");
  assert.deepEqual(json(program.evaluate("default")), {});
  const body = { model: "deepseek/deepseek-v4-pro", max_tokens: 8192 };
  assert.deepEqual(json(applyMap("{}", "default", body)), body);
  assert.equal("reasoning_effort" in applyMap("{}", "default", body), false);
});

test("the GPT-5-mini style map emits reasoning_effort", () => {
  const body = applyMap('{"reasoning_effort": reasoningLevel}', "low", { model: "gpt-5-mini" });
  assert.deepEqual(json(body), { model: "gpt-5-mini", reasoning_effort: "low" });
});

test("the GPT-5 max rewrite emits max_completion_tokens and deletes max_tokens", () => {
  const body = applyMap(
    '{"max_completion_tokens": maxOutputTokens, "max_tokens": null}',
    128000,
    { model: "gpt-5-mini", max_tokens: 4096 },
    "maxOutputTokens",
  );
  assert.deepEqual(json(body), { model: "gpt-5-mini", max_completion_tokens: 128000 });
  assert.equal("max_tokens" in body, false);
});

test("the GLM-style anthropic map emits output_config.effort", () => {
  const body = applyMap('{"output_config": {"effort": reasoningLevel}}', "max", {
    model: "glm-5.3",
  });
  assert.deepEqual(json(body), { model: "glm-5.3", output_config: { effort: "max" } });
});

test("an empty map still lets the max-output rewrite run alongside it", () => {
  const reasoning = compileModelOptionMap("{}", "reasoningLevel");
  const maxOutput = compileModelOptionMap(
    '{"max_completion_tokens": maxOutputTokens, "max_tokens": null}',
    "maxOutputTokens",
  );
  const body = applyOrderedJsonMergePatches({ model: "gpt-5.4-nano", max_tokens: 4096 }, [
    { option: "reasoningLevel", patch: reasoning.evaluate("default") },
    { option: "maxOutputTokens", patch: maxOutput.evaluate(16384) },
  ]);
  assert.deepEqual(json(body), { model: "gpt-5.4-nano", max_completion_tokens: 16384 });
});
