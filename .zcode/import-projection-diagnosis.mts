import { DatabaseSync } from "node:sqlite";
import { messages } from "../apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/messages.ts";
import { synthesizeEventsFromMessages } from "../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts";
import { ProductProjection } from "../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts";
import { buildConversationTurnRenderUnits } from "../packages/ui/src/v4/conversationTurnRenderUnits.ts";
import {
  parseCodexRollout,
  parseCodexRolloutPreview,
} from "../packages/services/src/accounts/codexHistoryImportParser.ts";
const id = "codex-import-69923089c67d260b05d012c3";
const db = new DatabaseSync("/Users/felipemore/.zcode/cli/db/db.sqlite", { readOnly: true });
const all = await messages(db, { sessionID: id });
let turn = 0;
const first = all.filter((m) => {
  if (m.info.role === "user") turn++;
  return turn <= 2;
});
const path =
  "/Users/felipemore/.codex/sessions/2026/09/10/rollout-2026-09-10T21-55-44-01a08e2d-8c13-7460-bd5c-eaf72fda406a.jsonl";
const parsed = await parseCodexRollout(path);
const preview = await parseCodexRolloutPreview(path);
console.log(
  "NORMALIZED",
  parsed?.messages.slice(0, 7).map((m, index) => ({
    index,
    role: m.role,
    timestamp: m.timestamp,
    excerpt: m.content.slice(0, 75),
    equalPersistence: m.content === first[index]?.parts[0]?.text,
  })),
);
console.log("PREVIEW", preview?.previewMessages);
const projection = new ProductProjection(id, "diagnosis");
for (const e of synthesizeEventsFromMessages(first, { sessionId: id })) projection.applyEvent(e);
const rows = projection.getSnapshot().rows.window;
console.log(
  "V4",
  rows.map((r) => ({ kind: r.kind, rowId: r.rowId, text: r.text?.slice(0, 75) })),
);
console.log(
  "UI",
  buildConversationTurnRenderUnits(rows).map((u) => ({
    turn: u.turnId,
    segments: u.workSegments.map((s) => ({
      open: s.assistantHistoryDefaultOpen,
      items: s.flowItems.map((i) => ({
        kind: i.kind,
        text: i.row?.text?.slice(0, 75),
        history: i.rows?.map((r) => r.text?.slice(0, 75)),
      })),
    })),
  })),
);
db.close();
