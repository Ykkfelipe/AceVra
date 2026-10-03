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
import type { ZCodeMessageWithParts } from "@zcode/shared";
import {
  beginHandoffPreview,
  confirmHandoffPreview,
  deserializeHandoffPacket,
  setHandoffContextItemIncluded,
  validateHandoffPacketTransfer,
} from "@zcode/shared/cross-mode";
import type { CrossModeOriginState } from "@zcode/shared/zcode-protocol-v4";

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

let sequence = 0;
function userMessage(
  text: string,
  info: Record<string, unknown> = {},
  parts?: ZCodeMessageWithParts["parts"],
): ZCodeMessageWithParts {
  sequence += 1;
  const messageId = `m${String(sequence)}`;
  return {
    info: {
      messageId,
      sessionId: "sess_bot_1",
      role: "user",
      time: { created: sequence },
      agent: "build",
      ...info,
    },
    parts: parts ?? [
      { partId: `p${messageId}`, sessionId: "sess_bot_1", messageId, type: "text", text },
    ],
  } as ZCodeMessageWithParts;
}

function assistantMessage(text: string, extraParts: unknown[] = []): ZCodeMessageWithParts {
  sequence += 1;
  const messageId = `m${String(sequence)}`;
  return {
    info: {
      messageId,
      sessionId: "sess_bot_1",
      role: "assistant",
      time: { created: sequence },
      parentMessageId: "m0",
      agent: "build",
      path: { cwd: "/bot", root: "/bot" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        partId: `r${messageId}`,
        sessionId: "sess_bot_1",
        messageId,
        type: "reasoning",
        text: "SECRET-REASONING",
      },
      ...extraParts,
      { partId: `p${messageId}`, sessionId: "sess_bot_1", messageId, type: "text", text },
    ],
  } as unknown as ZCodeMessageWithParts;
}

test("excerpts keep only visible conversation text from this transcript", () => {
  const excerpts = extractBotConversationExcerpts([
    userMessage("I want reminders in the app"),
    userMessage("INJECTED-BACKGROUND", { synthetic: true, source: "background_task" }),
    userMessage("MODEL-ONLY", { visibility: "model-only" }),
    assistantMessage("We could add a settings page for reminders."),
    userMessage("", {}, [
      {
        partId: "px",
        sessionId: "sess_bot_1",
        messageId: "mx",
        type: "text",
        text: "SYNTH",
        synthetic: true,
      },
    ] as ZCodeMessageWithParts["parts"]),
  ]);
  assert.deepEqual(
    excerpts.map((excerpt) => [excerpt.role, excerpt.text]),
    [
      ["user", "I want reminders in the app"],
      ["assistant", "We could add a settings page for reminders."],
    ],
  );
  const joined = JSON.stringify(excerpts);
  for (const forbidden of ["INJECTED-BACKGROUND", "MODEL-ONLY", "SYNTH", "SECRET-REASONING"]) {
    assert.equal(joined.includes(forbidden), false, forbidden);
  }
});

test("only the most recent excerpts start included; older ones are explicit opt-in", () => {
  const messages = Array.from({ length: 7 }, (_, index) => userMessage(`message ${String(index)}`));
  const items = buildExcerptContextItems(
    extractBotConversationExcerpts(messages),
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
  const [excerpt] = extractBotConversationExcerpts([userMessage(long)]);
  assert.ok(excerpt && new TextEncoder().encode(excerpt.text).byteLength <= 1200);
});

test("draft is a transferable bot → coding packet with only explicit context", () => {
  const excerptItems = buildExcerptContextItems(
    extractBotConversationExcerpts([userMessage("Add reminders"), assistantMessage("Sounds good")]),
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
