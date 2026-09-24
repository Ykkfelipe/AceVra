import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  COMPOSER_TOOLBAR_GROUP_CLASS,
  COMPOSER_TOOLBAR_TRIGGER_CLASS,
  resolveCodexModelControlKind,
} from "../src/v4/composer/composerToolbarPresentation.js";

test("the built-in composer backend is presented as a generalized agent", () => {
  assert.equal(enUS["chat.toolbar.backend.zcode.label"], "Agent");
  assert.equal(enUS["chat.toolbar.backend.zcode.description"], "Run tasks with the built-in agent");
  assert.equal(zhCN["chat.toolbar.backend.zcode.label"], "智能体");
  assert.equal(zhCN["chat.toolbar.backend.zcode.description"], "使用内置智能体执行任务");
});

test("composer entry copy uses a generalized agent actor", () => {
  assert.equal(
    enUS["chat.placeholder.newTask"],
    "Ask the agent anything, @ to add context, / for commands or capabilities",
  );
  assert.equal(enUS["chat.placeholder.newTaskMobile"], "Ask the agent anything…");
  assert.equal(
    zhCN["chat.placeholder.newTask"],
    "向智能体提问，使用 @ 添加上下文，使用 / 选择命令或能力",
  );
  assert.equal(zhCN["chat.placeholder.newTaskMobile"], "向智能体提问…");
});

test("composer action groups expose localized toolbar names", () => {
  assert.equal(enUS["chat.composer.leadingActions.label"], "Conversation actions");
  assert.equal(enUS["chat.composer.taskOptions.label"], "Task options");
  assert.equal(zhCN["chat.composer.leadingActions.label"], "会话操作");
  assert.equal(zhCN["chat.composer.taskOptions.label"], "任务选项");
});

test("composer toolbar controls expand with labels and preserve an icon-only floor", () => {
  for (const token of [
    "h-7",
    "min-w-7",
    "max-w-full",
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
  assert.equal(COMPOSER_TOOLBAR_TRIGGER_CLASS.includes("size-7"), false);
  assert.equal(COMPOSER_TOOLBAR_GROUP_CLASS, "flex min-w-0 items-center gap-1");
});

test("codex model control is interactive only in draft and static in created sessions", () => {
  assert.equal(resolveCodexModelControlKind({ draftMode: true, backend: "codex" }), "dropdown");
  assert.equal(resolveCodexModelControlKind({ draftMode: false, backend: "codex" }), "static");
  assert.equal(resolveCodexModelControlKind({ draftMode: true, backend: "zcode" }), null);
  assert.equal(resolveCodexModelControlKind({ draftMode: false, backend: "zcode" }), null);
});
