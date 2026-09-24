import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { resolveChatPlaceholderKey } from "../src/lib/chatPlaceholder.js";

test("reject routing explains the paused input instead of locking silently", () => {
  assert.equal(
    resolveChatPlaceholderKey({
      hasHistoryMessages: true,
      isTaskProcessing: true,
      inputRejected: true,
    }),
    "chat.placeholder.inputPaused",
  );
  assert.equal(
    resolveChatPlaceholderKey({
      hasHistoryMessages: true,
      isTaskProcessing: false,
      inputRejected: true,
    }),
    "chat.placeholder.inputPaused",
  );
  assert.equal(
    resolveChatPlaceholderKey({ hasHistoryMessages: true, isTaskProcessing: false }),
    "chat.placeholder.followUpAsk",
  );
  assert.equal(
    enUS["chat.placeholder.inputPaused"],
    "The agent is working — follow-up input is paused",
  );
  assert.equal(zhCN["chat.placeholder.inputPaused"], "智能体正在工作，暂时不能输入");
});

test("Codex backend copy states that the model is managed by Codex", () => {
  assert.equal(enUS["chat.toolbar.backend.codex.modelManaged"], "Model managed by Codex");
  assert.equal(zhCN["chat.toolbar.backend.codex.modelManaged"], "模型由 Codex 管理");
});
