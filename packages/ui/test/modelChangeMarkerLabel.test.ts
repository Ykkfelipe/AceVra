/**
 * 「Model switched X → Y」分隔线的渲染文案（apps/zcode-cli/packages/bootstrap/specs/model-change-divider.md）。
 * marker 载荷与 CLI 投影测试（model-change-divider.test.ts）产出的完全同形：方向只取 marker 的
 * from/to 字段，provider 名按当前目录解析。
 *
 * Run: TSX_TSCONFIG_PATH=packages/ui/tsconfig.json mise exec -- node --import tsx --test packages/ui/test/modelChangeMarkerLabel.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelectionView } from "@zcode/services";
import { formatModelChangeMarkerLabel } from "../src/v4/modelChangeMarkerLabel.js";
import enUS from "../src/i18n/locales/en-US.js";

const intl = {
  formatMessage(descriptor: { id: string }, values?: Record<string, unknown>): string {
    const template = (enUS as Record<string, string>)[descriptor.id] ?? descriptor.id;
    return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? ""));
  },
} as never;

const VIEW = {
  revision: 1,
  providers: [
    { providerId: "account:zai-individual-coding-plan", providerName: "Z.ai", models: [] },
    { providerId: "command-code", providerName: "Command Code", models: [] },
    { providerId: "azure-openai", providerName: "Azure OpenAI", models: [] },
  ],
} as unknown as ModelSelectionView;

const ZAI = { provider: "account:zai-individual-coding-plan", model: "GLM-5.3", thought: "max" };
const CC = { provider: "command-code", model: "gpt-5.6-sol", thought: "max" };
const AZURE = { provider: "azure-openai", model: "gpt-5-mini", thought: "low" };

function marker(from: typeof ZAI | null, to: typeof ZAI) {
  return {
    type: "modelChange" as const,
    ...(from ? { fromProvider: from.provider, fromModel: from.model } : {}),
    toProvider: to.provider,
    toModel: to.model,
    toThought: to.thought,
  } as never;
}

const label = (from: typeof ZAI | null, to: typeof ZAI) =>
  formatModelChangeMarkerLabel(marker(from, to), VIEW, intl);

test("A: Z.ai → Command Code keeps its direction (Z.ai shows its plan, per UI convention)", () => {
  assert.deepEqual(label(ZAI, CC), {
    sourceLess: false,
    label: "Model switched GLM-5.3(Individual Plan) → Command Code/gpt-5.6-sol",
  });
});

test("B: Command Code → Azure OpenAI", () => {
  assert.equal(
    label(CC, AZURE).label,
    "Model switched Command Code/gpt-5.6-sol → Azure OpenAI/gpt-5-mini",
  );
});

test("C: Azure OpenAI → another Agent provider stays in marker order", () => {
  assert.equal(
    label(AZURE, ZAI).label,
    "Model switched Azure OpenAI/gpt-5-mini → GLM-5.3(Individual Plan)",
  );
  assert.equal(
    label(AZURE, CC).label,
    "Model switched Azure OpenAI/gpt-5-mini → Command Code/gpt-5.6-sol",
  );
});

test("E: a reasoning-bearing destination renders provider and model, never the picker suffix", () => {
  const { label: text } = label(CC, AZURE);
  assert.ok(text.endsWith("→ Azure OpenAI/gpt-5-mini"));
  assert.ok(!text.includes("$low") && !text.includes("azure-openai"));
});

test("a source-less boundary renders 'Using X' without a switch", () => {
  assert.deepEqual(label(null, AZURE), {
    sourceLess: true,
    label: "Using Azure OpenAI/gpt-5-mini",
  });
});

test("unknown providers fall back to their id instead of dropping identity", () => {
  const text = formatModelChangeMarkerLabel(marker(CC, AZURE), null, intl).label;
  assert.equal(text, "Model switched command-code/gpt-5.6-sol → azure-openai/gpt-5-mini");
});
