/**
 * AceVra 后端迁移（Codex → Agent）的上下文种子（backend-migration.md Amendment 4）。
 *
 * 证明三件事，全部用真实代码路径（只有 session store / app 是假的）：
 * 1. 种子以确定性 id 写成 model-only synthetic user 消息，写后 runtime 从持久层重建；
 * 2. 共享的消息投影策略把它归为 providerContextOnly——永远不会渲染成可见副本；
 * 3. CLI 的历史水合器把它还原进模型上下文——重启后模型仍然「知道」迁移前的事实。
 * 另验证回滚删除同一条种子并重建 runtime。
 *
 * Run: mise exec -- node --import tsx --test apps/zcode-cli/packages/bootstrap/test/backend-handoff-seed.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { getConversationMessageProjectionPolicy } from "@zcode/shared";
import type { MessageInfo, MessagePart, MessageWithParts } from "@zcode/contracts";
import { hydrateMessageHistoryFromSession, MessageHistoryImpl } from "@zcode/core";
import {
  removeBackendHandoffSeed,
  seedBackendHandoff,
} from "../src/zcode-protocol/backend-handoff-seed.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

const SESSION_ID = "task-seeded-1";

function createFakeContext() {
  const messages = new Map<string, MessageInfo>();
  const parts = new Map<string, MessagePart[]>();
  let resumes = 0;
  const record = {
    app: {
      sessionId: SESSION_ID,
      getModel: () => "azure-openai/gpt-5",
      resume: async () => {
        resumes += 1;
      },
    },
    activeAbortController: undefined as AbortController | undefined,
    stateRevision: 0,
  };
  const sessionStore = {
    saveMessage: async (info: MessageInfo) => {
      messages.set(info.id, info);
    },
    savePart: async (part: MessagePart) => {
      parts.set(part.messageID, [
        ...(parts.get(part.messageID) ?? []).filter((p) => p.id !== part.id),
        part,
      ]);
    },
    removeMessage: async (input: { messageID: string }) => {
      messages.delete(input.messageID);
      parts.delete(input.messageID);
    },
    messageWithParts: async (input: { messageID: string }): Promise<MessageWithParts | null> => {
      const info = messages.get(input.messageID);
      return info ? { info, parts: parts.get(input.messageID) ?? [] } : null;
    },
  };
  const context = {
    deps: { sessionStore },
    sessions: new Map([[SESSION_ID, record]]),
  } as unknown as ZCodeProtocolAgentServerContext;
  return {
    context,
    record,
    messages,
    parts,
    stored: (): MessageWithParts[] =>
      [...messages.values()].map((info) => ({ info, parts: parts.get(info.id) ?? [] })),
    get resumes() {
      return resumes;
    },
  };
}

const SEED_TEXT = [
  "Prior task context transferred from Codex:",
  "User: The internal migration codename is ORANGE-RAVEN-41.",
  "Assistant: Noted.",
].join("\n");

test("seed is a deterministic model-only synthetic message and the runtime is rehydrated", async () => {
  const f = createFakeContext();
  const first = await seedBackendHandoff(f.context, {
    sessionId: SESSION_ID,
    seedId: "rev-1",
    text: SEED_TEXT,
  });
  const second = await seedBackendHandoff(f.context, {
    sessionId: SESSION_ID,
    seedId: "rev-1",
    text: SEED_TEXT,
  });
  assert.equal(
    first.messageId,
    second.messageId,
    "same seedId → same message id (idempotent upsert)",
  );
  assert.equal(f.messages.size, 1);
  const [stored] = f.stored();
  assert.equal(stored!.info.role, "user");
  assert.equal(stored!.info.visibility, "model-only");
  assert.equal(stored!.info.synthetic, true);
  assert.equal(stored!.info.source, "backend_handoff");
  assert.equal(stored!.parts.length, 1);
  assert.equal(f.resumes, 2, "runtime history rebuilt from the store after each write");
});

test("the seed is attributed to the migration destination, not the pre-migration session model", async () => {
  // 种子写在 setModel 之前：会话当前模型仍是迁移前的 Command Code。task meta 同步取最新消息的
  // 模型，所以种子必须按 host 给出的目标选择标注（backend-migration.md Amendment 5）。
  const f = createFakeContext();
  f.record.app.getModel = () => "command-code/gpt-5.6-sol";
  await seedBackendHandoff(f.context, {
    sessionId: SESSION_ID,
    seedId: "rev-1",
    text: SEED_TEXT,
    model: {
      providerId: "azure-openai",
      modelId: "gpt-5-mini",
      options: { reasoningLevel: "low" },
    },
  });
  assert.deepEqual(f.stored()[0]!.info.modelSelection, {
    providerId: "azure-openai",
    modelId: "gpt-5-mini",
    options: { reasoningLevel: "low" },
  });

  // 旧 host 不传目标选择：沿用会话当前模型（兼容路径）。
  const legacy = createFakeContext();
  legacy.record.app.getModel = () => "command-code/gpt-5.6-sol";
  await seedBackendHandoff(legacy.context, {
    sessionId: SESSION_ID,
    seedId: "rev-1",
    text: SEED_TEXT,
  });
  assert.equal(legacy.stored()[0]!.info.modelSelection?.providerId, "command-code");
});

test("the seed is never a visible transcript row (shared projection policy)", async () => {
  const f = createFakeContext();
  await seedBackendHandoff(f.context, { sessionId: SESSION_ID, seedId: "rev-1", text: SEED_TEXT });
  const [stored] = f.stored();
  const policy = getConversationMessageProjectionPolicy(stored as never);
  assert.equal(policy, "providerContextOnly");
});

test("the seed is hydrated into model context, so the model knows pre-migration facts after restart", async () => {
  const f = createFakeContext();
  await seedBackendHandoff(f.context, { sessionId: SESSION_ID, seedId: "rev-1", text: SEED_TEXT });
  const history = new MessageHistoryImpl();
  await hydrateMessageHistoryFromSession({ history, messages: f.stored() });
  const modelContext = JSON.stringify(history.borrowReadOnlyRuntimeEntries());
  assert.ok(modelContext.includes("ORANGE-RAVEN-41"), "the transferred fact reaches model context");
});

test("rollback removes exactly the seed and rehydrates; a running session refuses seeding", async () => {
  const f = createFakeContext();
  await seedBackendHandoff(f.context, { sessionId: SESSION_ID, seedId: "rev-1", text: SEED_TEXT });
  const resumesBefore = f.resumes;
  assert.deepEqual(
    await removeBackendHandoffSeed(f.context, { sessionId: SESSION_ID, seedId: "rev-1" }),
    { removed: true },
  );
  assert.equal(f.messages.size, 0);
  assert.equal(f.resumes, resumesBefore + 1);
  assert.deepEqual(
    await removeBackendHandoffSeed(f.context, { sessionId: SESSION_ID, seedId: "rev-1" }),
    { removed: false },
  );

  f.record.activeAbortController = new AbortController();
  await assert.rejects(
    () =>
      seedBackendHandoff(f.context, { sessionId: SESSION_ID, seedId: "rev-2", text: SEED_TEXT }),
    /prompt is running/,
  );
});
