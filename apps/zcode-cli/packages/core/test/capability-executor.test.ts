/**
 * Capability runtime 与执行器的集成：结构化 not-found、Capabilities 工具、注册门。
 *
 * Run: mise exec -- node --import tsx --test apps/zcode-cli/packages/core/test/capability-executor.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CapabilitySnapshot, SessionId } from "@zcode/contracts";
import { buildCapabilitySnapshot, explainUnknownTool } from "../src/capability/index.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor/impl.js";
import { capabilitiesToolEntry } from "../src/tool/handlers/capabilities.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

function snapshotFor(toolNames: string[]): CapabilitySnapshot {
  return buildCapabilitySnapshot({
    tools: toolNames.map((name) => ({ name, inputSchema: { type: "object" } })),
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
}

function executor(explain?: (name: string) => ReturnType<typeof explainUnknownTool>) {
  const registry = createToolRegistry();
  registerBuiltInTools(registry, { includeCapabilities: true });
  return createToolExecutor({
    registry,
    permissionService: new PermissionService(defaultPermissionConfig),
    emitEvent: async () => {},
    sessionId: "sess_capability_test" as SessionId,
    ...(explain ? { explainUnknownTool: explain } : {}),
  });
}

function modelText(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

test("unknown Computer spelling returns a structured capability_unavailable error", async () => {
  const snapshot = snapshotFor(["Read", "js"]);
  const result = await executor((name) => explainUnknownTool(name, snapshot)).execute({
    id: "call_1",
    name: "type_text",
    input: { text: "cats" },
  });
  assert.equal(result.success, false);
  const text = modelText(result.modelContent);
  assert.match(text, /^<tool_use_error>\{/u);
  const payload = JSON.parse(text.replace(/^<tool_use_error>|<\/tool_use_error>$/gu, "")) as {
    code: string;
    suggestions: string[];
  };
  assert.equal(payload.code, "capability_unavailable");
  assert.match(payload.suggestions[0] ?? "", /computer\.workspace_type_text/u);
});

test("without an explainer the legacy not-found message is kept", async () => {
  const result = await executor().execute({ id: "call_2", name: "nope", input: {} });
  assert.equal(result.success, false);
  assert.match(result.error?.message ?? "", /Tool not found: nope/u);
});

test("an explainer that throws never breaks error pairing", async () => {
  const result = await executor(() => {
    throw new Error("boom");
  }).execute({ id: "call_3", name: "nope", input: {} });
  assert.equal(result.success, false);
  assert.equal(result.toolCallId, "call_3");
});

test("Capabilities registers only behind its gate", () => {
  const gated = createToolRegistry();
  registerBuiltInTools(gated, {});
  assert.equal(gated.has("Capabilities"), false);
  const open = createToolRegistry();
  registerBuiltInTools(open, { includeCapabilities: true });
  assert.equal(open.has("Capabilities"), true);
  assert.equal(open.getMetadata("Capabilities")?.readOnly, true);
});

test("Capabilities tool filters by domain and id and hides schemas in list mode", async () => {
  const snapshot = snapshotFor(["Read", "js", "mcp__figma__use_figma"]);
  const context = {
    toolCallId: "call_cap",
    capabilityQueryPort: { snapshot: async () => snapshot },
  } as unknown as ToolExecutionContext;
  const listed = (await capabilitiesToolEntry.handler({ domain: "computer" }, context)) as {
    capabilities: { id: string; actions: { inputSchema?: unknown }[] }[];
  };
  assert.deepEqual(
    listed.capabilities.map((c) => c.id),
    ["computer.local"],
  );
  const one = (await capabilitiesToolEntry.handler({ capability: "mcp.figma" }, context)) as {
    capabilities: { id: string; actions: { canonicalName: string; inputSchema?: unknown }[] }[];
  };
  assert.equal(one.capabilities[0]?.actions[0]?.canonicalName, "mcp__figma__use_figma");
  assert.deepEqual(one.capabilities[0]?.actions[0]?.inputSchema, { type: "object" });
  const available = (await capabilitiesToolEntry.handler(
    { includeUnavailable: false },
    context,
  )) as {
    capabilities: { availability: string }[];
  };
  assert.ok(available.capabilities.every((c) => c.availability === "available"));
});
