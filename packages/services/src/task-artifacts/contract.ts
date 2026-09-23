/**
 * task-artifacts 模块契约：其它模块引用 artifact 注册面的唯一合法入口。
 *
 * SECURITY BOUNDARY：跨模块（zcode-agent、codex）只允许拿到 ITaskArtifactRegistry
 * 的注册/读取面；通道（node.ts）只注册 ITaskArtifactDeliveryService facade
 * （list/read），远端客户端无法注册 artifact。描述符不含宿主绝对路径。
 */
export { ITaskArtifactDeliveryService } from "./app/taskArtifactService.js";
export type { ITaskArtifactRegistry } from "./app/taskArtifactService.js";
export {
  TaskArtifactRegistry,
  TaskArtifactRegistrationError,
  TaskArtifactRetrievalError,
  fileNameFromPath,
  isUuidLike,
  resolveTaskArtifactScope,
} from "./app/taskArtifactRegistry.js";
export { instrumentBrowserExecutorForArtifacts } from "./app/browserUseArtifactHook.js";
