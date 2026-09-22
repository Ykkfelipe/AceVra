// v4 命令信封 → Codex 动作（app 层）。
// sendText → turn/start；stop → turn/interrupt；resolveInteraction → 审批应答；
// renameSession → 任务索引标题；其余命令一律 rejected（fault.command.unsupportedBackend）。
import type {
  CommandAck,
  CommandEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
import { CODEX_METHODS, scrubCodexErrorDetail } from "#src/codex/domain/codexWire.js";
import type { CodexProjectionCommit } from "#src/codex/domain/codexProjection.js";
import type { CodexTaskRuntime } from "./codexTaskRuntime.js";
import type { CodexAppServerPort, CodexTaskIndexPort } from "./codexPorts.js";

interface CodexCommandContext {
  readonly bridge: CodexAppServerPort;
  readonly taskIndex: CodexTaskIndexPort;
  emitCommit(taskId: string, commit: CodexProjectionCommit): void;
  sendTurn(params: { taskId: string; content: string; commandId?: string }): Promise<void>;
  now(): number;
}

function ackOf(params: {
  commandId: string;
  status: CommandAck["status"];
  revisionAtDecision: number;
  reasonCode?: string;
  message?: string;
  result?: CommandAck["result"];
}): CommandAck {
  return {
    commandId: params.commandId,
    status: params.status,
    revisionAtDecision: params.revisionAtDecision,
    ...(params.reasonCode ? { reasonCode: params.reasonCode } : {}),
    ...(params.message ? { message: params.message } : {}),
    ...(params.result ? { result: params.result } : {}),
  };
}

/** 审批表变化后的收尾帧已由 projection.resolveApproval 返回（含锚点行收敛）。 */

export async function handleConversationCommand(
  context: CodexCommandContext,
  taskId: string,
  runtime: CodexTaskRuntime,
  envelope: CommandEnvelope,
): Promise<CommandAck> {
  const revision = () => runtime.projection.revision;
  switch (envelope.type) {
    case "sendText": {
      const payload = envelope.payload as { text?: unknown };
      const text = typeof payload.text === "string" ? payload.text : "";
      if (!text.trim()) {
        return ackOf({
          commandId: envelope.commandId,
          status: "rejected",
          revisionAtDecision: revision(),
          reasonCode: "fault.command.emptyText",
        });
      }
      try {
        await context.sendTurn({ taskId, content: text, commandId: envelope.commandId });
      } catch (error) {
        // 以 failed ACK 收口：renderer 按真实失败原因 settle，而不是走 transport-error 盲路。
        return ackOf({
          commandId: envelope.commandId,
          status: "failed",
          revisionAtDecision: revision(),
          reasonCode: "codex_turn_start_failed",
          message: scrubCodexErrorDetail(error instanceof Error ? error.message : String(error)),
        });
      }
      return ackOf({
        commandId: envelope.commandId,
        status: "accepted",
        revisionAtDecision: revision(),
        result: { type: "inputAccepted", delivery: "startNow", inputId: envelope.commandId },
      });
    }
    case "stop": {
      // schema（0.155.0-alpha.9.2）要求 turn/interrupt 同时携带 threadId 与 turnId；
      // turn id 未知（turn/started 未到达且响应缺 turn 字段）时宁肯失败 ACK，
      // 也不发送缺字段的 payload 让 Codex 侧报 invalid params。
      if (!runtime.codexTurnId) {
        return ackOf({
          commandId: envelope.commandId,
          status: "failed",
          revisionAtDecision: revision(),
          reasonCode: "codex_interrupt_no_active_turn",
          message: "no active Codex turn id yet; retry once the turn has started",
        });
      }
      try {
        await context.bridge.call(CODEX_METHODS.turnInterrupt, {
          threadId: runtime.codexThreadId,
          turnId: runtime.codexTurnId,
        });
      } catch (error) {
        return ackOf({
          commandId: envelope.commandId,
          status: "failed",
          revisionAtDecision: revision(),
          reasonCode: "codex_interrupt_failed",
          message: scrubCodexErrorDetail(error instanceof Error ? error.message : String(error)),
        });
      }
      return ackOf({ commandId: envelope.commandId, status: "accepted", revisionAtDecision: revision() });
    }
    case "resolveInteraction": {
      const payload = envelope.payload as { interactionId?: unknown; answer?: { optionId?: unknown } };
      const interactionId = typeof payload.interactionId === "string" ? payload.interactionId : "";
      const optionId = payload.answer?.optionId === "approved" ? "approved" : "denied";
      const resolution = runtime.projection.resolveApproval(interactionId, optionId);
      if (!resolution) {
        return ackOf({
          commandId: envelope.commandId,
          status: "rejected",
          revisionAtDecision: revision(),
          reasonCode: "codex_approval_unknown_interaction",
        });
      }
      context.emitCommit(taskId, resolution.commit);
      // 应答服务器请求；进程换代后 bridge.respond 会静默丢弃。
      context.bridge.respond(resolution.record.rawId, resolution.codexResponse);
      return ackOf({
        commandId: envelope.commandId,
        status: "accepted",
        revisionAtDecision: revision(),
        result: {
          type: "resolveInteraction",
          resolvedBy: { clientId: envelope.clientId, optionId },
        },
      });
    }
    case "renameSession": {
      const payload = envelope.payload as { title?: unknown };
      const title = typeof payload.title === "string" ? payload.title.trim() : "";
      if (title) {
        runtime.projection.setTitle(title);
        await context.taskIndex.updateTaskState({
          workspacePath: runtime.workspacePath,
          ...(runtime.workspaceIdentity ? { workspaceIdentity: runtime.workspaceIdentity } : {}),
          taskId,
          patch: { title, titleOverridden: true, updatedAt: context.now() },
        });
      }
      return ackOf({ commandId: envelope.commandId, status: "accepted", revisionAtDecision: revision() });
    }
    default:
      return ackOf({
        commandId: envelope.commandId,
        status: "rejected",
        revisionAtDecision: revision(),
        reasonCode: "fault.command.unsupportedBackend",
      });
  }
}
