// core 内置 node_repl handler 的 Computer Use 能力获取。
//
// 两个合法 node_repl 执行面（MCP 宿主 / core 内置 handler）共用 @zcode/zcode-cua 里的同一份
// bridge 协议；这里只负责把**本进程已获授权**的能力转成本地代理 broker：
//   - 能力来源只有一处：CLI bootstrap 在 sanitize 之前留下的私有快照
//     （getCapturedZCodeCuaBrokerCredentials）。它是进程私有的，不写回 process.env，
//     也不进入 cell globals；模型只能看到 symbol-keyed bridge，看不到 socket/token 值。
//   - lease client 同样只用私有快照的成对 socket/token 构造；缺一即不给（保持既有的
//     fail-closed：没有 lease 时 reportActivity 是 no-op，不会伪造活动）。
//   - 拿不到 socket 时返回 undefined：bridge 仍会安装（与 MCP 宿主一致），但调用会以既有
//     语义抛出 "Computer Use is unavailable for this node_repl session"。
import {
  getCapturedZCodeCuaBrokerCredentials,
  ZCODE_CUA_LEASE_AUTHORITY_SOCKET_ENV_KEY,
  ZCODE_CUA_LEASE_AUTHORITY_TOKEN_ENV_KEY,
} from "@zcode/shared";
import { resolve } from "node:path";

import { createComputerUseRuntime } from "@zcode/zcode-cua";
import { createLeaseAuthorityClient } from "@zcode/zcode-cua/lease-authority-client";
import {
  createNodeReplCuaBroker,
  type NodeReplCuaBroker,
} from "@zcode/zcode-cua/node-repl-cua-bridge";

/** 用私有快照构造本地代理 broker；无凭据返回 undefined（绝不凭空造客户端）。 */
export function createCoreNodeReplCuaBroker(): NodeReplCuaBroker | undefined {
  const captured = getCapturedZCodeCuaBrokerCredentials();
  const socketPath = captured.socket?.trim();
  if (!socketPath) return undefined;
  const capabilityToken = captured.capabilityToken?.trim();
  const refreshMarker = captured.refreshMarker?.trim();
  const leaseSocket = captured.leaseAuthoritySocket?.trim();
  const leaseToken = captured.leaseAuthorityToken?.trim();
  const runtime = createComputerUseRuntime({
    brokerSocketPath: socketPath,
    ...(capabilityToken ? { brokerToken: capabilityToken } : {}),
    ...(refreshMarker ? { refreshMarkerPath: refreshMarker } : {}),
    // 与 MCP 宿主同一判断：本进程就是已鉴权的 stdio host（模型工具调用在此进程内执行）。
    allowForegroundControl: () => true,
    // lease 凭据成对才给；只经内存对象传给 client，绝不读写进程 env。
    leaseAuthority:
      leaseSocket && leaseToken
        ? createLeaseAuthorityClient({
            [ZCODE_CUA_LEASE_AUTHORITY_SOCKET_ENV_KEY]: leaseSocket,
            [ZCODE_CUA_LEASE_AUTHORITY_TOKEN_ENV_KEY]: leaseToken,
          })
        : undefined,
  });
  return createNodeReplCuaBroker({ runtime, platform: process.platform });
}

/** 与 node-repl-host 同一来源的文档根（skill 文档只在引入时读取）。 */
export function coreNodeReplCuaDocumentationRoot(): string {
  const pluginRoot = process.env.ZCODE_PLUGIN_ROOT ?? process.cwd();
  return resolve(process.env.ZCODE_CUA_PLUGIN_ROOT ?? pluginRoot, "docs");
}
