// Capability runtime 的 provider 中立性（core/specs/capability-runtime.md "Provider projection"）：
// 同一份规范能力状态（Capabilities 工具契约 + 提醒文本）只在 adapter 边界翻译，
// GPT / Claude / GLM / DeepSeek（openai-compatible）与需要 MFJS schema 的 provider 都能消费。
//
// Run: mise exec -- node --import tsx --test apps/zcode-cli/packages/adapters/test/capability-provider-projection.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCapabilitySnapshot,
  renderCapabilityContext,
  selectRelevantCapabilities,
} from "../../core/src/capability/index.ts";
import { registerBuiltInTools } from "../../core/src/tool/handlers/index.ts";
import { createToolRegistry } from "../../core/src/tool/registry.ts";
import { toAiSdkTools } from "../src/model/tool-transform.ts";

const PROVIDERS = [
  { providerKind: "openai" },
  { providerKind: "anthropic", modelId: "claude-sonnet-5-5" },
  // GLM / DeepSeek / Azure / Command Code 都走 openai-compatible。
  { providerKind: "openai-compatible" },
  { providerKind: "openai-compatible", requiresMfjsToolSchema: true },
  { providerKind: "gateway" },
];

function capabilityContracts() {
  const registry = createToolRegistry();
  registerBuiltInTools(registry, { includeCapabilities: true, includeNodeRepl: true });
  return registry.toContracts();
}

test("Capabilities tool contract projects identically for every provider adapter", () => {
  const contracts = capabilityContracts();
  const capabilities = contracts.find((contract) => contract.name === "Capabilities");
  assert.ok(capabilities, "Capabilities contract missing");
  for (const options of PROVIDERS) {
    const tools = toAiSdkTools(contracts, options);
    assert.ok(tools?.Capabilities, `${options.providerKind}: Capabilities missing`);
    assert.ok(tools?.js, `${options.providerKind}: js missing`);
    const schema = tools.Capabilities.inputSchema.jsonSchema;
    assert.equal(schema.type, "object", options.providerKind);
    assert.deepEqual(
      Object.keys(schema.properties).sort(),
      ["capability", "domain", "includeUnavailable"],
      options.providerKind,
    );
  }
});

test("canonical capability context is provider-independent plain text", () => {
  const tools = capabilityContracts();
  const snapshot = buildCapabilitySnapshot({
    tools,
    mcpServers: [],
    mcpTools: [],
    skills: [],
    computer: {
      featureEnabled: true,
      helperConnected: true,
      platform: "darwin",
      runtimeScope: "main",
      foregroundAvailable: false,
    },
    browser: { enabled: false },
    executionTargets: { portPresent: false, listResolved: false },
  });
  const text = renderCapabilityContext(
    snapshot,
    selectRelevantCapabilities(snapshot, {
      text: "Open Chrome in the background and search for cats",
    }),
  );
  assert.ok(text);
  // 动作名在每个 provider 的工具表里都不存在拼写差异：调用面是 js 工具。
  assert.match(text, /inside the `js` tool/u);
  for (const options of PROVIDERS) {
    assert.ok(toAiSdkTools(tools, options)?.js, `${options.providerKind}: js tool not projected`);
  }
});
