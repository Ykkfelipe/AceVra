/**
 * codex 模块契约：本文件是其它模块引用 codex 执行后端的唯一合法入口。
 *
 * SECURITY BOUNDARY：经 ICodexExecutionService 传输的只有 v4 会话投影
 * （zcode-protocol-v4 的 frame/rows/ack）与脱敏任务绑定（CodexTaskBinding）。
 * Codex token、OAuth 材料、auth.json 内容、codexHome 路径与原始 server-request
 * 信封不得进入任何导出类型的取值；审批请求只携带工具名/摘要/命令文本/路径。
 * Codex 保持自己的 agent loop（thread/turn/item），不进入 ZCode model adapter。
 */
import type { CodexAppServerPort, CodexTaskIndexPort } from "./app/codexPorts.js";
import type { ICodexExecutionService } from "./app/codexExecutionService.js";
import { createCodexExecutionService } from "./app/codexExecutionServiceImpl.js";

// 值导出（interface + 同名 descriptor 常量经声明合并）；类型面在上面单独声明。
export { ICodexExecutionService } from "./app/codexExecutionService.js";
export type { CodexAppServerPort, CodexTaskIndexPort } from "./app/codexPorts.js";
export { createCodexExecutionService };
