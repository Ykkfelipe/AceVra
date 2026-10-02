// Computer Use node_repl bridge（两个合法 node_repl 执行面共用）。
// 只接收显式输入：本地代理连接 + 调用方已构造好的 ComputerUseRuntime；本模块不发现凭据。

import type { ComputerUseRuntime } from "./index.js";

export declare const NODE_REPL_CUA_BRIDGE_SYMBOL: symbol;
export declare const CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE: "Computer Use is not available in subagent";

/** cell 侧 bridge 请求的请求元数据；只有下列可选字符串键会被读取。 */
export interface NodeReplCuaRequestMeta {
  runtime_scope?: string;
  session_id?: string;
  workspace_path?: string;
  workspace_identity?: string;
  workspace_key?: string;
  remote_session_id?: string;
  turn_id?: string;
  client_mode?: string;
  delivery_kind?: string;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
}

export interface ActiveCuaNodeReplCall {
  generation: number;
  requestMeta: NodeReplCuaRequestMeta;
  signal: AbortSignal;
}

export interface NodeReplCuaBrokerConnection {
  socketPath: string;
  token: string;
}

export interface ComputerUseRuntimeBridge {
  /** 私有 capability 请求；这里不是 MCP tool 调用，MCP 只承载外层 node_repl。 */
  call(method: string, input: unknown): Promise<unknown>;
  assertAvailable(): void;
  documentationRoot: string;
}

/** 持有已获授权 ComputerUseRuntime 的进程内代理 broker。 */
export interface NodeReplCuaBroker {
  connection: NodeReplCuaBrokerConnection;
  ready: Promise<void>;
  close(): Promise<void>;
}

export declare function prepareComputerUseRuntimeGlobals(
  globals: Record<PropertyKey, unknown>,
): void;

export declare function createComputerUseBridgeGlobals(input: {
  broker?: NodeReplCuaBrokerConnection;
  generation: number;
  getActiveCall: () => ActiveCuaNodeReplCall | undefined;
  session: () => {
    mergeResponseMeta(meta: Record<string, unknown>): void;
    recordCuaAppIdentity(app: { appKey: string; displayName?: string }): void;
    /** Canonical Computer Use operation the bridge executed (host-recorded, model cannot write). */
    recordCuaOperation?(operation: string): void;
  };
  documentationRoot: string;
}): Record<PropertyKey, unknown>;

export declare function createNodeReplCuaBroker(input: {
  runtime: ComputerUseRuntime;
  logger?: unknown;
  platform?: string;
}): NodeReplCuaBroker;
