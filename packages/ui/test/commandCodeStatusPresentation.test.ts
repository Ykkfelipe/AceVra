import assert from "node:assert/strict";
import test from "node:test";
import type { CommandCodeStatus } from "@zcode/services";
import { resolveCommandCodeCliMetadata } from "../src/settings/model-provider-section/commandCodeStatusPresentation.js";

function status(overrides: Partial<CommandCodeStatus>): CommandCodeStatus {
  return {
    installed: true,
    authenticated: true,
    usageUnavailable: true,
    usageUnavailableReason: "not available through the local CLI surface",
    checkedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("retains the supported default model and context window as compact metadata", () => {
  assert.deepEqual(
    resolveCommandCodeCliMetadata(
      status({ defaultModel: "deepseek/deepseek-v4-flash", contextWindow: 1_000_000 }),
      "en-US",
    ),
    { defaultModel: "deepseek/deepseek-v4-flash", contextWindow: "1,000,000" },
  );
});

test("does not invent Command Code metadata when the CLI omitted it", () => {
  assert.deepEqual(resolveCommandCodeCliMetadata(status({}), "en-US"), {});
  assert.deepEqual(
    resolveCommandCodeCliMetadata(status({ defaultModel: "deepseek/deepseek-v4-flash" }), "en-US"),
    { defaultModel: "deepseek/deepseek-v4-flash" },
  );
});
