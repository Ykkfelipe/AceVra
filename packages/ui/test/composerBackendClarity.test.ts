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

test("Codex backend copy states the default sentinel, picker labels, and effort tiers", () => {
  assert.equal(enUS["chat.toolbar.backend.codex.modelManaged"], "Codex default");
  assert.equal(enUS["chat.toolbar.backend.codex.modelPickerLabel"], "Codex model");
  assert.equal(enUS["chat.toolbar.backend.codex.modelDefault"], "Default (Codex app setting)");
  assert.equal(enUS["chat.toolbar.backend.codex.effort.label"], "Reasoning effort");
  assert.equal(enUS["chat.toolbar.backend.codex.effort.high"], "High");
  assert.equal(zhCN["chat.toolbar.backend.codex.modelManaged"], "Codex 默认");
  assert.equal(zhCN["chat.toolbar.backend.codex.modelPickerLabel"], "Codex 模型");
  assert.equal(zhCN["chat.toolbar.backend.codex.modelDefault"], "默认（Codex 应用设置）");
  assert.equal(zhCN["chat.toolbar.backend.codex.effort.label"], "推理强度");
  assert.equal(zhCN["chat.toolbar.backend.codex.effort.high"], "高");
});
