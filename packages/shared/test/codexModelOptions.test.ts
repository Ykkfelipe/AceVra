import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEX_MODEL_OPTIONS,
  codexModelOptionLabel,
  isCodexModelOptionId,
} from "../src/codex-execution.js";

test("the curated Codex model list is an exact, unique allow-list", () => {
  const ids = CODEX_MODEL_OPTIONS.map((option) => option.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, [
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
  ]);
  for (const option of CODEX_MODEL_OPTIONS) {
    assert.equal(typeof option.label, "string");
    assert.ok(option.label.length > 0);
  }
});

test("codex model id guard accepts only curated ids", () => {
  for (const option of CODEX_MODEL_OPTIONS) {
    assert.equal(isCodexModelOptionId(option.id), true);
  }
  assert.equal(isCodexModelOptionId(null), false);
  assert.equal(isCodexModelOptionId(42), false);
  assert.equal(isCodexModelOptionId(""), false);
  assert.equal(isCodexModelOptionId("gpt-4o"), false);
  assert.equal(isCodexModelOptionId("GLM-5.3-Flash"), false);
});

test("codex model label lookup covers curated ids and falls back verbatim", () => {
  assert.equal(codexModelOptionLabel("gpt-6-astra"), "GPT-6 Astra");
  assert.equal(codexModelOptionLabel("gpt-5.6-terra"), "GPT-5.6 Terra");
  assert.equal(codexModelOptionLabel("unknown-model"), "unknown-model");
});

test("codex effort tiers match the reviewed model-specific catalog", async () => {
  const { CODEX_EFFORT_OPTIONS, isCodexEffortOption } = await import("../src/codex-execution.js");
  assert.deepEqual([...CODEX_EFFORT_OPTIONS], ["low", "medium", "high", "xhigh", "max", "ultra"]);
  for (const value of CODEX_EFFORT_OPTIONS) {
    assert.equal(isCodexEffortOption(value), true);
  }
  assert.equal(isCodexEffortOption("minimal"), false);
  assert.equal(isCodexEffortOption(""), false);
  assert.equal(isCodexEffortOption(null), false);
});
