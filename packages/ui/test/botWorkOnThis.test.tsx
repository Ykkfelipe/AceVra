/**
 * Bot → Coding「Work on this」（docs/specs/cross-mode-bot-to-coding.md）的渲染侧契约。
 *
 * - 摘录只来自本对话的可见文本：合成/注入/model-only 消息、推理、工具输出一律不提供；
 * - 默认勾选最近且放得进预算的摘录，旧摘录显式不勾选（契约记为 user 决定）；
 * - 草稿是冻结契约的 bot → coding packet，可直接确认；不存在任何记忆/身份条目；
 * - Coding 会话的来源提示：有回链能力才显示「Continue with Ace」；
 * - 新文案 en-US / zh-CN 一一对应。
 *
 * Run (from packages/ui): mise exec -- node --import tsx --test test/botWorkOnThis.test.tsx
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  beginHandoffPreview,
  confirmHandoffPreview,
  deserializeHandoffPacket,
  setHandoffContextItemIncluded,
  validateHandoffPacketTransfer,
} from "@zcode/shared/cross-mode";
import type { ConversationRow, CrossModeOriginState } from "@zcode/shared/zcode-protocol-v4";

register("./uiAssetStubLoader.mjs", import.meta.url);
const { ZCodeIntlProvider } = await import("../src/i18n/IntlProvider.js");
const enUS = (await import("../src/i18n/locales/en-US.js")).default as Record<string, string>;
const zhCN = (await import("../src/i18n/locales/zh-CN.js")).default as Record<string, string>;
const {
  buildBotCodingHandoffDraft,
  buildExcerptContextItems,
  defaultHandoffObjective,
  extractBotConversationExcerpts,
  truncateToBytes,
  DEFAULT_INCLUDED_EXCERPTS,
} = await import("../src/bot/workOnThis/botCodingHandoffDraft.js");
const { CrossModeOriginNotice } = await import("../src/v4/CrossModeOriginNotice.js");
const { botConversationIdOfOrigin } = await import("../src/crossMode/CrossModeOriginNavigation.js");

const CONVERSATION = { kind: "conversation" as const, id: "sess_bot_1" };
const LABELS = { excerpt: (role: "user" | "assistant") => (role === "user" ? "You" : "Ace") };

let rowId = 0;
function base(turnId: string) {
  rowId += 1;
  return { rowId, turnId, entityId: `e${String(rowId)}`, createdAt: rowId, createdAtSeq: rowId };
}
function userRow(
  text: string,
  turnId: string,
  extra: Record<string, unknown> = {},
): ConversationRow {
  return {
    ...base(turnId),
    kind: "userInput",
    text,
    origin: "realUser",
    ...extra,
  } as ConversationRow;
}
function assistantRow(text: string, turnId: string, state = "complete"): ConversationRow {
  return { ...base(turnId), kind: "assistantText", text, state } as ConversationRow;
}
function reasoningRow(text: string, turnId: string): ConversationRow {
  return { ...base(turnId), kind: "reasoning", text, state: "complete" } as ConversationRow;
}

test("excerpts keep only real conversation text from this transcript", () => {
  const excerpts = extractBotConversationExcerpts([
    userRow("I want reminders in the app", "t1"),
    reasoningRow("SECRET-REASONING", "t1"),
    assistantRow("We could add", "t1"),
    assistantRow("a settings page for reminders.", "t1"),
    userRow("INJECTED-BACKGROUND", "t2", { origin: "backgroundResult" }),
    assistantRow("STILL-STREAMING", "t2", "streaming"),
    userRow("Sounds good. ENGINE-EPILOGUE", "t3", { epilogueStart: 12 }),
  ]);
  assert.deepEqual(
    excerpts.map((excerpt) => [excerpt.role, excerpt.text]),
    [
      ["user", "I want reminders in the app"],
      ["assistant", "We could add\n\na settings page for reminders."],
      ["user", "Sounds good."],
    ],
  );
  const joined = JSON.stringify(excerpts);
  for (const forbidden of [
    "INJECTED-BACKGROUND",
    "STILL-STREAMING",
    "ENGINE-EPILOGUE",
    "SECRET-REASONING",
  ]) {
    assert.equal(joined.includes(forbidden), false, forbidden);
  }
});

test("only the most recent excerpts start included; older ones are explicit opt-in", () => {
  const rows = Array.from({ length: 7 }, (_, index) =>
    userRow(`message ${String(index)}`, `t${String(index)}`),
  );
  const items = buildExcerptContextItems(
    extractBotConversationExcerpts(rows),
    CONVERSATION,
    LABELS,
  );
  assert.equal(items.length, 7);
  assert.deepEqual(
    items.map((item) => item.included),
    [false, false, false, true, true, true, true],
  );
  assert.equal(items.filter((item) => item.included).length, DEFAULT_INCLUDED_EXCERPTS);
  for (const item of items) {
    assert.equal(item.sensitivity, "standard");
    assert.deepEqual(item.provenance, [CONVERSATION]);
  }
});

test("long messages are truncated under the per-item budget without splitting characters", () => {
  const long = "漢".repeat(2000);
  const truncated = truncateToBytes(long, 1200);
  assert.ok(new TextEncoder().encode(truncated).byteLength <= 1200);
  assert.ok(truncated.endsWith("…"));
  const [excerpt] = extractBotConversationExcerpts([userRow(long, "t1")]);
  assert.ok(excerpt && new TextEncoder().encode(excerpt.text).byteLength <= 1200);
});

test("draft is a transferable bot → coding packet with only explicit context", () => {
  const excerptItems = buildExcerptContextItems(
    extractBotConversationExcerpts([
      userRow("Add reminders", "t1"),
      assistantRow("Sounds good", "t1"),
    ]),
    CONVERSATION,
    LABELS,
  );
  const toggled = setHandoffContextItemIncluded(
    { context: excerptItems },
    excerptItems[0]!.id,
    false,
  ).context;
  const packet = buildBotCodingHandoffDraft({
    conversationRef: CONVERSATION,
    objective: "  Add a reminders settings page ",
    notes: "Reuse the form controls",
    notesLabel: "Notes for the work",
    excerptItems: toggled,
  });
  assert.equal(packet.sourceMode, "bot");
  assert.equal(packet.destinationMode, "coding");
  assert.equal(packet.objective, "Add a reminders settings page");
  assert.deepEqual(packet.sourceRefs, [CONVERSATION]);
  assert.equal(packet.linkedProject, null);
  assert.deepEqual(
    packet.context.map((item) => [item.label, item.included]),
    [
      ["Notes for the work", true],
      ["You", false],
      ["Ace", true],
    ],
  );
  assert.deepEqual(validateHandoffPacketTransfer(packet), []);
  // 契约层确认 → 快照可被 CLI 原样重新解析。
  const confirmed = confirmHandoffPreview(beginHandoffPreview(packet));
  assert.equal(confirmed.ok, true);
  if (confirmed.ok && confirmed.session.confirmation) {
    assert.deepEqual(deserializeHandoffPacket(confirmed.session.confirmation.packetJson), packet);
  }
  // 没有任何记忆 / 身份条目可以出现在草稿里。
  assert.equal(
    /memory|profile|identity/i.test(packet.context.map((item) => item.label).join()),
    false,
  );
});

test("objective defaults to the conversation title, bounded by the contract", () => {
  assert.equal(defaultHandoffObjective("  Trip   planning "), "Trip planning");
  assert.equal(defaultHandoffObjective(null), "");
  assert.equal(defaultHandoffObjective("x".repeat(800)).length, 500);
});

const ORIGIN: CrossModeOriginState = {
  version: "cross-mode-origin/v1",
  handoffId: "h1",
  sourceMode: "bot",
  destinationMode: "coding",
  objective: "Add a reminders settings page",
  sourceRefs: [CONVERSATION],
  returnPolicy: "summary",
  resultRef: { kind: "coding-session", id: "sess_code_1" },
  acceptedAt: 1,
};

test("origin notice shows the source and offers Continue with Ace only when navigable", () => {
  const markup = renderToStaticMarkup(
    <ZCodeIntlProvider locale="en-US">
      <CrossModeOriginNotice origin={ORIGIN} />
    </ZCodeIntlProvider>,
  );
  assert.match(markup, /Started from a conversation with Ace/);
  assert.match(markup, /Add a reminders settings page/);
  // 无回链 provider（Web / 测试）时不提供按钮。
  assert.equal(markup.includes("cross-mode-origin-open"), false);
  assert.equal(botConversationIdOfOrigin(ORIGIN), "sess_bot_1");
  assert.equal(botConversationIdOfOrigin({ ...ORIGIN, sourceMode: "coding" }), null);
});

test("new copy exists in both locales", () => {
  const keys = Object.keys(enUS).filter(
    (key) => key.startsWith("bot.workOnThis.") || key.startsWith("crossMode.origin."),
  );
  assert.ok(keys.length >= 20);
  for (const key of keys) assert.ok(zhCN[key], `zh-CN missing ${key}`);
  const zhKeys = Object.keys(zhCN).filter(
    (key) => key.startsWith("bot.workOnThis.") || key.startsWith("crossMode.origin."),
  );
  assert.deepEqual(zhKeys.sort(), keys.sort());
});

test("the handoff continues on the model the Ace conversation last used", async () => {
  const { buildCrossModeCreateSessionPayload } =
    await import("../src/hooks/useCrossModeCodingLaunch.js");
  const packet = buildBotCodingHandoffDraft({
    conversationRef: CONVERSATION,
    objective: "Add reminders",
    notes: "",
    notesLabel: "Notes for the work",
    excerptItems: [],
  });
  const confirmed = confirmHandoffPreview(beginHandoffPreview(packet));
  assert.ok(confirmed.ok && confirmed.session.confirmation);
  if (!confirmed.ok || !confirmed.session.confirmation) return;
  const target = { workspacePath: "/repo/app" };
  const botSelection = {
    providerId: "zai-start-plan",
    modelId: "glm-5.3-flash",
    options: { reasoningLevel: "low" },
  };
  const payload = buildCrossModeCreateSessionPayload(
    target,
    confirmed.session.confirmation,
    botSelection,
  );
  // 走既有 createSession.config：provider、model 与 effort 一并沿用。
  assert.deepEqual(payload.config, { modelSelection: botSelection });
  assert.equal(payload.crossModeHandoff?.confirmation.handoffId, packet.handoffId);
  assert.equal(payload.workspaceId, "/repo/app");
  // 来源对话没有持久选择时不伪造 config，交给运行时默认。
  const withoutSelection = buildCrossModeCreateSessionPayload(
    target,
    confirmed.session.confirmation,
  );
  assert.equal("config" in withoutSelection, false);
});
