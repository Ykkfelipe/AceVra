/**
 * Bot Workspace V2（docs/specs/personal-bot.md §16）的展示与时序契约。
 *
 * - 历史只来自 personal_bot 会话事实：过滤、去重、按最近活动排序、按本地日期分组；
 * - 选择规则防止过期回调改选择（慢一步的 create ACK、已切走后的 delete/sessionNotFound）；
 * - 历史刷新单飞合并，不需要定时器；
 * - Bot 侧栏只渲染 Bot 内容，Bot 视图不渲染 Coding 的 header / 侧栏 / 终端；
 * - 新文案 en-US / zh-CN 一一对应。
 *
 * Run (from packages/ui): mise exec -- node --import tsx --test test/botWorkspaceV2.test.tsx
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ZCodeSessionInfo } from "@zcode/shared";

register("./uiAssetStubLoader.mjs", import.meta.url);
const { ZCodeIntlProvider } = await import("../src/i18n/IntlProvider.js");
const enUS = (await import("../src/i18n/locales/en-US.js")).default as Record<string, string>;
const zhCN = (await import("../src/i18n/locales/zh-CN.js")).default as Record<string, string>;
const { groupBotConversationRows, resolveBotConversationGroupId, toBotConversationRows } =
  await import("../src/bot/botConversationHistory.js");
const {
  createSingleFlight,
  presentationNeedsHistoryRefresh,
  selectionAfterBoundSessionLost,
  selectionAfterSessionCreated,
} = await import("../src/bot/botWorkspaceSelection.js");
const { resolveChatPlaceholderKey } = await import("../src/lib/chatPlaceholder.js");
const { BotConversationSidebarView } = await import("../src/bot/BotConversationSidebar.js");

const BOT_WORKSPACE = "/tmp/zcode-test/workspace/personal-bot";
const HOUR = 60 * 60 * 1000;

function sessionInfo(
  overrides: Partial<ZCodeSessionInfo> & { sessionId: string },
): ZCodeSessionInfo {
  return {
    workspace: { workspacePath: BOT_WORKSPACE, workspaceKey: BOT_WORKSPACE },
    sessionKind: "personal_bot",
    title: "",
    mode: "build",
    status: "idle",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  } as ZCodeSessionInfo;
}

/** 本地时间的固定「现在」：周三中午，避开午夜边界。 */
const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime();

test("history keeps only live personal_bot sessions, newest first, deduplicated", () => {
  const rows = toBotConversationRows([
    sessionInfo({ sessionId: "a", title: "  Trip plan ", updatedAt: 3_000 }),
    sessionInfo({ sessionId: "b", title: "Dinner", updatedAt: 5_000 }),
    // 旧 CLI 忽略 projection 时可能混进 Coding 会话：必须挡住。
    sessionInfo({
      sessionId: "coding",
      title: "Fix login",
      sessionKind: "interactive",
      updatedAt: 9_000,
    }),
    sessionInfo({ sessionId: "archived", title: "Old", archivedAt: 4_000, updatedAt: 4_000 }),
    // store 行与 live 记录同时出现时保留更新的一份。
    sessionInfo({ sessionId: "a", title: "Trip plan v2", updatedAt: 6_000 }),
  ]);
  assert.deepEqual(
    rows.map((row) => [row.sessionId, row.title]),
    [
      ["a", "Trip plan v2"],
      ["b", "Dinner"],
    ],
  );
});

test("rows group by local calendar day: Today / Yesterday / Previous 7 days / Older", () => {
  const today = new Date(2026, 9, 7, 0, 5).getTime();
  const yesterdayLate = new Date(2026, 9, 6, 23, 59).getTime();
  const yesterdayEarly = new Date(2026, 9, 6, 0, 1).getTime();
  const sixDaysAgo = new Date(2026, 9, 1, 9, 0).getTime();
  const sevenDaysAgo = new Date(2026, 8, 30, 9, 0).getTime();
  const eightDaysAgo = new Date(2026, 8, 29, 9, 0).getTime();
  assert.equal(resolveBotConversationGroupId(today, NOW), "today");
  assert.equal(resolveBotConversationGroupId(yesterdayLate, NOW), "yesterday");
  assert.equal(resolveBotConversationGroupId(yesterdayEarly, NOW), "yesterday");
  assert.equal(resolveBotConversationGroupId(sixDaysAgo, NOW), "previous7Days");
  assert.equal(resolveBotConversationGroupId(sevenDaysAgo, NOW), "previous7Days");
  assert.equal(resolveBotConversationGroupId(eightDaysAgo, NOW), "older");

  const rows = toBotConversationRows([
    sessionInfo({ sessionId: "old", updatedAt: eightDaysAgo }),
    sessionInfo({ sessionId: "y", updatedAt: yesterdayLate }),
    sessionInfo({ sessionId: "t", updatedAt: NOW - HOUR }),
  ]);
  const groups = groupBotConversationRows(rows, NOW);
  assert.deepEqual(
    groups.map((group) => [group.id, group.rows.map((row) => row.sessionId)]),
    [
      ["today", ["t"]],
      ["yesterday", ["y"]],
      ["older", ["old"]],
    ],
  );
});

test("a late create ACK never steals the selection from a conversation the user opened", () => {
  // 草稿仍被选中：采用新会话。
  assert.equal(selectionAfterSessionCreated(null, "sess_new"), "sess_new");
  // 用户已切到别的对话：保持用户的选择。
  assert.equal(selectionAfterSessionCreated("sess_other", "sess_new"), "sess_other");
});

test("delete / sessionNotFound clears only the conversation that is still selected", () => {
  assert.equal(selectionAfterBoundSessionLost("sess_a", "sess_a"), null);
  assert.equal(selectionAfterBoundSessionLost("sess_b", "sess_a"), "sess_b");
  assert.equal(selectionAfterBoundSessionLost(null, "sess_a"), null);
});

test("history refresh is needed only for new rows, settled titles or finished turns", () => {
  const rows = toBotConversationRows([sessionInfo({ sessionId: "a", title: "Trip plan" })]);
  assert.equal(
    presentationNeedsHistoryRefresh(rows, { sessionId: "new", title: "", sessionEnded: false }),
    true,
  );
  assert.equal(
    presentationNeedsHistoryRefresh(rows, {
      sessionId: "a",
      title: "Trip plan",
      sessionEnded: false,
    }),
    false,
  );
  assert.equal(
    presentationNeedsHistoryRefresh(rows, {
      sessionId: "a",
      title: "Trip to Lima",
      sessionEnded: false,
    }),
    true,
  );
  assert.equal(
    presentationNeedsHistoryRefresh(rows, {
      sessionId: "a",
      title: "Trip plan",
      sessionEnded: true,
    }),
    true,
  );
});

test("history refresh is single-flight with exactly one trailing run of the latest task", async () => {
  const flight = createSingleFlight();
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = flight.run(async () => {
    calls.push("first");
    await gate;
  });
  void flight.run(async () => {
    calls.push("second");
  });
  void flight.run(async () => {
    calls.push("third");
  });
  assert.deepEqual(calls, ["first"]);
  release();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["first", "third"]);
});

test("the Bot composer speaks like an assistant, the coding composer is unchanged", () => {
  const idle = { hasHistoryMessages: false, isTaskProcessing: false };
  assert.equal(resolveChatPlaceholderKey(idle), "chat.placeholder.newTask");
  assert.equal(
    resolveChatPlaceholderKey({ ...idle, variant: "assistant" }),
    "chat.placeholder.assistant.new",
  );
  assert.equal(
    resolveChatPlaceholderKey({
      hasHistoryMessages: true,
      isTaskProcessing: false,
      variant: "assistant",
    }),
    "chat.placeholder.assistant.followUp",
  );
  assert.equal(
    resolveChatPlaceholderKey({
      hasHistoryMessages: true,
      isTaskProcessing: true,
      variant: "assistant",
    }),
    "chat.placeholder.assistant.queue",
  );
  // 运行时显式拒绝输入时仍解释原因，两种风格一致。
  assert.equal(
    resolveChatPlaceholderKey({ ...idle, inputRejected: true, variant: "assistant" }),
    "chat.placeholder.inputPaused",
  );
});

function renderSidebar(props: Partial<Parameters<typeof BotConversationSidebarView>[0]>): string {
  return renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="en-US" messages={enUS}>
      <BotConversationSidebarView
        displayName="Ace"
        descriptor="Personal assistant"
        rows={[]}
        historyStatus="ready"
        selectedSessionId={null}
        now={NOW}
        onSelectConversation={() => {}}
        onNewConversation={() => {}}
        onRetry={() => {}}
        {...props}
      />
    </ZCodeIntlProvider>,
  );
}

test("the Bot sidebar shows Ace, New conversation and grouped history — no coding chrome", () => {
  const rows = toBotConversationRows([
    sessionInfo({ sessionId: "sess_today", title: "Trip plan", updatedAt: NOW - HOUR }),
    sessionInfo({ sessionId: "sess_untitled", title: "", updatedAt: NOW - 2 * HOUR }),
    sessionInfo({ sessionId: "sess_old", title: "Dinner ideas", updatedAt: NOW - 30 * 24 * HOUR }),
  ]);
  const markup = renderSidebar({ rows, selectedSessionId: "sess_today" });

  assert.match(markup, /data-testid="bot-sidebar"/);
  assert.match(markup, />Ace</);
  assert.match(markup, /data-testid="bot-new-conversation"[^>]*aria-pressed="false"/);
  assert.ok(markup.indexOf("Today") < markup.indexOf("Older"), "groups render newest first");
  assert.match(markup, /data-session-id="sess_today"[^>]*aria-current="page"/);
  assert.match(markup, /Trip plan/);
  // 尚无标题的会话显示「New conversation」而不是空行。
  assert.match(markup, /data-session-id="sess_untitled"[\s\S]*?New conversation/);
  for (const codingLabel of ["Projects", "Group", "Tasks", "New task"]) {
    assert.ok(!markup.includes(`>${codingLabel}<`), `coding chrome leaked: ${codingLabel}`);
  }
});

test("the Bot sidebar marks the draft, and explains empty and failed history", () => {
  const draft = renderSidebar({ selectedSessionId: null });
  assert.match(draft, /data-testid="bot-new-conversation"[^>]*aria-pressed="true"/);
  assert.match(draft, /No conversations yet/);

  const failed = renderSidebar({ historyStatus: "error" });
  assert.match(failed, /Couldn&#x27;t load your conversations\./);
  assert.match(failed, /Retry/);
});

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../src/${relativePath}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

test("the Bot main view renders no coding header, terminal or coding sidebar", () => {
  const layout = readSource("app-shell/WorkspaceShellLayout.tsx");
  assert.match(
    layout,
    /shouldRenderMainViewHeader =[\s\S]{0,200}workspaceMainView !== "bot"/,
    "WorkspaceHeader must be excluded from the Bot view",
  );
  assert.match(
    layout,
    /workspaceMainView !== "bot" \? \(\s*<AnimatedTerminalPanel/,
    "the terminal panel must be excluded from the Bot view",
  );
  assert.match(layout, /isBotMainView && "hidden"/, "the coding sidebar hides while Bot is active");
  assert.match(layout, /isBotMainView \? <BotConversationSidebar \/> : null/);
  assert.match(layout, /<GlobalNavRail/);
});

test("new Bot Workspace V2 strings exist in both locales", () => {
  const prefixes = [
    "bot.sidebar.",
    "bot.header.",
    "bot.inspector.",
    "globalNav.",
    "chat.placeholder.assistant.",
  ];
  const enKeys = Object.keys(enUS).filter((key) =>
    prefixes.some((prefix) => key.startsWith(prefix)),
  );
  assert.ok(enKeys.length >= 20, "V2 strings should be present");
  assert.deepEqual(
    enKeys.filter((key) => !(key in zhCN)),
    [],
    "missing zh-CN translations",
  );
  const zhKeys = Object.keys(zhCN).filter((key) =>
    prefixes.some((prefix) => key.startsWith(prefix)),
  );
  assert.deepEqual(
    zhKeys.filter((key) => !(key in enUS)),
    [],
    "missing en-US translations",
  );
  for (const group of ["today", "yesterday", "previous7Days", "older"]) {
    assert.ok(`bot.sidebar.group.${group}` in enUS, `missing group label ${group}`);
  }
});

test("the Bot Computers tab hosts the live Computer pane, not the account registry", () => {
  const inspector = readSource("bot/BotInspector.tsx");
  assert.match(inspector, /BotComputerPane/, "the Computers tab must render the live pane wrapper");
  assert.ok(!inspector.includes("BotComputersPanel"), "the account-registry panel must be gone");
  assert.match(inspector, /value=\{tab\}[\s\S]*?onValueChange/, "the tabs are controlled");

  const pane = readSource("bot/BotComputerPane.tsx");
  assert.match(pane, /from "@\/computers\/ComputerPane\.js"/, "same pane as the coding side panel");
  assert.match(pane, /stopGeneration/, "Stop ends the owning chat turn");
  assert.match(pane, /jobSessionId !== selectedSessionId/, "Stop never crosses conversations");
});

test("the first RemoteComputer action auto-opens the inspector on Computers", () => {
  const section = readSource("bot/BotSection.tsx");
  assert.match(section, /useComputerSessionAutoOpen\(/, "BotSection must listen for the notice");
  assert.match(
    section,
    /setComputerId\([\s\S]{0,80}setInspectorTab\("computers"\)[\s\S]{0,80}setInspectorOpen\(true\)/,
    "the notice selects the computer, opens Computers and reveals the inspector",
  );
});

test("the account-registry strings left the locales with the old panel", () => {
  for (const messages of [enUS, zhCN]) {
    assert.deepEqual(
      Object.keys(messages).filter((key) => key.startsWith("bot.computers.")),
      [],
      "bot.computers.* must be removed",
    );
    assert.ok("bot.tab.computers" in messages, "the tab label stays");
  }
});
