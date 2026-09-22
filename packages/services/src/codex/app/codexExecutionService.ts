// Codex 执行后端服务契约（app 层）。
//
// SECURITY BOUNDARY：本接口是 codex-execution 通道的完整表面。只允许传输 v4 会话投影
// （zcode-protocol-v4 的 frame/rows/ack）与脱敏任务绑定信息；任何 Codex token、OAuth
// 材料、auth.json 内容或原始 server-request 信封都不得经此通道传输。
// Codex 保持自己的 agent loop（thread/turn/item），不进入 ZCode model adapter。
import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type {
  CodexExecutionApprovalDecision,
  CodexExecutionCreateTaskParams,
  CodexExecutionCreateTaskResult,
  CodexExecutionListTasksParams,
  CodexExecutionListTasksResult,
  CodexExecutionReadTaskParams,
  CodexExecutionSendTurnParams,
  CodexTaskThreadInfo,
} from "@zcode/shared";
import type {
  CommandAck,
  CommandEnvelope,
  ConversationResyncParams,
  ConversationTopicFrame,
  SubscribeParams,
  V4ConversationResyncResult,
  V4ConversationRowsRangeParams,
  V4ConversationRowsRangeResult,
  V4ConversationSubscribeResult,
} from "@zcode/shared/zcode-protocol-v4";
import { createServiceDescriptor } from "#src/descriptors.js";

export interface CodexExecutionWorkspaceFilter {
  readonly workspacePath?: string;
  readonly workspaceIdentity?: string;
}

/**
 * 12 个公开方法是 architecture policy 的上限：任务面（前 6 个）+ v4 会话面（后 6 个）。
 * v4 命令统一走 sendConversationCommandV4（sendText/stop/resolveInteraction/rename），
 * 取消与审批不再单设方法。
 */
export interface ICodexExecutionService {
  /** 创建 harness 任务并 start 一个 Codex thread；携带 firstInput 时立即开始首个 turn。 */
  createTask(params: CodexExecutionCreateTaskParams): Promise<CodexExecutionCreateTaskResult>;
  /** 向既有任务发送一个用户 turn（Codex turn/start）。 */
  sendTurn(params: CodexExecutionSendTurnParams): Promise<{ accepted: boolean; commandId: string }>;
  /** 解析审批（interactionId 必须来自 pendingInteraction 下发；未知 id 拒绝，绝不放行）。 */
  respondApproval(params: CodexExecutionApprovalDecision): Promise<void>;
  /** 读取任务绑定；非 Codex 任务返回 null。携带 workspace 时按 workspaceKey 收敛。 */
  readTask(params: CodexExecutionReadTaskParams): Promise<CodexTaskThreadInfo | null>;
  /** Codex 任务清单（脱敏绑定信息）；携带 workspace 时按 workspaceKey 收敛。 */
  listTasks(params?: CodexExecutionListTasksParams): Promise<CodexExecutionListTasksResult>;
  /** 路由判定：taskId 是否由 Codex 后端驱动。 */
  isCodexTask(taskId: string): Promise<boolean>;
  /** v4 订阅；initial frame 在 ACK 之后经 onDynamicConversationFrame 投递。 */
  subscribeConversationV4(params: SubscribeParams): Promise<V4ConversationSubscribeResult>;
  /** 活跃订阅恢复；forceSnapshot 时重新下发全量快照。 */
  resyncConversationV4(params: ConversationResyncParams): Promise<V4ConversationResyncResult>;
  unsubscribeConversationV4(params: { subscriptionId: string }): Promise<void>;
  /** 行分页（loadOlder）。 */
  conversationRowsRangeV4(params: V4ConversationRowsRangeParams): Promise<V4ConversationRowsRangeResult>;
  /** v4 命令信封：sendText / stop / resolveInteraction / renameSession；其余拒绝。 */
  sendConversationCommandV4(params: { envelope: CommandEnvelope }): Promise<CommandAck>;
  /** 下行帧（snapshot/deltas），ConversationTopicFrame 形状与 agent v4 完全一致。 */
  onDynamicConversationFrame(filter?: CodexExecutionWorkspaceFilter): Event<ConversationTopicFrame>;
}

export const ICodexExecutionService = createServiceDescriptor<ICodexExecutionService>(
  ServiceChannels.CodexExecution,
);
