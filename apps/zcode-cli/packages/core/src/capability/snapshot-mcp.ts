// MCP / plugin 能力投影。插件在这里只是 provenance：ZCode 兼容插件贡献 MCP server，
// 投影出的能力以 server 为单位，并带上 pluginId；兼容标识（mcp__ 名、plugin id）原样保留。
import type { Capability, ModelToolContract, PluginReferenceCatalog } from "@zcode/contracts";
import { COMPUTER_MCP_PREFIX } from "./computer.js";
import { THIS_DEVICE_TARGET } from "./domains.js";
import { toolContractAction } from "./actions.js";

export interface CapabilityMcpServerSource {
  serverName: string;
  /** McpServerStatus.status（connected / connecting / failed / disabled / needs_auth …）。 */
  status: string;
  error?: string;
}

export interface CapabilityMcpToolSource {
  serverName: string;
  toolName: string;
  /** 注册到 ToolRegistry 的 provider-visible 名称。 */
  registeredName: string;
}

const MCP_NAME_PATTERN = /^mcp__(.+?)__.+$/u;
const MAX_ERROR_CHARS = 160;

function serverForTool(
  toolName: string,
  byRegisteredName: ReadonlyMap<string, string>,
): string | undefined {
  return byRegisteredName.get(toolName) ?? MCP_NAME_PATTERN.exec(toolName)?.[1];
}

function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length >= 3 && token !== "plugin" && token !== "mcp");
}

function unavailableReason(
  server: CapabilityMcpServerSource | undefined,
  serverName: string,
  visibleCount: number,
): string | undefined {
  if (server && server.status !== "connected") {
    const detail = server.error ? `: ${server.error.slice(0, MAX_ERROR_CHARS)}` : "";
    return `MCP server "${serverName}" is ${server.status}${detail}`;
  }
  if (visibleCount === 0) {
    return `MCP server "${serverName}" has no tools visible in this session (filtered by allow/deny rules or not listed yet)`;
  }
  return undefined;
}

function isProjectedElsewhere(serverName: string, toolNames: readonly string[]): boolean {
  // 官方 CUA server 投影进 computer.local；node_repl 宿主是 Computer/Browser 的执行面。
  return (
    toolNames.some((name) => name.startsWith(COMPUTER_MCP_PREFIX)) ||
    serverName === "node_repl" ||
    serverName.endsWith(":node_repl")
  );
}

export function projectMcpCapabilities(input: {
  tools: readonly ModelToolContract[];
  servers: readonly CapabilityMcpServerSource[];
  mcpTools: readonly CapabilityMcpToolSource[];
  catalog?: PluginReferenceCatalog;
}): Capability[] {
  const byRegisteredName = new Map(
    input.mcpTools.map((tool) => [tool.registeredName, tool.serverName] as const),
  );
  const visibleByServer = new Map<string, ModelToolContract[]>();
  for (const tool of input.tools) {
    if (!tool.name.startsWith("mcp__")) continue;
    const serverName = serverForTool(tool.name, byRegisteredName);
    if (!serverName) continue;
    visibleByServer.set(serverName, [...(visibleByServer.get(serverName) ?? []), tool]);
  }
  const statusByServer = new Map(input.servers.map((server) => [server.serverName, server]));
  const serverNames = [...new Set([...statusByServer.keys(), ...visibleByServer.keys()])].sort();

  const capabilities: Capability[] = [];
  for (const serverName of serverNames) {
    const visible = visibleByServer.get(serverName) ?? [];
    if (
      isProjectedElsewhere(
        serverName,
        visible.map((tool) => tool.name),
      )
    )
      continue;
    const plugin = input.catalog?.plugins.find(
      (entry) => entry.enabled && entry.mcpServerNames.includes(serverName),
    );
    const reason = unavailableReason(statusByServer.get(serverName), serverName, visible.length);
    capabilities.push({
      id: `mcp.${serverName}`,
      domain: "mcp",
      displayName: plugin ? `${plugin.name} (MCP ${serverName})` : `MCP ${serverName}`,
      source: plugin ? "plugin" : "mcp",
      // 断开的 server 不宣传动作：只给原因。
      actions: reason ? [] : visible.map(toolContractAction),
      availability: reason ? "unavailable" : "available",
      ...(reason ? { unavailableReason: reason } : {}),
      executionTargets: [THIS_DEVICE_TARGET],
      relatedSkills: [],
      providerVisible: !reason,
      ...(plugin ? { pluginId: plugin.pluginId } : {}),
      mcpServer: serverName,
      keywords: [
        ...new Set([...nameTokens(serverName), ...(plugin ? nameTokens(plugin.name) : [])]),
      ],
    });
  }
  return capabilities;
}
