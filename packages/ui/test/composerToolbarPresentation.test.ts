import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  COMPOSER_TOOLBAR_GROUP_CLASS,
  COMPOSER_TOOLBAR_TRIGGER_CLASS,
  resolveCodexModelControlKind,
  shouldShowComposerProviderMenu,
} from "../src/v4/composer/composerToolbarPresentation.js";
import { resolveV4ComposerConfigPickerState } from "../src/v4/composer/configPickerState.js";

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

test("codex model control is interactive in both draft and created codex sessions", () => {
  assert.equal(
    resolveCodexModelControlKind({ draftMode: true, codexSession: false, backend: "codex" }),
    "dropdown",
  );
  assert.equal(
    resolveCodexModelControlKind({ draftMode: false, codexSession: true, backend: "zcode" }),
    "dropdown",
  );
  assert.equal(
    resolveCodexModelControlKind({ draftMode: true, codexSession: false, backend: "zcode" }),
    null,
  );
  assert.equal(
    resolveCodexModelControlKind({ draftMode: false, codexSession: false, backend: "zcode" }),
    null,
  );
});

test("the Provider menu stays available on existing zcode-family sessions, not just drafts", () => {
  // 已有 zcode family 会话（Z.ai/Azure/Command Code 等）：Provider 菜单必须继续显示，
  // 复用切模型同一条草稿写路径——这正是本次修的 bug：曾经整个 draftMode 一并隐藏。
  assert.equal(shouldShowComposerProviderMenu({ draftMode: false, codexSession: false }), true);
  // 新任务草稿：始终显示，不论最终是不是选 Codex。
  assert.equal(shouldShowComposerProviderMenu({ draftMode: true, codexSession: false }), true);
  assert.equal(shouldShowComposerProviderMenu({ draftMode: true, codexSession: true }), true);
  // 旧 host（未注册迁移服务）：已有 Codex 会话让位给 Codex 专属模型/effort 控件，
  // 没有迁回 Agent 的入口。
  assert.equal(shouldShowComposerProviderMenu({ draftMode: false, codexSession: true }), false);
  // 装了迁移服务：Provider 菜单是迁回 Agent 的唯一入口，必须保留。
  assert.equal(
    shouldShowComposerProviderMenu({
      draftMode: false,
      codexSession: true,
      backendMigrationAvailable: true,
    }),
    true,
  );
});

test("Codex model and effort menus occupy separate picker slots", () => {
  assert.equal(resolveV4ComposerConfigPickerState(null, "codexModel", true), "codexModel");
  assert.equal(
    resolveV4ComposerConfigPickerState("codexModel", "codexEffort", true),
    "codexEffort",
  );
  assert.equal(
    resolveV4ComposerConfigPickerState("codexEffort", "codexModel", false),
    "codexEffort",
  );
  assert.equal(resolveV4ComposerConfigPickerState("codexEffort", "codexEffort", false), null);
});
