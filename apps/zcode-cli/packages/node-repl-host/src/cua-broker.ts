// 兼容层：代理 broker 实现已移到 @zcode/zcode-cua/node-repl-cua-bridge。
//
// 两个合法 node_repl 执行面（MCP 宿主 / core 内置 handler）共用同一份实现；本文件只做
// 定向再导出，保留原有导入路径（server.ts 继续使用 ./cua-broker.js），不再持有第二份协议。
export {
  createNodeReplCuaBroker,
  type NodeReplCuaBroker,
} from "@zcode/zcode-cua/node-repl-cua-bridge";
