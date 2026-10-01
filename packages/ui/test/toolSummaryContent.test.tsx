/**
 * Generic tool row summary: plain-string primary and secondary text must stay separate flex items,
 * otherwise the row's gap collapses and reads "Tool callRunning".
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

register("./uiAssetStubLoader.mjs", import.meta.url);
const { QueuedSummaryContent } = await import("../src/ToolCallBlocks/QueuedSummaryContent.js");

test("string primary and secondary text render as separate items", () => {
  const markup = renderToStaticMarkup(
    <div className="flex gap-2">
      <QueuedSummaryContent
        contentKey="k"
        primaryText="Tool call"
        secondaryText="Running"
        enabled={false}
      />
    </div>,
  );
  assert.equal(markup, '<div class="flex gap-2"><span>Tool call</span><span>Running</span></div>');
});

test("element nodes pass through unwrapped", () => {
  const markup = renderToStaticMarkup(
    <QueuedSummaryContent
      contentKey="k"
      primaryText={<b>Read</b>}
      secondaryText={null}
      enabled={false}
    />,
  );
  assert.equal(markup, "<b>Read</b>");
});
