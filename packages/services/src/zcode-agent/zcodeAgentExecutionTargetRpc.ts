// M2F：agent 执行目标反向请求（interaction/executionTarget）的 host 侧中继。
// 与 browser RPC 同一约束：executor 经 Promise 边界调用，同步抛错也归一为结构化结果，
// 绝不同步抛进 stdio 分发器（否则会被误判为协议解析错误并关闭整个 agent 连接）。
import { resolve } from "node:path";
import {
  zcodeExecutionTargetParamsSchema,
  type ExecutionTargetExecutor,
  type ZCodeProtocolRequestId,
} from "@zcode/shared";

interface ExecutionTargetRpcResponder {
  respond(id: ZCodeProtocolRequestId, result: unknown): Promise<void>;
  respondError(
    id: ZCodeProtocolRequestId,
    error: { code: number; message: string; data?: unknown },
  ): Promise<void>;
}

/**
 * 能力只对本地 workspace 成立：远程 workspace 的 agent 不在这台 Desktop 上，"Run on" 不适用。
 * 请求里的 workspace 必须与该 agent 连接的 workspace 一致，防止跨 workspace 冒用。
 */
export function handleExecutionTargetRequest(context: {
  client: ExecutionTargetRpcResponder;
  executor: ExecutionTargetExecutor | undefined;
  requestId: ZCodeProtocolRequestId;
  params: unknown;
  workspace: { workspacePath: string; workspaceIdentity?: string };
}): void {
  const { client, executor, requestId, workspace } = context;
  const parsed = zcodeExecutionTargetParamsSchema.safeParse(context.params);
  if (!parsed.success) {
    void client.respondError(requestId, {
      code: -32602,
      message: "Invalid interaction/executionTarget params",
      data: parsed.error.flatten(),
    });
    return;
  }
  const request = parsed.data;
  if (!executor || workspace.workspaceIdentity?.trim() || request.workspaceIdentity?.trim()) {
    void client.respond(requestId, { op: request.op, ok: false, reason: "unavailable" });
    return;
  }
  if (resolve(request.workspacePath) !== resolve(workspace.workspacePath)) {
    void client.respond(requestId, {
      op: request.op,
      ok: false,
      reason: "invalid_request",
      detail: "workspace_mismatch",
    });
    return;
  }
  void Promise.resolve()
    .then(() => executor.execute(request))
    .then((result) => client.respond(requestId, result))
    .catch(() => {
      void client.respond(requestId, { op: request.op, ok: false, reason: "internal" });
    });
}
