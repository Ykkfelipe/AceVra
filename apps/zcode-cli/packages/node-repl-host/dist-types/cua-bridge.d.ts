import type { NodeReplRequestMeta, NodeReplSession } from "@zcode/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
export declare const NODE_REPL_CUA_BRIDGE_SYMBOL: unique symbol;
export declare const CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE = "Computer Use is not available in subagent";
export interface ActiveCuaNodeReplCall {
    generation: number;
    requestMeta: NodeReplRequestMeta;
    signal: AbortSignal;
}
export interface NodeReplCuaBrokerConnection {
    socketPath: string;
    token: string;
}
export interface ComputerUseRuntimeBridge {
    /** 私有 capability 请求；这里不是 MCP tool 调用，MCP 只承载外层 node_repl。 */
    call(method: string, input: unknown): Promise<CallToolResult>;
    assertAvailable(): void;
    documentationRoot: string;
}
/**
 * Install the host-provided `agent.computerUse` facade for the next cell.
 *
 * The computer-use skill's contract is that the shared node_repl host installs the client before
 * every cell ("start with the host-provided facade"), and the plugin's
 * `scripts/computer-use-client.mjs` is only the *compatibility* bootstrap for hosts that expose the
 * session bridge. Before this existed the bridge was reachable only through its symbol, so a model
 * following the skill saw `agent.computerUse === undefined` and — correctly, per the skill — stopped
 * with "Computer Use is unavailable", even though the broker session was fully provisioned.
 *
 * Mirrors `prepareBrowserRuntimeGlobals`: merge into the existing `agent` object instead of
 * replacing it, and stay a no-op when no bridge was captured, so a subagent or a session without
 * the CUA transport keeps exactly today's behaviour.
 */
export declare function prepareComputerUseRuntimeGlobals(globals: Record<PropertyKey, unknown>): void;
export declare function createComputerUseBridgeGlobals(input: {
    broker?: NodeReplCuaBrokerConnection;
    generation: number;
    getActiveCall: () => ActiveCuaNodeReplCall | undefined;
    session: () => NodeReplSession;
    documentationRoot: string;
}): Record<PropertyKey, unknown>;
//# sourceMappingURL=cua-bridge.d.ts.map