/**
 * bugfix 回归：config/provider/zcode-builtin.json 里 gpt-6-sol / gpt-6-luna 曾经没有任何专属
 * modelMatch 规则（只有同系列的 gpt-6-astra 有），导致它们落到最通用的 ".*" 兜底规则，
 * 拿到 contextWindow=200000、maxOutputTokens.max=32000——但 Command Code 自己的
 * /models 接口报告这三个模型的真实 context_length 都是 1050000。这里锁住这三个同系列模型
 * 解析出的 properties/optionSpecs 完全一致，防止 sol/luna 以后又在目录更新时被漏掉。
 *
 * Run: mise exec -- node --import tsx --test packages/provider-node/test/zcodeBuiltinModelCatalogCoverage.test.ts
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decodeZCodeBuiltinRelease } from "../src/zcode-builtin-release.js";

const BUILTIN_CATALOG_PATH = fileURLToPath(
  new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
);

async function loadModelConfigRules() {
  const content = await readFile(BUILTIN_CATALOG_PATH, "utf8");
  const release = decodeZCodeBuiltinRelease(JSON.parse(content));
  return release.config.modelConfigRules;
}

test("the shared model catalog parses without schema errors", async () => {
  await assert.doesNotReject(loadModelConfigRules());
});

test("gpt-6-sol and gpt-6-luna resolve to the same real specs as gpt-6-astra, not the generic fallback", async () => {
  const rules = await loadModelConfigRules();
  const resolveFor = (modelId: string) =>
    rules
      .resolve({
        providerId: "azure-openai",
        templateId: "custom",
        modelId,
        apiType: "openai-chat-completions",
      })
      .toJSON();

  const astra = resolveFor("gpt-6-astra");
  const sol = resolveFor("gpt-6-sol");
  const luna = resolveFor("gpt-6-luna");

  assert.equal(astra.properties?.contextWindow, 1050000);
  assert.equal(astra.optionSpecs?.maxOutputTokens?.max, 128000);
  assert.deepEqual(sol.properties, astra.properties);
  assert.deepEqual(sol.optionSpecs, astra.optionSpecs);
  assert.deepEqual(luna.properties, astra.properties);
  assert.deepEqual(luna.optionSpecs, astra.optionSpecs);
});

test("the fix is scoped to the gpt-6 family: a genuinely unknown model still hits the generic fallback", async () => {
  const rules = await loadModelConfigRules();
  const resolved = rules
    .resolve({
      providerId: "azure-openai",
      templateId: "custom",
      modelId: "some-totally-unrecognized-model-id",
      apiType: "openai-chat-completions",
    })
    .toJSON();
  assert.equal(resolved.properties?.contextWindow, 200000);
  assert.equal(resolved.optionSpecs?.maxOutputTokens?.max, 32000);
});

test("the gpt-6-family fix applies regardless of which custom provider id the model is added under", async () => {
  const rules = await loadModelConfigRules();
  const underAzureResponses = rules
    .resolve({
      providerId: "new-provider",
      templateId: "custom",
      modelId: "gpt-6-luna",
      apiType: "openai-responses",
    })
    .toJSON();
  const underCommandCode = rules
    .resolve({
      providerId: "command-code",
      templateId: "custom",
      modelId: "gpt-6-luna",
      apiType: "openai-chat-completions",
    })
    .toJSON();
  assert.equal(underAzureResponses.properties?.contextWindow, 1050000);
  assert.equal(underCommandCode.properties?.contextWindow, 1050000);
});
