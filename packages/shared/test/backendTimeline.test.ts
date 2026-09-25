/**
 * 跨后端可见时间线组合器（backend-migration.md Amendment 4）。在接真实 Codex 之前，
 * 用确定性的假读取器验证场景 A–J：顺序、每条真实消息只出现一次、marker 位置、
 * handoff 轮与种子行隐藏、目标端新消息可见、task id 不变。
 *
 * Run: mise exec -- node --import tsx --test packages/shared/test/backendTimeline.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { BackendTransitionRecord } from "../src/backend-migration.js";
import {
  BACKEND_TIMELINE_SEGMENT_STRIDE,
  composeTimelineLogEpoch,
  composedTimelineRowId,
  decodeComposedTimelineRowId,
  decomposeTimelineLogEpoch,
  deriveBackendTimelineLayout,
  readComposedTimelineRowsBefore,
  readFullComposedTimeline,
  type BackendTimelineLayout,
  type BackendTimelineSegmentReader,
} from "../src/index.js";
import type { ConversationRow } from "../src/zcode-protocol-v4/rows.js";

const TASK = "task-timeline";

function user(rowId: number, text: string, sourceTurnId?: string): ConversationRow {
  return {
    rowId,
    turnId: `t${rowId}`,
    kind: "userInput",
    text,
    origin: "realUser",
    createdAt: rowId,
    createdAtSeq: rowId,
    actions: { canEdit: true },
    ...(sourceTurnId ? { sourceTurnId } : {}),
  } as ConversationRow;
}

function assistant(rowId: number, text: string, sourceTurnId?: string): ConversationRow {
  return {
    rowId,
    turnId: `t${rowId}`,
    kind: "assistantText",
    text,
    state: "complete",
    createdAt: rowId,
    createdAtSeq: rowId,
    ...(sourceTurnId ? { sourceTurnId } : {}),
  } as ConversationRow;
}

/** 假世界：一个 zcode 会话（rowId 稳定）+ 若干 Codex thread（每次读取可按「重启代数」重排 rowId）。 */
function createWorld() {
  const zcodeRows: ConversationRow[] = [];
  const codexThreads = new Map<
    string,
    { text: string; kind: "user" | "assistant"; turn: string }[]
  >();
  let codexGeneration = 0;
  const reads: string[] = [];

  const codexRows = (threadId: string): ConversationRow[] => {
    const items = codexThreads.get(threadId) ?? [];
    // 冷恢复重建：rowId 从 1 起（代数不同则整体偏移，模拟重启后 rowId 与之前不同）。
    const base = 1 + codexGeneration * 7;
    return items.map((item, i) =>
      item.kind === "user"
        ? user(base + i, item.text, item.turn)
        : assistant(base + i, item.text, item.turn),
    );
  };

  const reader: BackendTimelineSegmentReader = {
    async readBefore({ segment, beforeSourceRowId, limit }) {
      if (segment.source.kind === "codex") {
        reads.push(`codex:${segment.source.threadId}`);
        return { rows: codexRows(segment.source.threadId), hasMore: false };
      }
      reads.push(`zcode:${beforeSourceRowId ?? "tail"}`);
      const eligible = zcodeRows.filter(
        (row) => beforeSourceRowId === undefined || row.rowId < beforeSourceRowId,
      );
      const page = eligible.slice(Math.max(0, eligible.length - limit));
      return { rows: page, hasMore: eligible.length > page.length };
    },
  };

  return {
    zcodeRows,
    codexThreads,
    reader,
    reads,
    restartCodex: () => (codexGeneration += 1),
    nextZRowId: () => (zcodeRows.at(-1)?.rowId ?? 0) + 1,
  };
}

function record(overrides: Partial<BackendTransitionRecord>): BackendTransitionRecord {
  return {
    startedAt: 100,
    committedAt: 101,
    from: "zcode",
    to: "codex",
    status: "committed",
    transcriptCompacted: false,
    ...overrides,
  };
}

function texts(rows: readonly ConversationRow[]): string[] {
  return rows.map((row) => {
    if (row.kind === "userInput") return `U:${row.text}`;
    if (row.kind === "assistantText") return `A:${row.text}`;
    if (row.kind === "timelineMarker" && row.marker.type === "backendTransition") {
      return `[${row.marker.fromBackend}->${row.marker.toBackend}]`;
    }
    return row.kind;
  });
}

function assertStrictlyAscendingUnique(rows: readonly ConversationRow[]): void {
  const ids = rows.map((row) => row.rowId);
  assert.equal(new Set(ids).size, ids.length, "each composed row appears once");
  for (let i = 1; i < ids.length; i += 1) assert.ok(ids[i - 1]! < ids[i]!, "rowId ascending");
}

async function full(layout: BackendTimelineLayout, reader: BackendTimelineSegmentReader) {
  const rows = await readFullComposedTimeline({ layout, reader, pageLimit: 3 });
  assertStrictlyAscendingUnique(rows);
  return rows;
}

// ---- 场景构建：Agent(zai) → Codex → Agent(azure) → Codex ----
function agentThenCodex() {
  const w = createWorld();
  w.zcodeRows.push(user(1, "codename ORANGE-RAVEN-41"), assistant(2, "noted zai"));
  w.zcodeRows.push(user(3, "port 43127"), assistant(4, "noted cc"));
  w.codexThreads.set("thread-1", [
    { kind: "user", text: "HANDOFF PROMPT 1", turn: "ct-1" },
    { kind: "assistant", text: "ACEVRA_HANDOFF_READY", turn: "ct-1" },
    { kind: "user", text: "use both facts", turn: "ct-2" },
    { kind: "assistant", text: "codex answer", turn: "ct-2" },
  ]);
  const r1 = record({
    from: "zcode",
    to: "codex",
    fromProviderId: "command-code",
    sourceFirstRowId: 1,
    sourceLastRowId: 4,
    destinationExecutionRef: "thread-1",
    handoffTurnId: "ct-1",
  });
  return { w, r1 };
}

function agentCodexAgent() {
  const { w, r1 } = agentThenCodex();
  // 种子行：Codex 段的归一化副本写进同一个 zcode 会话（上下文输入，不是可见副本）。
  w.zcodeRows.push(
    user(5, "codename ORANGE-RAVEN-41"),
    assistant(6, "noted zai"),
    user(7, "use both facts"),
    assistant(8, "codex answer"),
  );
  const r2 = record({
    startedAt: 200,
    committedAt: 201,
    from: "codex",
    to: "zcode",
    toProviderId: "azure-openai",
    sourceExecutionRef: "thread-1",
    destinationSeedLastRowId: 8,
  });
  // 迁移后真实的新活动：用户下一条消息、Azure 首个回复。
  w.zcodeRows.push(user(9, "token MAPLE-73"), assistant(10, "azure first reply"));
  return { w, r1, r2 };
}

test("A. Agent only: layout is a single live segment and composition is the identity", async () => {
  const w = createWorld();
  w.zcodeRows.push(user(1, "hi"), assistant(2, "hello"));
  const layout = deriveBackendTimelineLayout({ taskId: TASK });
  assert.equal(layout.layoutVersion, 0);
  assert.equal(layout.segments.length, 1);
  assert.equal(
    composeTimelineLogEpoch(layout, "epoch-1"),
    "epoch-1",
    "no epoch change for unmigrated tasks",
  );
  const rows = await full(layout, w.reader);
  assert.deepEqual(rows, w.zcodeRows, "rows pass through untouched, actions preserved");
});

test("B. Agent → Codex: Agent segment, one marker, visible Codex turns, handoff hidden", async () => {
  const { w, r1 } = agentThenCodex();
  const layout = deriveBackendTimelineLayout({
    taskId: TASK,
    executionBackend: "codex",
    codexThreadId: "thread-1",
    backendTransitions: [r1],
  });
  const rows = await full(layout, w.reader);
  assert.deepEqual(texts(rows), [
    "U:codename ORANGE-RAVEN-41",
    "A:noted zai",
    "U:port 43127",
    "A:noted cc",
    "[zcode->codex]",
    "U:use both facts",
    "A:codex answer",
  ]);
  assert.ok(
    rows.slice(0, 4).every((row) => row.rowId < 0 && row.actions === undefined),
    "history is read-only",
  );
  assert.ok(
    rows.slice(5).every((row) => row.rowId > 0),
    "live Codex ids unchanged",
  );
  const marker = rows[4]!;
  assert.equal(marker.kind, "timelineMarker");
  if (marker.kind === "timelineMarker" && marker.marker.type === "backendTransition") {
    assert.equal(marker.marker.transitionIndex, 0);
    assert.equal(marker.marker.fromProviderId, "command-code");
    assert.equal(JSON.stringify(marker).includes("thread-1"), false, "no thread id in the marker");
    assert.equal(JSON.stringify(marker).includes("ct-1"), false, "no turn id in the marker");
  }
});

test("C. Agent → Codex → Agent: seeded replicas hidden, new Agent activity visible", async () => {
  const { w, r1, r2 } = agentCodexAgent();
  const layout = deriveBackendTimelineLayout({
    taskId: TASK,
    executionBackend: "zcode",
    backendTransitions: [r1, r2],
  });
  const rows = await full(layout, w.reader);
  assert.deepEqual(texts(rows), [
    "U:codename ORANGE-RAVEN-41",
    "A:noted zai",
    "U:port 43127",
    "A:noted cc",
    "[zcode->codex]",
    "U:use both facts",
    "A:codex answer",
    "[codex->zcode]",
    "U:token MAPLE-73",
    "A:azure first reply",
  ]);
  // I. 种子副本只作为上下文存在：每条真实消息在时间线里恰好出现一次。
  assert.equal(texts(rows).filter((t) => t === "U:use both facts").length, 1);
  assert.equal(texts(rows).filter((t) => t === "U:codename ORANGE-RAVEN-41").length, 1);
  // 8. 新 Agent 段严格从种子边界之后开始：真实新消息保持原生 id 与 actions。
  const newest = rows.at(-2)!;
  assert.equal(newest.rowId, 9);
  assert.deepEqual(newest.actions, { canEdit: true });
});

test("D. Agent → Codex → Agent → Codex: two Codex threads, each handoff hidden, three markers", async () => {
  const { w, r1, r2 } = agentCodexAgent();
  w.codexThreads.set("thread-2", [
    { kind: "user", text: "HANDOFF PROMPT 2", turn: "ct-3" },
    { kind: "assistant", text: "ACEVRA_HANDOFF_READY", turn: "ct-3" },
    { kind: "user", text: "list all three facts", turn: "ct-4" },
    { kind: "assistant", text: "ORANGE-RAVEN-41 43127 MAPLE-73", turn: "ct-4" },
  ]);
  const r3 = record({
    startedAt: 300,
    committedAt: 301,
    from: "zcode",
    to: "codex",
    fromProviderId: "azure-openai",
    sourceFirstRowId: 9,
    sourceLastRowId: 10,
    destinationExecutionRef: "thread-2",
    handoffTurnId: "ct-3",
  });
  const layout = deriveBackendTimelineLayout({
    taskId: TASK,
    executionBackend: "codex",
    codexThreadId: "thread-2",
    backendTransitions: [r1, r2, r3],
  });
  assert.equal(layout.segments.length, 4);
  const rows = await full(layout, w.reader);
  assert.deepEqual(texts(rows), [
    "U:codename ORANGE-RAVEN-41",
    "A:noted zai",
    "U:port 43127",
    "A:noted cc",
    "[zcode->codex]",
    "U:use both facts",
    "A:codex answer",
    "[codex->zcode]",
    "U:token MAPLE-73",
    "A:azure first reply",
    "[zcode->codex]",
    "U:list all three facts",
    "A:ORANGE-RAVEN-41 43127 MAPLE-73",
  ]);
  assert.ok(!texts(rows).some((t) => t.includes("HANDOFF PROMPT")), "no handoff prompt is visible");
  assert.ok(
    !texts(rows).some((t) => t.includes("ACEVRA_HANDOFF_READY")),
    "no handoff ack is visible",
  );
});

test("E. failed migration before commit: no segment, no marker, failed thread never read", async () => {
  const w = createWorld();
  w.zcodeRows.push(user(1, "hi"), assistant(2, "hello"));
  w.codexThreads.set("thread-failed", [{ kind: "user", text: "HANDOFF PROMPT", turn: "ct-x" }]);
  const layout = deriveBackendTimelineLayout({
    taskId: TASK,
    executionBackend: "zcode",
    backendTransitions: [
      record({
        status: "failed",
        failureReason: "handoff_turn_error",
        committedAt: undefined,
        failedAt: 101,
        destinationExecutionRef: "thread-failed",
      }),
    ],
  });
  assert.equal(layout.layoutVersion, 0);
  const rows = await full(layout, w.reader);
  assert.deepEqual(texts(rows), ["U:hi", "A:hello"]);
  assert.ok(
    !w.reads.some((r) => r.includes("thread-failed")),
    "failed destination is never a read source",
  );
});

test("F/H. restart after committed Agent → Codex: same visible timeline although Codex row ids changed", async () => {
  const { w, r1 } = agentThenCodex();
  const layout = deriveBackendTimelineLayout({
    taskId: TASK,
    executionBackend: "codex",
    codexThreadId: "thread-1",
    backendTransitions: [r1],
  });
  const before = await full(layout, w.reader);
  w.restartCodex(); // 冷恢复：Codex 行 rowId 全部变化
  const after = await full(layout, w.reader);
  assert.notDeepEqual(
    before.filter((r) => r.rowId > 0).map((r) => r.rowId),
    after.filter((r) => r.rowId > 0).map((r) => r.rowId),
    "precondition: rebuilt Codex rows have different ids",
  );
  assert.deepEqual(texts(after), texts(before));
  assert.equal(texts(after).indexOf("[zcode->codex]"), 4, "marker stays in the same logical place");
});

test("G. restart after committed Codex → Agent: composition is identical", async () => {
  const { w, r1, r2 } = agentCodexAgent();
  const layout = deriveBackendTimelineLayout({
    taskId: TASK,
    executionBackend: "zcode",
    backendTransitions: [r1, r2],
  });
  const before = await full(layout, w.reader);
  w.restartCodex(); // 历史 Codex 段在重启后按新 rowId 重建
  const after = await full(layout, w.reader);
  assert.deepEqual(texts(after), texts(before));
  // zcode 段（含 live）rowId 稳定；历史 Codex 段 id 可以不同，但顺序与内容一致。
  assert.deepEqual(
    after.filter((r) => r.rowId > 0).map((r) => r.rowId),
    before.filter((r) => r.rowId > 0).map((r) => r.rowId),
  );
});

test("J. paging across segments with tiny windows never renders a source row twice", async () => {
  const { w, r1, r2 } = agentCodexAgent();
  const layout = deriveBackendTimelineLayout({
    taskId: TASK,
    executionBackend: "zcode",
    backendTransitions: [r1, r2],
  });
  const reference = await readFullComposedTimeline({ layout, reader: w.reader, pageLimit: 200 });
  for (const limit of [1, 2, 3, 5]) {
    const paged = await readFullComposedTimeline({ layout, reader: w.reader, pageLimit: limit });
    assert.deepEqual(paged, reference, `limit ${limit}`);
  }
  // 首屏：只读 live 尾部 + 有界前缀，不整段加载所有历史。
  const firstScreen = await readComposedTimelineRowsBefore({ layout, reader: w.reader, limit: 2 });
  assert.deepEqual(texts(firstScreen.rows), ["U:token MAPLE-73", "A:azure first reply"]);
  assert.equal(firstScreen.hasMore, true);
});

test("composed ids round-trip and stay ordered across segments and markers", () => {
  const layout = deriveBackendTimelineLayout({
    taskId: TASK,
    executionBackend: "zcode",
    backendTransitions: [
      record({ sourceLastRowId: 4, destinationExecutionRef: "thread-1", handoffTurnId: "ct-1" }),
      record({
        from: "codex",
        to: "zcode",
        sourceExecutionRef: "thread-1",
        destinationSeedLastRowId: 8,
      }),
    ],
  });
  for (const [segment, sourceRowId] of [
    [0, 0],
    [0, 4],
    [1, 1],
    [1, BACKEND_TIMELINE_SEGMENT_STRIDE - 3],
  ] as const) {
    const id = composedTimelineRowId(layout, segment, sourceRowId);
    assert.deepEqual(decodeComposedTimelineRowId(layout, id), {
      kind: "row",
      segmentIndex: segment,
      sourceRowId,
    });
  }
  assert.deepEqual(decodeComposedTimelineRowId(layout, -1), { kind: "marker", segmentIndex: 2 });
  assert.deepEqual(decodeComposedTimelineRowId(layout, 7), {
    kind: "row",
    segmentIndex: 2,
    sourceRowId: 7,
  });
  assert.equal(decomposeTimelineLogEpoch(layout, composeTimelineLogEpoch(layout, "e")), "e");
  assert.equal(decomposeTimelineLogEpoch(layout, "e::bt1"), null, "stale layout epoch is rejected");
});
