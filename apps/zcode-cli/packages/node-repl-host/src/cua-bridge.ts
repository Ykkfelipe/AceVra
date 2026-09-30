// 兼容层：Computer Use bridge 协议实现已移到 @zcode/zcode-cua/node-repl-cua-bridge。
//
// 两个合法 node_repl 执行面（MCP 宿主 / core 内置 handler）必须共用同一份 bridge 协议；
// 本文件只保留宿主侧的窄类型与一次性适配，不再持有实现，避免再次漂移。
import {
  CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE,
  NODE_REPL_CUA_BRIDGE_SYMBOL,
  createComputerUseBridgeGlobals as createSharedComputerUseBridgeGlobals,
  prepareComputerUseRuntimeGlobals as prepareSharedComputerUseRuntimeGlobals,
  type ActiveCuaNodeReplCall as SharedActiveCuaNodeReplCall,
  type ComputerUseRuntimeBridge,
  type NodeReplCuaBrokerConnection,
} from "@zcode/zcode-cua/node-repl-cua-bridge";
import type { NodeReplRequestMeta, NodeReplSession } from "@zcode/core";

export { NODE_REPL_CUA_BRIDGE_SYMBOL, CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE };
export type { ComputerUseRuntimeBridge, NodeReplCuaBrokerConnection };

export interface ActiveCuaNodeReplCall {
  generation: number;
  requestMeta: NodeReplRequestMeta;
  signal: AbortSignal;
}

/**
 * Install the host-provided `agent.computerUse` facade for the next cell.
 * 行为与共享实现完全一致（该实现即由本文件原样迁移而来）；这里只做宿主类型 → 共享结构类型的适配。
 */
export function createComputerUseBridgeGlobals(input: {
  broker?: NodeReplCuaBrokerConnection;
  generation: number;
  getActiveCall: () => ActiveCuaNodeReplCall | undefined;
  session: () => NodeReplSession;
  documentationRoot: string;
}): Record<PropertyKey, unknown> {
  return createSharedComputerUseBridgeGlobals({
    ...input,
    getActiveCall: () =>
      input.getActiveCall() as SharedActiveCuaNodeReplCall | undefined,
    session: () => input.session(),
  });
}

/** Same shape the plugin's compatibility bootstrap builds from the bridge. */
export function prepareComputerUseRuntimeGlobals(
  globals: Record<PropertyKey, unknown>,
): void {
  prepareSharedComputerUseRuntimeGlobals(globals);
}
