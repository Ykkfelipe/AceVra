import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { conversationRowSchema, type ConversationRow } from "@zcode/shared/zcode-protocol-v4";

register("./uiAssetStubLoader.mjs", import.meta.url);
const { ZCodeIntlProvider } = await import("../src/i18n/IntlProvider.js");
const { TooltipProvider } = await import("../src/components/ui/tooltip.js");
const { DEFAULT_CODE_PREVIEW_SETTINGS } = await import("../src/lib/codePreviewSettings.js");
const { buildConversationTurnRenderUnits } =
  await import("../src/v4/conversationTurnRenderUnits.js");
const { ConversationTurnGroup } = await import("../src/v4/ConversationTurnGroup.js");
const { ConversationShareReadonlyTimeline } =
  await import("../src/v4/ConversationShareReadonlyTimeline.js");
const { ConversationComputerImages } = await import("../src/v4/ConversationComputerImages.js");
const { NodeReplToolCallBlock } = await import("../src/ToolCallBlocks/renderers/node-repl.js");
const { toolCallRowToLegacyNode } = await import("../src/v4/toolCallRowAdapter.js");

const image = { base64: "aW1hZ2U=", mimeType: "image/png" };
const rows = [
  {
    kind: "toolCall",
    rowId: 1,
    turnId: "turn",
    createdAt: 1,
    createdAtSeq: 1,
    toolCallId: "shot",
    toolName: "mcp__node_repl__js",
    status: "success",
    inputText: "{}",
    display: { kind: "node_repl_images", cuaOperation: "observe", images: [image] },
  },
  {
    kind: "assistantText",
    rowId: 2,
    turnId: "turn",
    createdAt: 2,
    createdAtSeq: 2,
    text: "Here is your screenshot.",
    state: "complete",
  },
].map((row) => conversationRowSchema.parse(row));

function render(children: React.ReactNode) {
  return renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="en-US">
      <TooltipProvider>{children}</TooltipProvider>
    </ZCodeIntlProvider>,
  );
}

test("completed screenshot remains visible with history collapsed, including cold snapshot", () => {
  const snapshot = JSON.parse(JSON.stringify(rows)).map((row: unknown) =>
    conversationRowSchema.parse(row),
  );
  const unit = buildConversationTurnRenderUnits(snapshot)[0]!;
  assert.equal(unit.assistantHistoryDefaultOpen, false);
  const context = {
    workspacePath: "/workspace",
    theme: "dark",
    codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  } as React.ComponentProps<typeof ConversationTurnGroup>["context"];
  const html = render(<ConversationTurnGroup unit={unit} context={context} />);
  assert.match(html, /data-computer-screenshot-result/);
  assert.equal((html.match(/src="data:image\/png;base64,aW1hZ2U=/g) ?? []).length, 1);
  assert.ok(
    html.indexOf("Here is your screenshot.") < html.indexOf("data-computer-screenshot-result"),
  );
});

test("readonly share shows delivered Computer image outside its history disclosure", () => {
  const html = render(<ConversationShareReadonlyTimeline rows={rows} locale="en-US" />);
  assert.match(html, /data-computer-screenshot-result/);
  assert.equal((html.match(/src="data:image\/png;base64,aW1hZ2U=/g) ?? []).length, 1);
});

test("reference-only observations and prose claims do not produce a screenshot", () => {
  const referenceOnly = rows.map((row) =>
    row.kind === "toolCall"
      ? { ...row, display: { kind: "node_repl_images" as const, cuaOperation: "observe" } }
      : row,
  );
  assert.doesNotMatch(render(<ConversationComputerImages rows={referenceOnly} />), /<img/);
});

test("opening Computer execution details does not duplicate the visible screenshot", () => {
  const row = rows[0]!;
  assert.equal(row.kind, "toolCall");
  if (row.kind !== "toolCall") return;
  const html = render(
    <NodeReplToolCallBlock
      toolCallNode={toolCallRowToLegacyNode(row)}
      isRunning={false}
      childToolList={null}
      forceOpen
    />,
  );
  assert.doesNotMatch(html, /src="data:image/);
});

test("automatic Browser turn-end images keep their existing renderer", () => {
  const browserRows = rows.map((row) =>
    row.kind === "toolCall"
      ? {
          ...row,
          display: {
            kind: "node_repl_images" as const,
            source: "browser_turn_end" as const,
            images: [image],
          },
        }
      : row,
  );
  assert.doesNotMatch(
    render(<ConversationComputerImages rows={browserRows as ConversationRow[]} />),
    /<img/,
  );
});

test("CUA-1.6: observation screenshots never reach the conversation flow, only the details dropdown", () => {
  const observationRows = rows.map((row) =>
    row.kind === "toolCall"
      ? {
          ...row,
          display: {
            kind: "node_repl_images" as const,
            cuaOperation: "screenshot" as const,
            observationImages: [image],
          },
        }
      : row,
  );
  const parsed = observationRows.map((row) => conversationRowSchema.parse(row));
  // 响应后的可见画廊与 share 视图都不渲染观察帧。
  assert.doesNotMatch(render(<ConversationComputerImages rows={parsed} />), /<img/);
  assert.doesNotMatch(
    render(<ConversationShareReadonlyTimeline rows={parsed} locale="en-US" />),
    /data-computer-screenshot-result/,
  );
  // 详情折叠区出现缩略图。
  const row = parsed[0]!;
  if (row.kind !== "toolCall") return;
  const html = render(
    <NodeReplToolCallBlock
      toolCallNode={toolCallRowToLegacyNode(row)}
      isRunning={false}
      childToolList={null}
      forceOpen
    />,
  );
  assert.match(html, /node-repl-observation-images/);
  assert.match(html, /src="data:image\/png;base64,aW1hZ2U=/);
});
