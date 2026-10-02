/**
 * Computer Use runs as an `mcp__node_repl__js` cell, so its transcript row is rendered by the
 * node-repl renderer, not the CUA card. The row header must therefore show the product-owned
 * localized action label (plus the target app when the cell carries an app identity) and never
 * the model-authored `title` the cell input carries — in either locale.
 *
 * Run: TSX_TSCONFIG_PATH=packages/ui/tsconfig.json mise exec -- node --import tsx --test packages/ui/test/nodeReplComputerActionLabel.test.tsx
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

register("./uiAssetStubLoader.mjs", import.meta.url);

const { ZCodeIntlProvider } = await import("../src/i18n/IntlProvider.js");
const enUS = (await import("../src/i18n/locales/en-US.js")).default;
const zhCN = (await import("../src/i18n/locales/zh-CN.js")).default;
const { NodeReplToolCallBlock } = await import("../src/ToolCallBlocks/renderers/node-repl.js");

type ChatToolCall = Parameters<typeof NodeReplToolCallBlock>[0]["toolCallNode"]["toolCall"];

/** A Computer Use js cell: model-authored `title` plus a structured result with the operation. */
function computerCell(
  operation: string,
  overrides: { title?: string; app?: { appKey: string; displayName?: string } } = {},
): ChatToolCall {
  return {
    toolId: `tool-${operation}`,
    toolName: "mcp__node_repl__js",
    kind: "js",
    input: {
      code: "const s = await agent.computerUse.observe({ app: 'chrome' })",
      title: overrides.title ?? "查找全局电脑对象",
    },
    output: "done",
    status: "completed",
    raw: {
      result: { operation, effect: "confirmed" },
      display: {
        kind: "node_repl_images",
        ...(overrides.app ? { app: overrides.app } : {}),
      },
    },
  } as unknown as ChatToolCall;
}

function render(cell: ChatToolCall, locale: "en-US" | "zh-CN" = "en-US"): string {
  const context = {
    toolCallNode: { toolCall: cell, childToolCalls: [] },
    isRunning: false,
    childToolList: null,
  } as unknown as Parameters<typeof NodeReplToolCallBlock>[0];
  return renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale={locale} messages={locale === "zh-CN" ? zhCN : enUS}>
      <NodeReplToolCallBlock {...context} />
    </ZCodeIntlProvider>,
  );
}

const visibleText = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("a known Computer operation renders the product label, not the model's title", () => {
  const markup = render(computerCell("click"));
  const text = visibleText(markup);
  assert.match(text, /Clicking/);
  assert.match(text, /Completed/);
  assert.doesNotMatch(text, /查找全局电脑对象/);
});

test("the English UI never shows model-authored English reasoning text either", () => {
  const markup = render(computerCell("observe", { title: "Look for global computer object" }));
  const text = visibleText(markup);
  assert.match(text, /Observing/);
  assert.doesNotMatch(text, /Look for global computer object/);
});

test("the target app is shown next to the action when the cell carries an app identity", () => {
  const markup = render(
    computerCell("observe", { app: { appKey: "darwin:com.google.Chrome", displayName: "Chrome" } }),
  );
  const text = visibleText(markup);
  assert.match(text, /Chrome/);
  assert.match(text, /Observing/);
});

test("an appKey without a display name is not rendered as raw text", () => {
  const markup = render(computerCell("click", { app: { appKey: "darwin:com.google.Chrome" } }));
  const text = visibleText(markup);
  assert.match(text, /Clicking/);
  assert.doesNotMatch(text, /darwin:com\.google\.Chrome/);
});

test("a non-Computer js cell keeps its sanitized model title", () => {
  const cell = {
    toolId: "tool-custom",
    toolName: "mcp__node_repl__js",
    kind: "js",
    input: { code: "exportSummary()", title: "Summarise the release notes" },
    output: "done",
    status: "completed",
    raw: { result: { operation: "custom_thing" } },
  } as unknown as ChatToolCall;
  const text = visibleText(render(cell));
  assert.match(text, /Summarise the release notes/);
  assert.doesNotMatch(text, /Computer action/);
});

test("the product label is localized — a Chinese session does not show English verbs", () => {
  const text = visibleText(render(computerCell("type_text"), "zh-CN"));
  assert.match(text, /正在输入/);
  assert.doesNotMatch(text, /Typing/);
  assert.doesNotMatch(text, /查找全局电脑对象/);
});
