// runtime 持有的能力读缓存形状（目标列表 TTL + 最近一次 MCP 状态）。只是读缓存，不是能力状态。
import type { ExecutionTargetInfo } from "@zcode/contracts";
import type { CapabilityMcpServerSource, CapabilityMcpToolSource } from "./snapshot-mcp.js";

export interface CapabilityRuntimeCache {
  targets?: { value: readonly ExecutionTargetInfo[]; at: number };
  targetsRefresh?: Promise<boolean>;
  mcpServers?: CapabilityMcpServerSource[];
  mcpTools?: CapabilityMcpToolSource[];
}
