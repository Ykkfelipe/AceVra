# @zcode/node-repl-host

`node_repl` 的共享宿主：JS 执行面（只有 `js` 一个工具）与两个领域
bridge（Browser Use、Computer Use）都在这里。

## 为什么它是独立包

宿主是**官方能力共用的**，不属于任何一个插件。它过去长在 `browser-use-plugin` 里，后果是：

- 改 Computer Use 必须动 browser-use 这个包；
- CUA 的 SDK 与文档在 browser-use 里各有一份手工维护的副本；
- `resolveBuiltInNodeReplMcpServers` 只在 browser-use 的 rootPath 下找宿主产物，
  browser-use 包一旦缺失，即便 CUA 自己启用也拿不到宿主。

注册侧本来就已经收在 CLI 核心（`bootstrap/src/app/built-in-node-repl.ts`，判据是
「bua 或 cua 任一启用」），缺的一直是**产物归属**。这个包把源码归位。

## 产物仍由插件包携带

`dist/mcp/server.js` is emitted by this package. Browser Use contributes its own client and docs;
Computer Use contributes its client/docs/skill from `@zcode/zcode-cua-plugin`. Both official
packages must be present in filesystem and SEA publication lists, while this host remains the
only shared `node_repl` runtime.
