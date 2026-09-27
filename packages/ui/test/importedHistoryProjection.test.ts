/**
 * 导入会话的多段 assistant 正文（packages/services/specs/accounts-and-imports.md）。
 * 跨层回归：真实解析器 → 导入写入器 → 隔离 SQLite → 冷恢复合并 → V4 投影 → UI render unit；
 * 失败层是 UI 工作分段，因此必须断言 UI 可见流，而不只比较解析器输出。
 *
 * Run: TSX_TSCONFIG_PATH=packages/ui/tsconfig.json mise exec -- node --import tsx --test packages/ui/test/importedHistoryProjection.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assistantTextRowSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  parseCodexRollout,
  parseCodexRolloutPreview,
} from "../../services/src/accounts/codexHistoryImportParser.js";
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
import { buildConversationTurnRenderUnits } from "../src/v4/conversationTurnRenderUnits.js";

const texts = [
  "U1",
  "A1-visible-progress",
  "A2-visible-final",
  "U2",
  "B1-visible-progress",
  "B2-visible-final",
];
const roles = ["user", "assistant", "assistant", "user", "assistant", "assistant"] as const;
type PersistInput = Parameters<typeof persistImportedSessionHistory>[0];

for (const { source, commentaryOnly } of [
  { source: "codex", commentaryOnly: false },
  { source: "codex", commentaryOnly: true },
  { source: "claudeCode", commentaryOnly: false },
] as const) {
  test(`${source}${commentaryOnly ? " commentary-only" : ""}: normalized import → SQLite → readback → visible UI preserves ordered segments`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "import-projection-"));
    const store = createSqliteSessionStore({ dbPath: join(dir, "session.sqlite") });
    try {
      const rollout = join(dir, "fixture.jsonl");
      const base = Date.parse("2026-01-01T00:00:00Z");
      await writeFile(
        rollout,
        [
          {
            type: "session_meta",
            payload: { session_id: "fixture", cwd: dir, timestamp: new Date(base).toISOString() },
          },
          ...texts.map((text, i) => ({
            type: "response_item",
            timestamp: new Date(base + i).toISOString(),
            payload: {
              type: "message",
              role: roles[i],
              ...(roles[i] === "assistant"
                ? { phase: !commentaryOnly && (i === 2 || i === 5) ? "final_answer" : "commentary" }
                : {}),
              content: [{ type: roles[i] === "user" ? "input_text" : "output_text", text }],
            },
          })),
          {
            type: "response_item",
            payload: { type: "reasoning", summary: [{ text: "excluded reasoning fixture" }] },
          },
        ]
          .map((r) => JSON.stringify(r))
          .join("\n"),
      );
      const normalized = await parseCodexRollout(rollout);
      const preview = await parseCodexRolloutPreview(rollout);
      assert.ok(normalized);
      assert.deepEqual(
        normalized.messages.map((m) => m.content),
        texts,
      );
      const context = { deps: { sessionStore: store } } as PersistInput["context"];
      const record = {
        workspace: { workspacePath: dir, workspaceKey: dir },
        traceContext: { traceId: "fixture-trace" },
        app: { getModel: () => "", getMode: () => "build" },
      } as unknown as PersistInput["record"];
      const input = {
        context,
        record,
        sessionId: "fixture-import" as PersistInput["sessionId"],
        createParams: {
          workspacePath: dir,
          importedHistory: {
            source,
            sourceSessionId: "fixture",
            createdAt: base,
            messages: commentaryOnly
              ? normalized.messages.map((m, i) => ({
                  ...m,
                  // 缺失（1）、相等（2/3）与倒序时间戳都必须按数组顺序单调落盘。
                  timestamp: i === 1 ? undefined : i === 3 ? base - 2 : base - i,
                }))
              : normalized.messages,
          },
        },
      } as PersistInput;
      for (let pass = 0; pass < 2; pass++) {
        await persistImportedSessionHistory(input);
        const persisted = await readPersistedSessionMessages(context, input.sessionId);
        assert.equal(persisted.length, 6);
        for (let i = 1; i < persisted.length; i++)
          assert.ok(persisted[i]!.info.time.created > persisted[i - 1]!.info.time.created);
        assert.deepEqual(
          persisted.map((m) => (m.parts[0]?.type === "text" ? m.parts[0].text : null)),
          texts,
        );
        assert.equal(
          persisted[1]?.info.role === "assistant" && persisted[1].info.parentID,
          persisted[0]?.info.id,
        );
        assert.equal(
          persisted[2]?.info.role === "assistant" && persisted[2].info.parentID,
          persisted[0]?.info.id,
        );
        // 与 v4-bridge 冷恢复同一路径：持久 materialization → 三源合并 → 投影。
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
          ...(Object.prototype.hasOwnProperty.call(source, "target")
            ? { target: source.target }
            : {}),
        });
        assert.equal(merged.usedDurableTranscript, true);
        const projection = new ProductProjection(input.sessionId, "fixture-epoch");
        for (const event of merged.events) projection.applyEvent(event);
        const rows = projection.getSnapshot().rows.window;
        const assistants = rows
          .filter((r) => r.kind === "assistantText")
          .map((r) => assistantTextRowSchema.parse(r));
        assert.deepEqual(
          assistants.map((r) => r.text),
          [texts[1], texts[2], texts[4], texts[5]],
        );
        const units = buildConversationTurnRenderUnits(rows);
        const visible = units.flatMap((u) =>
          u.workSegments.flatMap((s) =>
            s.flowItems.flatMap((i) =>
              i.kind === "userInput" || i.kind === "assistantText" ? [i.row.text] : [],
            ),
          ),
        );
        assert.deepEqual(
          visible,
          texts,
          "imported text must not require expanding assistant history",
        );
        assert.deepEqual(
          preview?.previewMessages.map((m) => m.content),
          visible.slice(0, 2),
        );
        assert.equal(units.flatMap((u) => u.assistantHistoryRows).length, 0);
        // 普通运行时消息仍按原来的工作历史规则折叠，导入例外不能扩散。
        const ordinary = rows.map((r) =>
          r.kind === "assistantText" ? { ...r, importedHistory: undefined } : r,
        );
        assert.equal(
          buildConversationTurnRenderUnits(ordinary).flatMap((u) => u.assistantHistoryRows).length,
          2,
        );
      }
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
