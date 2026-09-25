// AceVra 后端迁移（Codex → Agent）的上下文种子写入（backend-migration.md「codex → zcode」+
// Amendment 4）。
//
// 种子是 model-only synthetic user 消息：provider 可见、UI/转录隐藏——模型在下一轮真实用户输入前
// 就拥有迁移前的上下文，而可见时间线由 host 从原 Codex 段组合，种子不会渲染成可见副本。
// 写法沿用历史导入的既有路径：直接写 sessionStore，再 app.resume() 让 runtime 从持久层重建
// 历史（resume 会新建 MessageHistory，不会把种子重复追加到内存历史里）。
import {
  zcodeSessionRemoveBackendHandoffSeedParamsSchema,
  zcodeSessionSeedBackendHandoffParamsSchema,
} from "@zcode/shared";
import { createMessageId, createPartId, type MessageId } from "@zcode/contracts";
import { optionalModelSelectionFromString } from "./model-mapper.js";
import {
  ProtocolRequestError,
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

function seedMessageId(sessionId: string, seedId: string): MessageId {
  return createMessageId(`${sessionId}_backend_handoff_${seedId}`);
}

function requireSessionStore(context: ZCodeProtocolAgentServerContext) {
  const store = context.deps.sessionStore;
  if (!store) {
    throw new ProtocolRequestError(-32003, "Cannot seed backend handoff without session store");
  }
  return store;
}

export async function seedBackendHandoff(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<{ messageId: string }> {
  const params = parseParams(zcodeSessionSeedBackendHandoffParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  if (record.activeAbortController) {
    // 迁移只在旧后端空闲时发起；目标 Agent 会话此刻不应有在途轮次。
    throw new ProtocolRequestError(-32010, "Cannot seed backend handoff while a prompt is running");
  }
  const store = requireSessionStore(context);
  const messageID = seedMessageId(params.sessionId, params.seedId);
  const createdAt = Date.now();
  // 修复：种子写在 setModel 之前，会话当前模型仍是迁移前的 provider。task meta 同步取最新消息的
  // 模型，旧标注会让任务行回退成旧 provider（下一次迁移的 fromProviderId 随之错误）。种子属于目标
  // Agent 段，按 host 给出的目标选择标注；旧 host 不传时才沿用当前模型。
  const seedModel = params.model ?? optionalModelSelectionFromString(record.app.getModel());
  await store.saveMessage({
    id: messageID,
    sessionID: record.app.sessionId,
    role: "user",
    time: { created: createdAt },
    agent: "zcode-agent",
    ...(seedModel ? { modelSelection: seedModel } : {}),
    synthetic: true,
    source: "backend_handoff",
    visibility: "model-only",
    semantics: {
      origin: "import",
      kind: "backend_handoff",
      source: "backend_migration",
      uiVisibility: "hidden",
      providerVisibility: "visible",
      transcriptVisibility: "hidden",
    },
    metadata: { backendHandoffSeedId: params.seedId },
  });
  await store.savePart({
    id: createPartId(`${params.sessionId}_backend_handoff_${params.seedId}_text`),
    sessionID: record.app.sessionId,
    messageID,
    type: "text",
    text: params.text,
    synthetic: true,
    time: { start: createdAt, end: createdAt },
    metadata: { source: "backend_handoff", backendHandoffSeedId: params.seedId },
  });
  await record.app.resume();
  record.stateRevision++;
  return { messageId: messageID };
}

export async function removeBackendHandoffSeed(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<{ removed: boolean }> {
  const params = parseParams(zcodeSessionRemoveBackendHandoffSeedParamsSchema, rawParams);
  const store = requireSessionStore(context);
  const messageID = seedMessageId(params.sessionId, params.seedId);
  const existing = await store.messageWithParts({
    sessionID: params.sessionId as never,
    messageID,
  });
  if (!existing) return { removed: false };
  await store.removeMessage({ sessionID: existing.info.sessionID, messageID });
  // 失败迁移的回滚：已加载的 runtime 必须从持久层重建，不能继续把被删的种子留在内存历史里。
  const record = context.sessions.get(params.sessionId);
  if (record && !record.activeAbortController) {
    await record.app.resume();
    record.stateRevision++;
  }
  return { removed: true };
}
