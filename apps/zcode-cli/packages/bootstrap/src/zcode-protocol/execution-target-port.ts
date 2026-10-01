import { randomUUID } from "node:crypto";
import type {
  ExecutionTargetCallContext,
  ExecutionTargetFailure,
  ExecutionTargetPort,
} from "@zcode/contracts";
import {
  zcodeExecutionTargetResultSchema,
  zcodeProtocolMethods,
  type ZCodeExecutionTargetParams,
  type ZCodeExecutionTargetResult,
} from "@zcode/shared";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";

type ParamsWithoutBase<T> = T extends unknown
  ? Omit<
      T,
      "requestId" | "sessionId" | "turnId" | "toolCallId" | "workspacePath" | "workspaceIdentity"
    >
  : never;
type OpParams = ParamsWithoutBase<ZCodeExecutionTargetParams>;

/**
 * M2F：每个会话一个执行目标端口。
 * - 选择（executionTarget）读自本会话 record，由用户输入命令写入；端口不缓存，保证实时。
 * - 会话围栏：只允许读取/停止本会话启动的任务；控制面另按账号隔离。
 * - host 不支持（旧 host、-32601、传输失败）一律返回 unavailable，绝不回落本机执行。
 */
export function createProtocolExecutionTargetPort(
  context: ZCodeProtocolAgentServerContext,
  resolveOwnSession: () => ZCodeProtocolSessionRecord | undefined,
): ExecutionTargetPort {
  const startedTaskIds = new Set<string>();

  const request = async (
    op: OpParams,
    callContext: ExecutionTargetCallContext | undefined,
  ): Promise<ZCodeExecutionTargetResult> => {
    const record = resolveOwnSession();
    if (!record) return { op: op.op, ok: false, reason: "unavailable", detail: "session_closed" };
    const params = {
      ...op,
      requestId: randomUUID(),
      sessionId: record.app.sessionId,
      ...(callContext?.turnId ? { turnId: callContext.turnId } : {}),
      ...(callContext?.toolCallId ? { toolCallId: callContext.toolCallId } : {}),
      workspacePath: record.workspace.workspacePath,
      ...(record.workspace.workspaceIdentity
        ? { workspaceIdentity: record.workspace.workspaceIdentity }
        : {}),
    } as ZCodeExecutionTargetParams;
    try {
      return await context.requestClient(
        zcodeProtocolMethods.interactionExecutionTarget,
        params,
        zcodeExecutionTargetResultSchema,
      );
    } catch (error) {
      context.logger?.warn("execution target request failed", {
        event: "execution_target.request.failed",
        op: op.op,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return { op: op.op, ok: false, reason: "unavailable", detail: "host_request_failed" };
    }
  };

  const failureOf = (result: Extract<ZCodeExecutionTargetResult, { ok: false }>) =>
    ({
      ok: false,
      reason: result.reason,
      ...(result.detail ? { detail: result.detail } : {}),
    }) satisfies ExecutionTargetFailure;
  const notInSession = { ok: false, reason: "task_not_in_session" } as const;
  const unexpected = { ok: false, reason: "internal", detail: "unexpected_result" } as const;

  return {
    selectedTarget() {
      return resolveOwnSession()?.executionTarget;
    },
    async listTargets(callContext) {
      const result = await request({ op: "list" }, callContext);
      if (!result.ok) return failureOf(result);
      return result.op === "list"
        ? { ok: true, targets: result.targets.map((target) => ({ ...target })) }
        : unexpected;
    },
    async startProcess(input, callContext) {
      const result = await request(
        { op: "start", targetId: input.targetId, process: input.process },
        callContext,
      );
      if (!result.ok) return failureOf(result);
      if (result.op !== "start") return unexpected;
      startedTaskIds.add(result.taskId);
      return { ok: true, taskId: result.taskId, targetId: result.targetId };
    },
    async readTask(input, callContext) {
      if (!startedTaskIds.has(input.taskId)) return notInSession;
      const result = await request(
        { op: "read", taskId: input.taskId, after: input.after },
        callContext,
      );
      if (!result.ok) return failureOf(result);
      if (result.op !== "read") return unexpected;
      return {
        ok: true,
        task: {
          id: result.task.id,
          targetId: result.task.targetId,
          state: result.task.state,
          result: result.task.result,
          lastSequence: result.task.lastSequence,
        },
        events: result.events.map((event) => ({
          sequence: event.sequence,
          type: event.type,
          payload: event.payload,
        })),
      };
    },
    async cancelTask(input, callContext) {
      if (!startedTaskIds.has(input.taskId)) return notInSession;
      const result = await request({ op: "cancel", taskId: input.taskId }, callContext);
      if (!result.ok) return failureOf(result);
      if (result.op !== "cancel") return unexpected;
      return {
        ok: true,
        task: {
          id: result.task.id,
          targetId: result.task.targetId,
          state: result.task.state,
          result: result.task.result,
          lastSequence: result.task.lastSequence,
        },
      };
    },
  };
}
