// 会话能力快照：权威注册表的纯投影（无 I/O、无可变状态）。
// 调用方（runtime）负责收集 sources；同样的 sources 必然得到同样的快照，便于测试与回放。
import type {
  Capability,
  CapabilitySnapshot,
  ModelToolContract,
  PluginReferenceCatalog,
  SelectedExecutionTarget,
} from "@zcode/contracts";
import { toolContractAction } from "./actions.js";
import { projectComputerCapability, type ComputerCapabilitySource } from "./computer.js";
import {
  projectBrowserCapability,
  projectTargetCapabilities,
  type CapabilityExecutionTargetSource,
} from "./snapshot-targets.js";
import {
  projectMcpCapabilities,
  type CapabilityMcpServerSource,
  type CapabilityMcpToolSource,
} from "./snapshot-mcp.js";
import { attachRelatedSkills, type CapabilitySkillSource } from "./skills.js";
import {
  CAPABILITY_META_TOOLS,
  NATIVE_DOMAIN_SPECS,
  NODE_REPL_TOOL,
  THIS_DEVICE_TARGET,
  nativeDomainSpecForTool,
} from "./domains.js";

export type { CapabilityMcpServerSource, CapabilityMcpToolSource } from "./snapshot-mcp.js";
export type { CapabilitySkillSource } from "./skills.js";
export type { CapabilityExecutionTargetSource } from "./snapshot-targets.js";

const NODE_REPL_MCP_TOOL_PATTERN = /^mcp__[A-Za-z0-9_-]*node_repl[A-Za-z0-9_-]*__js$/u;

export interface CapabilitySources {
  /** provider-visible 工具契约（ToolRegistry 经 allow/deny/toolset 过滤后的结果）。 */
  tools: readonly ModelToolContract[];
  mcpServers: readonly CapabilityMcpServerSource[];
  mcpTools: readonly CapabilityMcpToolSource[];
  pluginCatalog?: PluginReferenceCatalog;
  skills: readonly CapabilitySkillSource[];
  computer: Omit<ComputerCapabilitySource, "registeredToolNames" | "nodeReplToolName">;
  browser: { enabled: boolean };
  executionTargets: CapabilityExecutionTargetSource;
  /** 发现耗时由调用方测量（含异步收集），写入 diagnostics。 */
  discoveryMs?: number;
}

export function resolveNodeReplToolName(tools: readonly ModelToolContract[]): string | undefined {
  if (tools.some((tool) => tool.name === NODE_REPL_TOOL)) return NODE_REPL_TOOL;
  return tools.find((tool) => NODE_REPL_MCP_TOOL_PATTERN.test(tool.name))?.name;
}

function shellRetargetReason(selected: SelectedExecutionTarget): string {
  const name = selected.displayName ? `"${selected.displayName}"` : selected.targetId;
  return `this conversation is bound to the computer ${name}; run shell commands there with RunOnTarget (targetId "${selected.targetId}") — Bash refuses and never runs them on this Mac`;
}

function projectNativeCapabilities(
  tools: readonly ModelToolContract[],
  selected: SelectedExecutionTarget | undefined,
): Capability[] {
  const capabilities: Capability[] = [];
  const claimed = new Set<string>();
  for (const spec of NATIVE_DOMAIN_SPECS) {
    const contracts = tools.filter((tool) => spec.tools.includes(tool.name));
    if (contracts.length === 0) continue;
    for (const contract of contracts) claimed.add(contract.name);
    const actions = contracts.map((contract) => {
      const action = toolContractAction(contract);
      if (contract.name === "Bash" && selected) {
        return {
          ...action,
          availability: "unavailable" as const,
          unavailableReason: shellRetargetReason(selected),
        };
      }
      return action;
    });
    capabilities.push({
      id: spec.id,
      domain: spec.domain,
      displayName: spec.displayName,
      source: "native",
      actions,
      availability: "available",
      executionTargets: [THIS_DEVICE_TARGET],
      relatedSkills: [],
      providerVisible: true,
      keywords: [],
    });
  }
  const other = tools.filter(
    (tool) =>
      !claimed.has(tool.name) &&
      !tool.name.startsWith("mcp__") &&
      !CAPABILITY_META_TOOLS.has(tool.name) &&
      nativeDomainSpecForTool(tool.name) === undefined,
  );
  if (other.length > 0) {
    capabilities.push({
      id: "native.other",
      domain: "other",
      displayName: "Other tools",
      source: "native",
      actions: other.map(toolContractAction),
      availability: "available",
      executionTargets: [THIS_DEVICE_TARGET],
      relatedSkills: [],
      providerVisible: true,
      keywords: [],
    });
  }
  return capabilities;
}

function projectDisabledPlugins(catalog: PluginReferenceCatalog | undefined): Capability[] {
  return (catalog?.plugins ?? [])
    .filter((plugin) => !plugin.enabled)
    .map((plugin) => ({
      id: `plugin.${plugin.pluginId}`,
      domain: "other" as const,
      displayName: `Plugin ${plugin.name}`,
      source: "plugin" as const,
      // disabled Plugin 绝不把动作宣传为可用：不列任何动作。
      actions: [],
      availability: "unavailable" as const,
      unavailableReason: `plugin ${plugin.pluginId} is disabled in this session; the user can enable it in Settings → Plugins`,
      executionTargets: [],
      relatedSkills: [],
      providerVisible: false,
      pluginId: plugin.pluginId,
      keywords: [plugin.name.toLowerCase()],
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function buildCapabilitySnapshot(sources: CapabilitySources): CapabilitySnapshot {
  const registeredToolNames = new Set(sources.tools.map((tool) => tool.name));
  const nodeReplToolName = resolveNodeReplToolName(sources.tools);
  const selected = sources.executionTargets.selected;
  const capabilities: Capability[] = [
    projectComputerCapability({
      ...sources.computer,
      registeredToolNames,
      ...(nodeReplToolName ? { nodeReplToolName } : {}),
    }),
    projectBrowserCapability(sources.browser.enabled, nodeReplToolName),
    ...projectTargetCapabilities(sources.tools, sources.executionTargets),
    ...projectMcpCapabilities({
      tools: sources.tools,
      servers: sources.mcpServers,
      mcpTools: sources.mcpTools,
      catalog: sources.pluginCatalog,
    }),
    ...projectDisabledPlugins(sources.pluginCatalog),
    ...projectNativeCapabilities(sources.tools, selected),
  ];
  const withSkills = attachRelatedSkills(capabilities, sources.skills, sources.pluginCatalog);
  return {
    target: selected
      ? {
          kind: "remote",
          targetId: selected.targetId,
          ...(selected.displayName ? { displayName: selected.displayName } : {}),
        }
      : { kind: "local" },
    capabilities: withSkills,
    diagnostics: {
      discoveryMs: sources.discoveryMs ?? 0,
      capabilityCount: withSkills.length,
      availableActionCount: withSkills.reduce(
        (count, capability) =>
          count + capability.actions.filter((action) => action.availability === "available").length,
        0,
      ),
      targetListResolved: sources.executionTargets.listResolved,
    },
  };
}
