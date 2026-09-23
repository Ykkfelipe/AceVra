import type { NodeReplRequestMeta, NodeReplSession } from "@zcode/core/repl";
export interface ActiveNodeReplCall {
    generation: number;
    requestMeta: NodeReplRequestMeta;
    signal: AbortSignal;
}
export declare function createBrowserBridgeGlobals(input: {
    documentationRoot: string;
    generation: number;
    getActiveCall: () => ActiveNodeReplCall | undefined;
    session: () => NodeReplSession;
}): Record<PropertyKey, unknown>;
/** MCP fresh kernel 直接复用 core 的浏览器 facade，模型无需拼接插件路径或加载模块。 */
export declare function prepareBrowserRuntimeGlobals(globals: Record<PropertyKey, unknown>): void;
//# sourceMappingURL=browser-bridge.d.ts.map