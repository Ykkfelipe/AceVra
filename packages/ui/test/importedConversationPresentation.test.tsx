/**
 * 导入会话的两处展示缺陷（packages/ui/specs/conversation-work-status-header.md、
 * packages/services/specs/accounts-and-imports.md「Codex question-reply envelope」）。
 * 真实解析器 → 导入写入器 → 隔离 SQLite → 冷恢复合并 → V4 投影 → render unit → 真实组件渲染。
 *
 * Run: TSX_TSCONFIG_PATH=packages/ui/tsconfig.json mise exec -- node --import tsx --test packages/ui/test/importedConversationPresentation.test.tsx
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { parseCodexRollout } from "../../services/src/accounts/codexHistoryImportParser.js";
import { createSqliteSessionStore } from "../../../apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.js";
import {
  persistImportedSessionHistory,
  readPersistedSessionMessages,
} from "../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.js";
import {
  loadPersistedConversationMaterialization,
  mergeColdConversationEvents,
} from "../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/cold-event-merge.js";
import { ProductProjection } from "../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.js";

register("./uiAssetStubLoader.mjs", import.meta.url);
const { ZCodeIntlProvider } = await import("../src/i18n/IntlProvider.js");
const { TooltipProvider } = await import("../src/components/ui/tooltip.js");
const { DEFAULT_CODE_PREVIEW_SETTINGS } = await import("../src/lib/codePreviewSettings.js");
const { buildConversationTurnRenderUnits } =
  await import("../src/v4/conversationTurnRenderUnits.js");
const { isConversationWorkSegmentExpandable } =
  await import("../src/v4/conversationTurnWorkSegments.js");
const { ConversationTurnGroup } = await import("../src/v4/ConversationTurnGroup.js");
const { ConversationShareReadonlyTimeline } =
  await import("../src/v4/ConversationShareReadonlyTimeline.js");

type PersistInput = Parameters<typeof persistImportedSessionHistory>[0];

const QUESTION_REPLY = [
  "<send_user_message_question_reply>",
  JSON.stringify([
    {
      questionItemId: JSON.stringify(["request_user_input_async", "call_fixture", 0]),
      answer: "Yes, update Mall game.rbxl",
      question: "Studio is connected to Mall game.rbxl. Please confirm.",
    },
  ]),
  "</send_user_message_question_reply>",
].join("\n");

async function importedRows(): Promise<ConversationRow[]> {
  const dir = await mkdtemp(join(tmpdir(), "imported-presentation-"));
  const store = createSqliteSessionStore({ dbPath: join(dir, "session.sqlite") });
  try {
    const base = Date.parse("2026-01-01T00:00:00Z");
    const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
    const message = (
      seconds: number,
      role: "user" | "assistant",
      text: string,
      phase?: string,
    ) => ({
      type: "response_item",
      timestamp: at(seconds),
      payload: {
        type: "message",
        role,
        ...(phase ? { phase } : {}),
        content: [{ type: role === "user" ? "input_text" : "output_text", text }],
      },
    });
    const rollout = join(dir, "fixture.jsonl");
    await writeFile(
      rollout,
      [
        { type: "session_meta", payload: { session_id: "fixture", cwd: dir, timestamp: at(0) } },
        message(1, "user", "U1 plan the mall"),
        message(5, "assistant", "A1-visible-progress", "commentary"),
        {
          type: "response_item",
          payload: { type: "reasoning", summary: [{ text: "REASONING-SENTINEL-NOT-VISIBLE" }] },
        },
        message(33, "assistant", "A2-visible-final", "final_answer"),
        {
          type: "response_item",
          timestamp: at(40),
          payload: {
            type: "function_call",
            name: "request_user_input_async",
            call_id: "call_fixture",
            arguments: "{}",
          },
        },
        message(60, "user", QUESTION_REPLY),
        message(70, "assistant", "B1-single-reply", "final_answer"),
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
    const normalized = await parseCodexRollout(rollout);
    assert.ok(normalized);
    const context = { deps: { sessionStore: store } } as PersistInput["context"];
    const input = {
      context,
      record: {
        workspace: { workspacePath: dir, workspaceKey: dir },
        traceContext: { traceId: "fixture-trace" },
        app: { getModel: () => "", getMode: () => "build" },
      } as unknown as PersistInput["record"],
      sessionId: "fixture-presentation" as PersistInput["sessionId"],
      createParams: {
        workspacePath: dir,
        importedHistory: {
          source: "codex",
          sourceSessionId: "fixture",
          createdAt: base,
          messages: normalized.messages,
        },
      },
    } as PersistInput;
    await persistImportedSessionHistory(input);
    const persisted = await readPersistedSessionMessages(context, input.sessionId);
    const source = await loadPersistedConversationMaterialization({
      memoryEvents: [],
      persistedMessages: persisted,
      sessionId: input.sessionId,
      store,
    });
    const merged = mergeColdConversationEvents({
      memoryEvents: source.memoryEvents,
      messages: source.messages,
      sessionId: input.sessionId,
      goalVerificationEntries: source.goalVerificationEntries,
      ...(Object.prototype.hasOwnProperty.call(source, "target") ? { target: source.target } : {}),
    });
    const projection = new ProductProjection(input.sessionId, "fixture-epoch");
    for (const event of merged.events) projection.applyEvent(event);
    return [...projection.getSnapshot().rows.window];
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** 去掉导入来源标记，模拟同形状的普通运行时会话（A1 应按原规则折叠）。 */
function asOrdinary(rows: readonly ConversationRow[]): ConversationRow[] {
  return rows.map((row) =>
    row.kind === "assistantText" ? { ...row, importedHistory: undefined } : row,
  );
}

function renderLive(rows: readonly ConversationRow[]): string {
  const context = {
    workspacePath: "/workspace/fixture",
    theme: "dark",
    codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  } as React.ComponentProps<typeof ConversationTurnGroup>["context"];
  return renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="en-US">
      <TooltipProvider>
        {buildConversationTurnRenderUnits(rows).map((unit) => (
          <ConversationTurnGroup key={unit.key} unit={unit} context={context} />
        ))}
      </TooltipProvider>
    </ZCodeIntlProvider>,
  );
}

function renderShare(rows: readonly ConversationRow[]): string {
  return renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="en-US">
      <TooltipProvider>
        <ConversationShareReadonlyTimeline rows={rows} locale="en-US" />
      </TooltipProvider>
    </ZCodeIntlProvider>,
  );
}

const count = (markup: string, needle: string) => markup.split(needle).length - 1;

test("imported turns show a plain work duration instead of an empty expander", async () => {
  const rows = await importedRows();
  const segments = buildConversationTurnRenderUnits(rows).flatMap((unit) => unit.workSegments);
  assert.equal(segments.length, 2);
  for (const segment of segments) {
    assert.ok(segment.workStatus, "imported turn keeps its truthful duration");
    assert.equal(segment.assistantHistoryRows.length, 0);
    assert.equal(isConversationWorkSegmentExpandable(segment), false);
  }
  const live = renderLive(rows);
  assert.match(live, /Worked for 32s/u, "live timeline keeps the truthful duration label");
  assert.match(live, /Worked for 10s/u);
  for (const markup of [live, renderShare(rows)]) {
    assert.equal(count(markup, "chat-assistant-history-trigger"), 0);
    assert.equal(count(markup, "data-conversation-share-history-trigger"), 0);
    assert.doesNotMatch(
      markup,
      /REASONING-SENTINEL/u,
      "reasoning is never rendered to fill the header",
    );
    for (const text of ["A1-visible-progress", "A2-visible-final", "B1-single-reply"]) {
      assert.equal(count(markup, text), 1, `${text} renders exactly once`);
    }
  }
});

test("ordinary folded work keeps its expander; text-only turns get the plain label", async () => {
  const rows = asOrdinary(await importedRows());
  const [folded, textOnly] = buildConversationTurnRenderUnits(rows).flatMap(
    (unit) => unit.workSegments,
  );
  assert.ok(folded && textOnly);
  assert.equal(isConversationWorkSegmentExpandable(folded), true);
  assert.equal(isConversationWorkSegmentExpandable(textOnly), false);
  const live = renderLive(rows);
  assert.equal(count(live, `chat-assistant-history-trigger-${folded.key}`), 1);
  assert.equal(count(live, `chat-assistant-history-trigger-${textOnly.key}`), 0);
  assert.equal(count(renderShare(rows), "data-conversation-share-history-trigger"), 1);
});

test("Codex question-reply envelope renders only the user's answer", async () => {
  const rows = await importedRows();
  const users = rows.flatMap((row) => (row.kind === "userInput" ? [row.text] : []));
  assert.deepEqual(users, ["U1 plan the mall", "Yes, update Mall game.rbxl"]);
  for (const markup of [renderLive(rows), renderShare(rows)]) {
    assert.doesNotMatch(markup, /send_user_message_question_reply|questionItemId/u);
    assert.equal(count(markup, "Yes, update Mall game.rbxl"), 1);
  }
});
