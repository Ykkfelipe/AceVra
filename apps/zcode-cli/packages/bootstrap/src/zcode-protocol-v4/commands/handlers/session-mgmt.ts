// 会话管理命令组：createSession / renameSession / deleteSession。
// 每个命令组一个文件：handler 纯函数 (host, envelope) → CommandResult|undefined，
// 决策逻辑直驱 core，环境能力走 host 钩子（见 ../types.ts 的过渡标注）。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
  CrossModeOriginState,
} from "@zcode/shared/zcode-protocol-v4";
import { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import { inputIntentMetadata } from "../input-intent.js";
import { commandAdmissionOf } from "../executor.js";
import { startPromptTurn } from "../prompt-turn.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
import { applyRequestedSessionConfig } from "./model-config.js";
import {
  hasPromptInput,
  V4InputAdmissionRejectedError,
  resolveSubmittedExecutionState,
} from "./session-flow.js";
import { applySubmittedExecutionTarget } from "./execution-target-selection.js";
import {
  preflightCrossModeCodingHandoff,
  renderCrossModeHandoffFirstInput,
} from "../../../app/cross-mode-coding-handoff.js";

/**
 * createSession：回落面最后一项的原生化。
 * 语义决策（原生层持有）：
 * - draft 语义：新会话一律 deferred（不进 sqlite），首条发送时由 prompt-turn 提升
 *   immediate——record 创建钩子固定传 deferred，提升逻辑不在钩子里。
 * - firstInput 可选：有则经原生 prompt turn 提交（与 sendText 同一条写路径——
 *   draft 提升/提交即返/ready 边界三个语义免费获得），不再经旧 sendPrompt op。
 * - workspaceId：本地工作区 = workspacePath（Workspace Identity 约束的本地 fallback）；
 *   远程 identity（remote:ssh/wsl/docker:...）由 host.createSessionRecord 经
 *   @zcode/shared parseRemoteWorkspaceIdentity 统一解析（跨 workspace 分屏 pane）。
 * 执行面（过渡钩子）：record 建立/事件接线/catalog 同步/失败清理与旧宿主纠缠，
 * 走 host.createSessionRecord（见 ../types.ts）。
 */
async function createSession(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["createSession"];
  if (!host.createSessionRecord) {
    throw new Error("v4 createSession requires host.createSessionRecord capability");
  }
  // Cross-Mode 交接：所有校验都在建 record 之前完成——失败不留下任何会话（spec §5 规则 1）。
  const handoff = payload.crossModeHandoff;
  if (handoff) {
    if (payload.firstInput || payload.taskType) {
      throw new V4InputAdmissionRejectedError(
        "proto.invalidPayload",
        "crossModeHandoff cannot be combined with firstInput or taskType",
      );
    }
    const preflight = preflightCrossModeCodingHandoff(handoff.confirmation);
    if (!preflight.ok) {
      throw new V4InputAdmissionRejectedError("proto.invalidPayload", preflight.message);
    }
  }
  // 完全空的 firstInput 必须在创建 record 前拒绝，避免失败请求遗留无效 deferred session。
  if (
    payload.firstInput &&
    !hasPromptInput(payload.firstInput.text, payload.firstInput.attachments)
  ) {
    throw new V4InputAdmissionRejectedError("proto.invalidPayload", "input must not be empty");
  }
  const { sessionId } = await host.createSessionRecord({
    workspaceId: payload.workspaceId,
    mcpServers: payload.mcpServers,
    offPeakToolEnabled: payload.offPeakToolEnabled,
    dynamicWorkflowEnabled: payload.dynamicWorkflowEnabled,
    taskType: payload.taskType,
  });
  // createSession.config 消费——草稿态 UI 的先行选择（模型/思考深度/
  // 模式）在首发之前应用并补发事件，首条 turn 即用所选配置。必须在 firstInput 之前。
  // 应用失败不连坐会话创建（record 已建成，failed ACK 只会泄漏会话）：降级 warn，
  // 会话保持 runtime 缺省。
  if (payload.config) {
    const record = requireRecord(host, sessionId);
    try {
      await applyRequestedSessionConfig(host, record, payload.config);
    } catch (error) {
      host.logger?.warn?.("v4 createSession config apply failed; session keeps runtime defaults", {
        error: error instanceof Error ? error.message : String(error),
        sessionId,
      });
    }
  }
  // Cross-Mode 交接：准入 + 物化 + origin，必须先于首条 turn（turn 失败时来源仍在）。
  let crossModeOrigin: CrossModeOriginState | undefined;
  let requestedFirstInput = payload.firstInput;
  if (handoff) {
    const accepted = await acceptHandoffIntoCreatedSession(host, sessionId, payload, handoff);
    crossModeOrigin = accepted.origin;
    requestedFirstInput = { text: accepted.firstInputText };
  }
  let firstInput:
    | {
        delivery: "startNow" | "queue" | "guide";
        inputId: string;
        messageId?: string;
      }
    | undefined;
  if (requestedFirstInput) {
    // 附件命令面：firstInput.attachments（AttachmentRef → TurnAttachment）随首条发送。
    const record = requireRecord(host, sessionId);
    applySubmittedExecutionTarget(record, requestedFirstInput.executionTarget);
    const admission = commandAdmissionOf(envelope);
    const durableAdmission =
      (await host.admitInputCommand?.(envelope, sessionId, admission)) ?? null;
    try {
      const attachments = await mapAttachmentRefsToTurnAttachments(
        record.app,
        requestedFirstInput.attachments,
      );
      const intent = inputIntentMetadata(envelope, {
        text: requestedFirstInput.text,
        requestedDelivery: "startNow",
        attachmentRefs: requestedFirstInput.attachments,
        ...resolveSubmittedExecutionState(record, requestedFirstInput),
      });
      const started = await startPromptTurn(host, record, {
        content: requestedFirstInput.text,
        inputId: envelope.commandId,
        intent,
        ...(attachments ? { attachments } : {}),
      });
      firstInput = {
        delivery: started.admission.kind === "queued" ? "queue" : "startNow",
        inputId: envelope.commandId,
        ...(started.messageId ? { messageId: started.messageId } : {}),
      };
    } catch (error) {
      if (durableAdmission) {
        try {
          await host.cancelInputCommand?.(
            sessionId,
            admission.queueItemId,
            "fault.command.inputRejected",
          );
        } catch (cancelError) {
          // 取消账本失败不能覆盖真正的首发失败；否则客户端会拿到错误的失败原因，
          // 而 admission 仍可在重启查询时按 discarded 收口，不会被误判为成功。
          host.logger?.warn?.("v4 createSession first input cancellation failed", {
            cancelError: cancelError instanceof Error ? cancelError.message : String(cancelError),
            inputError: error instanceof Error ? error.message : String(error),
            queueItemId: admission.queueItemId,
            sessionId,
          });
        }
      }
      // 交接会话已物化并带有来源：首轮失败不能把整个交接报成失败（会话与来源已存在，
      // 报错只会让桌面以为什么都没发生）。ACK 仍 accepted（带 origin、不带 input），失败留日志。
      if (crossModeOrigin) {
        host.logger?.warn?.("v4 createSession cross-mode first turn failed; origin kept", {
          error: error instanceof Error ? error.message : String(error),
          handoffId: crossModeOrigin.handoffId,
          sessionId,
        });
      } else {
        throw error;
      }
    }
  }
  return {
    type: "createSession",
    sessionId,
    ...(firstInput ? { input: firstInput } : {}),
    ...(crossModeOrigin ? { crossModeOrigin } : {}),
  };
}

/**
 * 在刚建好的 record 上执行 Cross-Mode 入站交接。拒绝时关闭这个空会话再抛错：
 * ACK rejected 的同时不留下孤儿会话。成功后把只读来源推给在线投影（冷订阅从 entry 恢复）。
 */
async function acceptHandoffIntoCreatedSession(
  host: V4CommandCoreHost,
  sessionId: string,
  payload: CommandPayloadMap["createSession"],
  handoff: NonNullable<CommandPayloadMap["createSession"]["crossModeHandoff"]>,
): Promise<{ origin: CrossModeOriginState; firstInputText: string }> {
  const record = requireRecord(host, sessionId);
  const closeCreatedSession = async () => {
    try {
      await host.closeSession?.(record.app.sessionId);
    } catch (closeError) {
      host.logger?.warn?.("v4 createSession cross-mode cleanup failed", {
        error: closeError instanceof Error ? closeError.message : String(closeError),
        sessionId,
      });
    }
  };
  if (!record.app.acceptCrossModeHandoff) {
    await closeCreatedSession();
    throw new V4InputAdmissionRejectedError(
      "fault.command.capabilityUnsupported",
      "this runtime cannot accept cross-mode handoffs",
    );
  }
  // 修复：首轮需要可用模型。若在物化/写来源之后才发现，会留下一个带来源却没有交接正文的会话
  // （实机隔离 HOME 复现：「Session model must be provider-qualified」）；所以在准入前先校验，
  // record 仍是 deferred，关闭即无痕。
  try {
    await host.ensureModelReady?.(record);
    // 与首轮 admission 同一个解析：会话没有可用的 provider-qualified 选择时在这里就失败。
    resolveSubmittedExecutionState(record, {});
  } catch (error) {
    await closeCreatedSession();
    throw error;
  }
  const workspacePath = record.workspace.workspacePath;
  const outcome = await record.app.acceptCrossModeHandoff({
    confirmation: handoff.confirmation,
    destination: {
      workspacePath,
      // workspaceId 是 identity 优先的身份键；与路径不同即为远程 identity。
      ...(payload.workspaceId !== workspacePath ? { workspaceIdentity: payload.workspaceId } : {}),
    },
  });
  if (!outcome.ok) {
    await closeCreatedSession();
    throw new V4InputAdmissionRejectedError(
      outcome.reason === "invalid_input"
        ? "proto.invalidPayload"
        : "fault.command.crossModeHandoffRejected",
      outcome.message,
    );
  }
  record.persistence = "immediate";
  host.publishCrossModeOrigin?.(sessionId, outcome.origin);
  host.logger?.info?.("v4 createSession accepted cross-mode handoff", {
    handoffId: outcome.origin.handoffId,
    sessionId,
    sourceMode: outcome.origin.sourceMode,
  });
  return {
    origin: outcome.origin,
    firstInputText: renderCrossModeHandoffFirstInput(outcome.packet),
  };
}

/**
 * renameSession：用户显式重命名 → core runtime.setCustomSessionTitle。
 * - titleSource=custom 的粘性（此后自动标题生成被 custom_title 短路跳过）由 core 保证
 *   （core/src/runtime/methods/session-title.ts），handler 不重复实现。
 * - traceContext 透传会话根 traceContext（record 窄视图字段）：重命名归属该会话的
 *   任务链，不另起 trace（可观测性纪律）。
 * - 不做 legacy 广播：core 发 SessionTitleUpdated 事件，经 gateway 投影收口，
 *   v4 消费者由此感知标题变更。
 */
async function renameSession(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["renameSession"];
  const record = requireRecord(host, envelope.sessionId);
  // 注意：方法必须经 runtime 调用（不可解构，实现依赖 this 绑定，见 methods/index.ts 挂载方式）。
  await record.app.runtime.setCustomSessionTitle({
    title: payload.title,
    traceContext: record.traceContext,
  });
  return undefined;
}

/**
 * deleteSession：语义 = closeSession（关闭 + 清理运行时资源），非真删 record——
 * message 库无删除 API，与旧协议路径一致（旧协议的“删除”同样只是 close，历史仍在库里，
 * 只是不再出现在活跃注册表）。
 * 会话注册表仍归宿主，实际关闭走 host.closeSession 过渡钩子（归宿：v4 自持会话注册表，见 ../types.ts）。
 */
async function deleteSession(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  if (!host.closeSession) {
    // 关闭不能静默降级：钩子缺失说明 binder 接线不完整，直接失败（ACK failed）。
    throw new Error("v4 deleteSession requires host.closeSession capability");
  }
  await host.closeSession(record.app.sessionId);
  return undefined;
}

async function discardSharedContext(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["discardSharedContext"];
  const sessionId = envelope.sessionId;
  if (!sessionId || !host.discardSharedContext) {
    throw new Error("v4 discardSharedContext requires a session-scoped storage capability");
  }
  const updated = await host.discardSharedContext(sessionId, payload.contextId);
  if (!updated)
    throw new V4InputAdmissionRejectedError(
      "fault.command.inputRejected",
      "shared context is not pending",
    );
  return undefined;
}

export const sessionMgmtHandlers = {
  createSession,
  renameSession,
  deleteSession,
  discardSharedContext,
};
