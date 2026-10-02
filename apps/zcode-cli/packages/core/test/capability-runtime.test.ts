/**
 * Capability runtime 确定性夹具（core/specs/capability-runtime.md "Acceptance"）。
 *
 * Run: mise exec -- node --import tsx --test apps/zcode-cli/packages/core/test/capability-runtime.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExecutionTargetInfo,
  ModelToolContract,
  PluginReferenceCatalog,
} from "@zcode/contracts";
import {
  PROTECTED_FOREGROUND_REASON,
  NO_TARGETS_REASON,
  buildCapabilitySnapshot,
  explainUnknownTool,
  renderCapabilityContext,
  selectRelevantCapabilities,
  type CapabilitySources,
} from "../src/capability/index.js";

function tool(name: string, extra: Partial<ModelToolContract> = {}): ModelToolContract {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    ...extra,
  };
}

const NATIVE = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "WebFetch",
  "Skill",
  "TodoWrite",
  "js",
];
const TARGET_TOOLS = ["ExecutionTargets", "RunOnTarget", "TargetTask", "RemoteComputer"];

const DELL: ExecutionTargetInfo = {
  id: "node-dell",
  type: "ssh",
  displayName: "Dell",
  online: true,
  available: true,
  capabilities: ["process", "computerUse"],
  isThisDevice: false,
};

const CATALOG: PluginReferenceCatalog = {
  plugins: [
    {
      pluginId: "computer-use@zcode-plugins-official",
      name: "computer-use",
      marketplace: "zcode-plugins-official",
      enabled: true,
      conflictingPluginIds: [],
      skillQualifiedNames: ["computer-use:computer-use"],
      mcpServerNames: [],
      subagentNames: [],
      rootPath: "/plugins/computer-use",
    },
    {
      pluginId: "figma@market",
      name: "figma",
      marketplace: "market",
      enabled: true,
      conflictingPluginIds: [],
      skillQualifiedNames: [],
      mcpServerNames: ["plugin:figma:figma"],
      subagentNames: [],
      rootPath: "/plugins/figma",
    },
    {
      pluginId: "linear@market",
      name: "linear",
      marketplace: "market",
      enabled: false,
      conflictingPluginIds: [],
      skillQualifiedNames: [],
      mcpServerNames: [],
      subagentNames: [],
      rootPath: "/plugins/linear",
    },
  ],
};

function sources(overrides: Partial<CapabilitySources> = {}): CapabilitySources {
  return {
    tools: [
      ...NATIVE.map((name) => tool(name)),
      tool("mcp__plugin_figma_figma__get_screenshot", { readOnly: true }),
      tool("mcp__plugin_figma_figma__use_figma"),
    ],
    mcpServers: [
      { serverName: "plugin:figma:figma", status: "connected" },
      { serverName: "notion", status: "failed", error: "connect ECONNREFUSED" },
    ],
    mcpTools: [
      {
        serverName: "plugin:figma:figma",
        toolName: "get_screenshot",
        registeredName: "mcp__plugin_figma_figma__get_screenshot",
      },
      {
        serverName: "plugin:figma:figma",
        toolName: "use_figma",
        registeredName: "mcp__plugin_figma_figma__use_figma",
      },
    ],
    pluginCatalog: CATALOG,
    skills: [
      {
        name: "computer-use",
        qualifiedName: "computer-use:computer-use",
        pluginName: "computer-use",
        pluginId: "computer-use@zcode-plugins-official",
        description: "Computer Use guidance",
      },
      { name: "pdf", qualifiedName: "anthropic-skills:pdf", description: "PDF skill" },
    ],
    computer: {
      featureEnabled: true,
      helperConnected: true,
      platform: "darwin",
      runtimeScope: "main",
      foregroundAvailable: false,
    },
    browser: { enabled: false },
    executionTargets: { portPresent: false, listResolved: false },
    ...overrides,
  };
}

function capability(snapshotSources: CapabilitySources, id: string) {
  const found = buildCapabilitySnapshot(snapshotSources).capabilities.find((c) => c.id === id);
  assert.ok(found, `capability ${id} missing`);
  return found;
}

test("A: Chrome background request selects local Computer with exact canonical actions", () => {
  const snapshot = buildCapabilitySnapshot(sources());
  const selection = selectRelevantCapabilities(snapshot, {
    text: "Open Chrome in the background and search for cats.",
  });
  const ids = selection.selected.map((entry) => entry.capabilityId);
  assert.deepEqual(ids, ["computer.local"]);
  assert.deepEqual(selection.selected[0]!.reasons, ["keyword:chrome", "keyword:in the background"]);

  const text = renderCapabilityContext(snapshot, selection);
  assert.ok(text);
  for (const name of [
    "computer.open_app",
    "computer.workspace_type_text",
    "computer.workspace_confirm",
    "computer.workspace_click",
    "get_app_state",
  ]) {
    assert.match(text, new RegExp(`- ${name.replace(".", "\\.")} \\{`), `missing ${name}`);
  }
  assert.match(text, /agent\.computerUse\["<name>"\]\(args\)/u);
  assert.match(text, /Not available here: computer\.acquire_control,.*computer\.key_press/u);
  assert.ok(text.includes(PROTECTED_FOREGROUND_REASON));
  assert.match(text, /Related skills.*computer-use:computer-use/u);
  assert.doesNotMatch(text, /RemoteComputer|remote_computer/u);
});

test("A: foreground actions are unavailable with the Protected Foreground reason", () => {
  const computer = capability(sources(), "computer.local");
  const acquire = computer.actions.find((a) => a.canonicalName === "computer.acquire_control");
  assert.equal(acquire?.availability, "unavailable");
  assert.equal(acquire?.unavailableReason, PROTECTED_FOREGROUND_REASON);
  const typeText = computer.actions.find((a) => a.canonicalName === "computer.workspace_type_text");
  assert.equal(typeText?.availability, "available");
  assert.equal(typeText?.argsHint, "{ pid: integer, text: string, target_label?: string }");
  assert.deepEqual(computer.executionTargets, ["this-device"]);
});

test("Computer in a subagent is unavailable with a truthful reason", () => {
  const computer = capability(
    sources({
      computer: {
        featureEnabled: true,
      helperConnected: true,
        platform: "darwin",
        runtimeScope: "subagent",
        foregroundAvailable: false,
      },
    }),
    "computer.local",
  );
  assert.equal(computer.availability, "unavailable");
  assert.match(computer.unavailableReason ?? "", /not available in subagents/u);
  assert.ok(computer.actions.every((a) => a.availability === "unavailable"));
});

test("plugin enabled without a connected Helper is unavailable, not advertised", () => {
  const computer = capability(
    sources({
      computer: {
        featureEnabled: true,
        helperConnected: false,
        platform: "darwin",
        runtimeScope: "main",
        foregroundAvailable: false,
      },
    }),
    "computer.local",
  );
  assert.equal(computer.availability, "unavailable");
  assert.match(computer.unavailableReason ?? "", /Helper is not connected/u);
  const snapshot = buildCapabilitySnapshot(
    sources({
      computer: {
        featureEnabled: true,
        helperConnected: false,
        platform: "darwin",
        runtimeScope: "main",
        foregroundAvailable: false,
      },
    }),
  );
  const text = renderCapabilityContext(
    snapshot,
    selectRelevantCapabilities(snapshot, { text: "Open Chrome in the background" }),
  );
  assert.match(text ?? "", /UNAVAILABLE \[id: computer\.local\]/u);
  assert.doesNotMatch(text ?? "", /computer\.workspace_type_text \{/u);
});

test("B: repo test request adds no reminder (shell/files already provider-visible)", () => {
  const snapshot = buildCapabilitySnapshot(sources());
  const selection = selectRelevantCapabilities(snapshot, {
    text: "Run the relevant tests for the current change.",
  });
  assert.equal(renderCapabilityContext(snapshot, selection), null);
});

test("B: bound execution target retargets Bash with the reason", () => {
  const snapshot = buildCapabilitySnapshot(
    sources({
      tools: [...NATIVE.map((n) => tool(n)), ...TARGET_TOOLS.map((n) => tool(n))],
      executionTargets: {
        portPresent: true,
        selected: { targetId: "node-dell", displayName: "Dell" },
        targets: [DELL],
        listResolved: true,
      },
    }),
  );
  assert.equal(snapshot.target.kind, "remote");
  const text = renderCapabilityContext(
    snapshot,
    selectRelevantCapabilities(snapshot, { text: "Run the tests" }),
  );
  assert.ok(text);
  assert.match(
    text,
    /Not available here: Bash — this conversation is bound to the computer "Dell"/u,
  );
  assert.match(text, /RunOnTarget/u);
});

test("C: MCP/plugin capability is discovered with exact tool names and plugin provenance", () => {
  const snapshot = buildCapabilitySnapshot(sources());
  const figma = snapshot.capabilities.find((c) => c.id === "mcp.plugin:figma:figma");
  assert.equal(figma?.source, "plugin");
  assert.equal(figma?.pluginId, "figma@market");
  assert.deepEqual(
    figma?.actions.map((a) => a.canonicalName),
    ["mcp__plugin_figma_figma__get_screenshot", "mcp__plugin_figma_figma__use_figma"],
  );
  const selection = selectRelevantCapabilities(snapshot, {
    text: "Take a screenshot of my figma frame",
  });
  assert.deepEqual(selection.selected[0], {
    capabilityId: "mcp.plugin:figma:figma",
    reasons: ["mcp_name:figma"],
  });
  const text = renderCapabilityContext(snapshot, selection);
  assert.match(text ?? "", /- mcp__plugin_figma_figma__use_figma/u);
  const byReference = selectRelevantCapabilities(snapshot, {
    text: "please help",
    pluginReferences: ["figma@market"],
  });
  assert.deepEqual(byReference.selected[0]?.reasons, ["plugin_reference:figma@market"]);
});

test("disconnected MCP and disabled plugins never advertise actions", () => {
  const snapshot = buildCapabilitySnapshot(sources());
  const notion = snapshot.capabilities.find((c) => c.id === "mcp.notion");
  assert.equal(notion?.availability, "unavailable");
  assert.deepEqual(notion?.actions, []);
  assert.match(notion?.unavailableReason ?? "", /"notion" is failed: connect ECONNREFUSED/u);
  const linear = snapshot.capabilities.find((c) => c.id === "plugin.linear@market");
  assert.equal(linear?.availability, "unavailable");
  assert.deepEqual(linear?.actions, []);
  const text = renderCapabilityContext(
    snapshot,
    selectRelevantCapabilities(snapshot, { text: "create a linear issue from my notion page" }),
  );
  assert.match(text ?? "", /linear@market is disabled in this session/u);
  assert.match(text ?? "", /MCP server "notion" is failed/u);
});

test("D: 'use my Dell' without execution targets is an explicit unavailable capability", () => {
  const snapshot = buildCapabilitySnapshot(sources());
  const selection = selectRelevantCapabilities(snapshot, { text: "Use my Dell to open Notepad" });
  const ids = selection.selected.map((entry) => entry.capabilityId);
  assert.deepEqual(ids.sort(), ["execution_targets", "remote_computer"]);
  const text = renderCapabilityContext(snapshot, selection);
  assert.ok(text?.includes(NO_TARGETS_REASON));
  assert.doesNotMatch(text ?? "", /computer\.workspace_click/u);
});

test("remote target names select RemoteComputer and suppress local Computer keywords", () => {
  const snapshot = buildCapabilitySnapshot(
    sources({
      tools: [...NATIVE.map((n) => tool(n)), ...TARGET_TOOLS.map((n) => tool(n))],
      executionTargets: { portPresent: true, targets: [DELL], listResolved: true },
    }),
  );
  const selection = selectRelevantCapabilities(snapshot, {
    text: "On the Dell, open Chrome and click the search box",
  });
  const ids = selection.selected.map((entry) => entry.capabilityId);
  assert.ok(ids.includes("remote_computer"));
  assert.ok(!ids.includes("computer.local"));
  const remote = snapshot.capabilities.find((c) => c.id === "remote_computer");
  assert.deepEqual(remote?.executionTargets, ["node-dell"]);
  assert.equal(remote?.availability, "available");
  const local = selectRelevantCapabilities(snapshot, { text: "Open Chrome on this Mac" });
  assert.deepEqual(
    local.selected.map((e) => e.capabilityId),
    ["computer.local"],
  );
});

test("PDF request attaches the files capability with the related pdf skill only", () => {
  const snapshot = buildCapabilitySnapshot(sources());
  const selection = selectRelevantCapabilities(snapshot, { text: "Edit this PDF" });
  assert.deepEqual(
    selection.selected.map((e) => e.capabilityId),
    ["native.files"],
  );
  const text = renderCapabilityContext(snapshot, selection) ?? "";
  assert.match(text, /Related skills .*: anthropic-skills:pdf$/mu);
  assert.doesNotMatch(text, /computer-use/u);
  // 已在工具表里的原生动作不重复描述。
  assert.doesNotMatch(text, /- Read/u);
});

test("guessed Computer spellings produce structured errors with canonical suggestions", () => {
  const snapshot = buildCapabilitySnapshot(sources());
  const typeText = explainUnknownTool("type_text", snapshot);
  assert.equal(typeText.code, "capability_unavailable");
  assert.equal(typeText.capability, "computer.local");
  assert.ok(typeText.reason.includes(PROTECTED_FOREGROUND_REASON));
  assert.match(typeText.suggestions[0] ?? "", /computer\.workspace_type_text/u);

  const keyPress = explainUnknownTool("mcp__computer-use__key_press", snapshot);
  assert.equal(keyPress.code, "capability_unavailable");
  assert.match(keyPress.suggestions[0] ?? "", /computer\.workspace_confirm/u);

  const press = explainUnknownTool("computer.press", snapshot);
  assert.equal(press.code, "tool_not_found");
  assert.match(press.reason, /called inside the js tool/u);
  assert.equal(
    press.suggestions[0],
    'js: await agent.computerUse["computer.press"]({ semantic_ref: string })',
  );

  const setValue = explainUnknownTool("set_value", snapshot);
  assert.match(setValue.suggestions[0] ?? "", /computer\.set_value/u);
  assert.ok(setValue.availableActions.includes("computer.workspace_confirm"));
});

test("unknown names fall back to similar available tools; disconnected MCP is explained", () => {
  const snapshot = buildCapabilitySnapshot(sources());
  const read = explainUnknownTool("read", snapshot);
  assert.match(read.reason, /case-sensitive: call "Read"/u);
  const notion = explainUnknownTool("mcp__notion__search", snapshot);
  assert.equal(notion.code, "capability_unavailable");
  assert.equal(notion.capability, "mcp.notion");
  const nothing = explainUnknownTool("frobnicate_widget", snapshot);
  assert.equal(nothing.code, "tool_not_found");
  assert.deepEqual(nothing.suggestions, []);
});

test("rendered context is bounded", () => {
  const snapshot = buildCapabilitySnapshot(sources());
  const selection = selectRelevantCapabilities(snapshot, {
    text: "Open Chrome in the background, then my figma and notion, and linear",
  });
  const text = renderCapabilityContext(snapshot, selection, 1500);
  assert.ok(text === null || Buffer.byteLength(text) <= 1500);
});
