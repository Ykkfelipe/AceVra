import { CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE, NODE_REPL_CUA_BRIDGE_SYMBOL, type ComputerUseRuntimeBridge, type NodeReplCuaBrokerConnection } from "@zcode/zcode-cua/node-repl-cua-bridge";
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
export declare function createComputerUseBridgeGlobals(input: {
    broker?: NodeReplCuaBrokerConnection;
    generation: number;
    getActiveCall: () => ActiveCuaNodeReplCall | undefined;
    session: () => NodeReplSession;
    documentationRoot: string;
}): Record<PropertyKey, unknown>;
/** Same shape the plugin's compatibility bootstrap builds from the bridge. */
export declare function prepareComputerUseRuntimeGlobals(globals: Record<PropertyKey, unknown>): void;
//# sourceMappingURL=cua-bridge.d.ts.map