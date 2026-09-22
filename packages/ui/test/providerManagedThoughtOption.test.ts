/**
 * Pins the "provider-managed effort" contract:
 *
 * A model whose `reasoningLevel.values` is exactly `["default"]` has no real ladder — the
 * server decides the effort. The composer/settings control is hidden for those models, but
 * the resolver keeps returning an Option with `currentValue: "default"` because
 * OffPeakEditView's `canSubmit` and SubagentsSection's supported/unsupported state both read
 * that Option. Turning the resolver into a `null` return (the obvious-looking fix) disables
 * Save for those models and makes a persisted `"default"` override look invalid, so this
 * file locks in the decision: hide at the presentation layer, never at the resolver.
 *
 * `resolveModelThoughtOption` only reads `optionSpecs.reasoningLevel` off the view, so the
 * fixtures below build just that path and cast (a full ModelSelectionView would need the
 * entire provider/model projection, which is unrelated to what is under test).
 *
 * Run:
 *   TSX_TSCONFIG_PATH=packages/ui/tsconfig.json \
 *     mise exec -- node --import tsx --test packages/ui/test/providerManagedThoughtOption.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import type { ModelSelectionView } from "@zcode/services";
import { validateModelSelectionOptions } from "@zcode/provider";
import {
  isProviderManagedThoughtOption,
  resolveModelThoughtOption,
} from "../src/lib/modelThoughtOption.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

// 档位词表所在的模块会经 display.tsx 间接加载 Vite 图片资源；先注册资源桩再动态导入，
// 其余被测代码保持真实实现。
register("./uiAssetStubLoader.mjs", import.meta.url);
const { thoughtLevelLabelId } = await import("../src/chat-input-toolbar/thoughtLevelOptions.js");

const PROVIDER_ID = "command-code";
const MODEL_ID = "deepseek/deepseek-v4-pro";

/** 只构造 resolveModelThoughtOption 实际读取的 optionSpecs.reasoningLevel。 */
function viewWithReasoningLevels(values: readonly string[]): ModelSelectionView {
  return {
    revision: 1,
    providers: [
      {
        providerId: PROVIDER_ID,
        models: [{ modelId: MODEL_ID, config: { optionSpecs: { reasoningLevel: { values } } } }],
      },
    ],
  } as unknown as ModelSelectionView;
}

function resolve(values: readonly string[], currentValue?: string) {
  return resolveModelThoughtOption({
    modelSelectionView: viewWithReasoningLevels(values),
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
    ...(currentValue === undefined ? {} : { currentValue }),
  });
}

test("a single 'low' ladder (gpt-5-mini style) still resolves an option", () => {
  const option = resolve(["low"], "low");
  assert.ok(option, "single-low models must keep their option");
  assert.deepEqual(
    option.options?.map((entry) => entry.value),
    ["low"],
  );
  assert.equal(option.currentValue, "low");
  assert.equal(isProviderManagedThoughtOption(option), false);
});

test("a real ladder still resolves its full option list", () => {
  const option = resolve(["low", "high", "max"], "high");
  assert.ok(option);
  assert.deepEqual(
    option.options?.map((entry) => entry.value),
    ["low", "high", "max"],
  );
  assert.equal(option.currentValue, "high");
  assert.equal(isProviderManagedThoughtOption(option), false);
});

test("a single 'default' ladder still resolves 'default' as the current value", () => {
  const option = resolve(["default"], "default");
  assert.ok(option);
  assert.equal(option.currentValue, "default");
  assert.equal(isProviderManagedThoughtOption(option), true);
});

test("isProviderManagedThoughtOption only matches exactly one 'default' entry", () => {
  assert.equal(
    isProviderManagedThoughtOption({ options: [{ value: "default", name: "d" }] }),
    true,
  );
  assert.equal(isProviderManagedThoughtOption({ options: [{ value: "low", name: "l" }] }), false);
  assert.equal(
    isProviderManagedThoughtOption({
      options: [
        { value: "default", name: "d" },
        { value: "low", name: "l" },
      ],
    }),
    false,
  );
  assert.equal(isProviderManagedThoughtOption({ options: [] }), false);
  assert.equal(isProviderManagedThoughtOption({}), false);
  assert.equal(isProviderManagedThoughtOption(null), false);
  assert.equal(isProviderManagedThoughtOption(undefined), false);
});

test("validateModelSelectionOptions still accepts 'default' for a single-default model", () => {
  const model = { config: { optionSpecs: { reasoningLevel: { values: ["default"] } } } };
  assert.deepEqual(
    validateModelSelectionOptions(model, {
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      options: { reasoningLevel: "default" },
    }),
    { ok: true },
  );
});

test("validateModelSelectionOptions still rejects a missing level", () => {
  const model = { config: { optionSpecs: { reasoningLevel: { values: ["default"] } } } };
  assert.deepEqual(
    validateModelSelectionOptions(model, { providerId: PROVIDER_ID, modelId: MODEL_ID }),
    {
      ok: false,
      code: "reasoning-level-missing",
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
    },
  );
});

test("validateModelSelectionOptions still rejects a level outside the declared ladder", () => {
  const model = { config: { optionSpecs: { reasoningLevel: { values: ["default"] } } } };
  assert.deepEqual(
    validateModelSelectionOptions(model, {
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      options: { reasoningLevel: "low" },
    }),
    {
      ok: false,
      code: "reasoning-level-not-supported",
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      reasoningLevel: "low",
      supportedLevels: ["default"],
    },
  );
});

test("'default' resolves to the localized label id in both locales", () => {
  const labelId = thoughtLevelLabelId("default");
  assert.equal(labelId, "chat.toolbar.thoughtLevel.value.default");
  assert.equal(thoughtLevelLabelId("DEFAULT"), labelId, "lookup normalizes case");
  assert.ok(enUS[labelId!], "en-US must define the label");
  assert.ok(zhCN[labelId!], "zh-CN must define the label");
  assert.notEqual(enUS[labelId!], zhCN[labelId!]);
});

test("en-US and zh-CN agree on the thought-level label key set", () => {
  const collect = (locale: Record<string, string>) =>
    Object.keys(locale)
      .filter((key) => key.startsWith("chat.toolbar.thoughtLevel."))
      .sort();
  assert.deepEqual(collect(zhCN), collect(enUS));
  assert.ok(collect(enUS).length > 0);
});
