import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { registerMcpTools } from "../../core/src/mcp/index.ts";
import { createToolRegistry } from "../../core/src/tool/registry.ts";
import { toAiSdkTools } from "../src/model/tool-transform.ts";
import { ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME } from "@zcode/shared";

const PROVIDERS = ["openai", "openai-compatible", "anthropic"];
const names = ["mcp__computer-use__computer_press", "mcp__computer-use__computer_set_value"];

function contracts(executorEffect = "unknown") {
  return [
    {
      name: names[0],
      description: "Press an observation-derived semantic target.",
      inputSchema: {
        type: "object",
        properties: { semantic_ref: { type: "string" } },
        required: ["semantic_ref"],
        additionalProperties: false,
      },
      execute: async (input) => ({
        operation: "press",
        route: "accessibility_action",
        classification: "BEST_EFFORT_BACKGROUND",
        effect: executorEffect,
        evidence: [{ kind: "semantic_action", semantic_ref: input.semantic_ref }],
      }),
    },
    {
      name: names[1],
      description: "Set an observation-derived semantic target value.",
      inputSchema: {
        type: "object",
        properties: {
          semantic_ref: { type: "string" },
          value: { type: ["string", "number", "boolean"] },
        },
        required: ["semantic_ref", "value"],
        additionalProperties: false,
      },
      execute: async (input) => ({
        operation: "set_value",
        route: "accessibility_action",
        classification: "BEST_EFFORT_BACKGROUND",
        effect: executorEffect,
        evidence: [{ kind: "semantic_action", semantic_ref: input.semantic_ref }],
      }),
    },
  ];
}

describe("Computer Use AI SDK provider projections", () => {
  it("projects the existing official MCP descriptor identically through MCP registration and provider adapters", () => {
    const registry = createToolRegistry();
    const registered = registerMcpTools(registry, { callTool: async () => ({ content: [] }) }, [
      {
        name: "mcp__plugin_computer-use_computer-use__computer_press",
        serverName: ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME,
        toolName: "computer.press",
        description: "Press an observation-derived semantic target.",
        inputSchema: {
          type: "object",
          properties: { semantic_ref: { type: "string" } },
          required: ["semantic_ref"],
          additionalProperties: false,
        },
        annotations: { destructiveHint: true },
      },
      {
        name: "mcp__plugin_computer-use_computer-use__computer_set_value",
        serverName: ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME,
        toolName: "computer.set_value",
        description: "Set an observation-derived semantic target value.",
        inputSchema: {
          type: "object",
          properties: {
            semantic_ref: { type: "string" },
            value: { type: ["string", "number", "boolean"] },
          },
          required: ["semantic_ref", "value"],
          additionalProperties: false,
        },
        annotations: { destructiveHint: true },
      },
    ], { officialCuaServerNames: new Set([ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME]) });
    assert.deepEqual(registered, names);
    const contractsFromMcp = registry.toContracts();
    const projections = PROVIDERS.map((providerKind) =>
      toAiSdkTools(contractsFromMcp, { providerKind }),
    );
    for (const projection of projections) {
    assert.deepEqual(Object.keys(projection), names);
      assert.ok(projection[names[0]]);
      assert.ok(projection[names[1]]);
    }
  });

  it("preserves the canonical MCP executor result envelope", async () => {
    const registry = createToolRegistry();
    registerMcpTools(
      registry,
      {
        callTool: async () => ({
          content: [{ type: "text", text: "effect=unknown" }],
          structuredContent: {
            operation: "press",
            route: "accessibility_action",
            classification: "BEST_EFFORT_BACKGROUND",
            effect: "unknown",
            evidence: [{ kind: "semantic_action", verification: "unproven" }],
          },
        }),
      },
      [
        {
          name: "mcp__plugin_computer-use_computer-use__computer_press",
          serverName: ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME,
          toolName: "computer.press",
          description: "Press an observation-derived semantic target.",
          inputSchema: {
            type: "object",
            properties: { semantic_ref: { type: "string" } },
            required: ["semantic_ref"],
            additionalProperties: false,
          },
          annotations: { destructiveHint: true },
        },
      ],
      { officialCuaServerNames: new Set([ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME]) },
    );
    const entry = registry.get(names[0]);
    const result = await entry.handler(
      { semantic_ref: "observation-ref" },
      {
        traceId: "trace",
        spanId: "span",
        parentSpanId: undefined,
        sessionId: "session",
        turnId: "turn",
        workingDirectory: "/workspace",
        abortSignal: new AbortController().signal,
        runtimeScope: "main",
        workspaceIdentity: "workspace-identity",
        remoteSessionId: "remote-session",
        clientMode: "desktop-continuous",
        deliveryKind: "desktop-continuous",
      },
    );
    assert.equal(result.structuredContent.effect, "unknown");
    assert.equal(result.structuredContent.classification, "BEST_EFFORT_BACKGROUND");
    assert.equal(result.structuredContent.evidence[0].verification, "unproven");
    assert.equal(result.isError, undefined);
  });

  it("returns executor-owned effects unchanged for each provider adapter", async () => {
    for (const providerKind of PROVIDERS) {
      for (const [name, input] of [
        [names[0], { semantic_ref: "opaque-ref", effect: "confirmed" }],
        [names[1], { semantic_ref: "opaque-ref", value: "x", effect: "confirmed" }],
      ]) {
        for (const expectedEffect of ["confirmed", "unknown", "refused"]) {
          const projected = toAiSdkTools(contracts(expectedEffect), { providerKind });
          const result = await projected[name].execute(input, {
            toolCallId: "fixture-call",
            abortSignal: new AbortController().signal,
          });
          assert.equal(result.effect, expectedEffect, `${providerKind}/${name}`);
          assert.equal(result.evidence[0].semantic_ref, "opaque-ref");
        }
      }
    }
  });
});
