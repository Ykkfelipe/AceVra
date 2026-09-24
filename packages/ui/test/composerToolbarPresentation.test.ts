import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  COMPOSER_TOOLBAR_GROUP_CLASS,
  COMPOSER_TOOLBAR_TRIGGER_CLASS,
} from "../src/v4/composer/composerToolbarPresentation.js";

test("the built-in composer backend is presented as a generalized agent", () => {
  assert.equal(enUS["chat.toolbar.backend.zcode.label"], "Agent");
  assert.equal(enUS["chat.toolbar.backend.zcode.description"], "Run tasks with the built-in agent");
  assert.equal(zhCN["chat.toolbar.backend.zcode.label"], "智能体");
  assert.equal(zhCN["chat.toolbar.backend.zcode.description"], "使用内置智能体执行任务");
});

test("composer action groups expose localized toolbar names", () => {
  assert.equal(enUS["chat.composer.leadingActions.label"], "Conversation actions");
  assert.equal(enUS["chat.composer.taskOptions.label"], "Task options");
  assert.equal(zhCN["chat.composer.leadingActions.label"], "会话操作");
  assert.equal(zhCN["chat.composer.taskOptions.label"], "任务选项");
});

test("composer toolbar controls share an accessible focus and hit-target contract", () => {
  for (const token of [
    "size-7",
    "rounded-lg",
    "focus-visible:ring-2",
    "focus-visible:ring-input-border-focused",
    "aria-expanded:bg-input-focused",
  ]) {
    assert.ok(
      COMPOSER_TOOLBAR_TRIGGER_CLASS.includes(token),
      `toolbar trigger class must include ${token}`,
    );
  }
  assert.equal(COMPOSER_TOOLBAR_GROUP_CLASS, "flex min-w-0 items-center gap-1");
});
