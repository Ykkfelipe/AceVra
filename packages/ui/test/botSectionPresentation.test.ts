/**
 * Personal Bot 主视图的展示契约：
 * - Bot 的 i18n key 在 en-US / zh-CN 两份目录中一一对应（缺一条就会出现回退成 id 的界面）；
 * - 能力域与记忆分类的 key 必须覆盖 domain 侧的真实枚举，而不是手写子集。
 *
 * Run: TSX_TSCONFIG_PATH=packages/ui/tsconfig.json mise exec -- node --import tsx --test packages/ui/test/botSectionPresentation.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

const enUS = (await import("../src/i18n/locales/en-US.js")).default as Record<string, string>;
const zhCN = (await import("../src/i18n/locales/zh-CN.js")).default as Record<string, string>;
const { BOT_CAPABILITY_DOMAINS, PERSONAL_MEMORY_CATEGORIES } = await import("@zcode/services");

const enBotKeys = Object.keys(enUS).filter((key) => key.startsWith("bot."));
const zhBotKeys = Object.keys(zhCN).filter((key) => key.startsWith("bot."));

test("every bot string exists in both locales", () => {
  const missingInZh = enBotKeys.filter((key) => !(key in zhCN));
  const missingInEn = zhBotKeys.filter((key) => !(key in enUS));
  assert.deepEqual(missingInZh, [], "missing zh-CN translations");
  assert.deepEqual(missingInEn, [], "missing en-US translations");
  assert.ok(enBotKeys.length >= 40, "bot namespace should be populated");
});

test("capability and memory category keys cover the real enums", () => {
  for (const domain of BOT_CAPABILITY_DOMAINS) {
    assert.ok(`bot.capability.domain.${domain}` in enUS, `missing label for domain ${domain}`);
  }
  for (const category of PERSONAL_MEMORY_CATEGORIES) {
    assert.ok(`bot.memory.category.${category}` in enUS, `missing label for category ${category}`);
  }
});

test("the sidebar entry and the empty/loading states are localized", () => {
  for (const key of [
    "bot.nav.open",
    "bot.loading",
    "bot.unavailable",
    "bot.memory.empty",
    "bot.conversation.starting",
    "bot.conversation.loadFailed",
    "bot.capability.available",
    "bot.capability.notConfigured",
    "bot.capability.planned",
    // §15：右侧上下文面板的三个标签页与 Computers 标签页的只读文案。
    "bot.tab.memory",
    "bot.tab.computers",
    "bot.tab.capabilities",
    "bot.computers.count",
    "bot.computers.empty",
    "bot.computers.unavailable",
    "bot.computers.role.thisDevice",
    "bot.computers.role.desktop",
    "bot.computers.role.node",
    "bot.computers.presence.online",
    "bot.computers.presence.offline",
    "bot.computers.presence.revoked",
    "bot.computers.capability.computerUse",
    "bot.computers.capability.shell",
    "bot.computers.capability.files",
    "bot.computers.capability.git",
    "bot.computers.capability.longTasks",
    "bot.computers.capability.minecraft",
  ]) {
    assert.ok(key in enUS, `missing ${key}`);
    assert.ok(key in zhCN, `missing ${key}`);
  }
});

test("no bot string is left as a placeholder id", () => {
  for (const key of enBotKeys) {
    assert.notEqual(enUS[key], key, `${key} has no en-US text`);
    assert.notEqual(zhCN[key], key, `${key} has no zh-CN text`);
  }
});
