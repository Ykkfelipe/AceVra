/**
 * ConversationRow → BackendHandoffTranscript 转换器测试。覆盖
 * packages/services/specs/backend-migration.md「What is included」「What is excluded」
 * 「Canonical history must never accumulate handoff turns」三节的每条规则。
 *
 * Run: mise exec -- node --import tsx --test packages/services/test/backendHandoffTranscript.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBackendTransitionMarkerRow,
  composeTimelineSegmentRows,
  deriveBackendTimelineLayout,
} from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { buildHandoffTranscript } from "../src/backend-migration/backendHandoffTranscript.js";

let nextRowId = 1;
function rowId(): number {
  return nextRowId++;
}

function userInput(
  text: string,
  createdAt = 1000,
): Extract<ConversationRow, { kind: "userInput" }> {
  return {
    rowId: rowId(),
    turnId: "turn-1",
    kind: "userInput",
    text,
    origin: "realUser",
    createdAt,
    createdAtSeq: createdAt,
  };
}

function assistantText(
  text: string,
  state: "complete" | "streaming" | "interrupted" | "failed" = "complete",
  createdAt = 1001,
): Extract<ConversationRow, { kind: "assistantText" }> {
  return {
    rowId: rowId(),
    turnId: "turn-1",
    kind: "assistantText",
    text,
    state,
    createdAt,
    createdAtSeq: createdAt,
  };
}

function reasoning(
  text: string,
  createdAt = 1002,
): Extract<ConversationRow, { kind: "reasoning" }> {
  return {
    rowId: rowId(),
    turnId: "turn-1",
    kind: "reasoning",
    text,
    state: "complete",
    createdAt,
    createdAtSeq: createdAt,
  };
}

function toolCall(
  toolName: string,
  status: "success" | "error" | "cancelled" | "running",
  inputText = "",
  createdAt = 1003,
): Extract<ConversationRow, { kind: "toolCall" }> {
  return {
    rowId: rowId(),
    turnId: "turn-1",
    kind: "toolCall",
    toolCallId: `tc-${createdAt}`,
    toolName,
    status,
    inputText,
    createdAt,
    createdAtSeq: createdAt,
  };
}

function artifact(
  displayName: string,
  createdAt = 1004,
): Extract<ConversationRow, { kind: "artifact" }> {
  return {
    rowId: rowId(),
    turnId: "turn-1",
    kind: "artifact",
    artifactVersionId: "v1",
    logicalArtifactKey: "key1",
    displayName,
    artifactType: "file",
    mimeType: "application/zip",
    sizeBytes: 10,
    sha256: "a".repeat(64),
    ref: "zcode-artifact://local/1",
    state: "current",
    createdAt,
    createdAtSeq: createdAt,
  };
}

function backendTransitionMarker(
  _detailRowIds: number[],
  createdAt = 1005,
): Extract<ConversationRow, { kind: "timelineMarker" }> {
  return {
    rowId: rowId(),
    turnId: "turn-handoff",
    kind: "timelineMarker",
    marker: {
      type: "backendTransition",
      status: "success",
      fromBackend: "zcode",
      toBackend: "codex",
      transcriptCompacted: false,
    },
    createdAt,
    createdAtSeq: createdAt,
  };
}

test("user and assistant text are included as canonical entries", () => {
  const transcript = buildHandoffTranscript({
    taskId: "task-1",
    sourceBackend: "zcode",
    generatedAt: 2000,
    rows: [userInput("hello"), assistantText("hi there")],
  });
  assert.deepEqual(
    transcript.entries.map((e) => [e.role, e.content]),
    [
      ["user", "hello"],
      ["assistant", "hi there"],
    ],
  );
  assert.equal(transcript.compacted, false);
});

test("reasoning rows are always excluded, even when they carry text", () => {
  const transcript = buildHandoffTranscript({
    taskId: "task-1",
    sourceBackend: "codex",
    generatedAt: 2000,
    rows: [
      userInput("do the thing"),
      reasoning("let me think step by step..."),
      assistantText("done"),
    ],
  });
  assert.deepEqual(
    transcript.entries.map((e) => e.role),
    ["user", "assistant"],
  );
});

test("a completed tool call becomes a one-line tool_summary, never the raw input/output", () => {
  const transcript = buildHandoffTranscript({
    taskId: "task-1",
    sourceBackend: "zcode",
    generatedAt: 2000,
    rows: [toolCall("Edit", "success", "a".repeat(500))],
  });
  assert.equal(transcript.entries.length, 1);
  assert.equal(transcript.entries[0]?.role, "tool_summary");
  assert.ok(transcript.entries[0]!.content.startsWith("Edit completed:"));
  assert.ok(
    transcript.entries[0]!.content.length < 500,
    "tool_summary must not carry the full raw input",
  );
});

test("a still-running tool call is not included (only terminal states are historical facts)", () => {
  const transcript = buildHandoffTranscript({
    taskId: "task-1",
    sourceBackend: "zcode",
    generatedAt: 2000,
    rows: [toolCall("Bash", "running", "sleep 100")],
  });
  assert.equal(transcript.entries.length, 0);
});

test("artifacts are carried forward as task_note entries", () => {
  const transcript = buildHandoffTranscript({
    taskId: "task-1",
    sourceBackend: "zcode",
    generatedAt: 2000,
    rows: [artifact("report.pdf")],
  });
  assert.deepEqual(transcript.entries, [
    { role: "task_note", content: "Artifact available: report.pdf (file)", timestamp: 1004 },
  ]);
});

test("a prior handoff turn's own request/reply rows never re-enter a later transcript", () => {
  // Amendment 4：排除规则从「marker.detailRowIds」换成「时间线组合器按 Codex 原生 turn id 隐藏
  // handoff 轮」——transcript 构建只消费组合后的规范时间线。
  nextRowId = 1;
  const priorUser = userInput("continue the refactor", 1000);
  const handoffRequest = {
    ...assistantText("SYSTEM: context transfer...", "complete", 1001),
    sourceTurnId: "ct-handoff",
  };
  const handoffReply = {
    ...assistantText("ACEVRA_HANDOFF_READY", "complete", 1002),
    sourceTurnId: "ct-handoff",
  };
  const postHandoffReply = {
    ...assistantText("Sure, continuing now", "complete", 1004),
    sourceTurnId: "ct-next",
  };
  const layout = deriveBackendTimelineLayout({
    taskId: "task-1",
    executionBackend: "codex",
    codexThreadId: "thread-1",
    backendTransitions: [
      {
        startedAt: 1,
        committedAt: 2,
        from: "zcode",
        to: "codex",
        status: "committed",
        transcriptCompacted: false,
        sourceLastRowId: priorUser.rowId,
        destinationExecutionRef: "thread-1",
        handoffTurnId: "ct-handoff",
      },
    ],
  });
  const composed = [
    ...composeTimelineSegmentRows(layout, 0, [priorUser]),
    buildBackendTransitionMarkerRow(layout, 1)!,
    ...composeTimelineSegmentRows(layout, 1, [handoffRequest, handoffReply, postHandoffReply]),
  ];

  const transcript = buildHandoffTranscript({
    taskId: "task-1",
    sourceBackend: "codex",
    generatedAt: 2000,
    rows: composed,
  });

  assert.deepEqual(
    transcript.entries.map((e) => e.content),
    ["continue the refactor", "Sure, continuing now"],
  );
});

test("the backendTransition marker row itself is never a transcript entry", () => {
  const marker = backendTransitionMarker([]);
  const transcript = buildHandoffTranscript({
    taskId: "task-1",
    sourceBackend: "codex",
    generatedAt: 2000,
    rows: [marker],
  });
  assert.equal(transcript.entries.length, 0);
});

test("structural rows (turnHeader/hookInvocation/other timeline markers) are excluded", () => {
  const transcript = buildHandoffTranscript({
    taskId: "task-1",
    sourceBackend: "zcode",
    generatedAt: 2000,
    rows: [
      {
        rowId: rowId(),
        turnId: "turn-1",
        kind: "turnHeader",
        origin: "realUser",
        state: "completedSuccess",
        startedAt: 1000,
        createdAt: 1000,
        createdAtSeq: 1000,
      },
      {
        rowId: rowId(),
        turnId: "turn-1",
        kind: "timelineMarker",
        marker: {
          type: "modelChange",
          toProvider: "azure-openai",
          toModel: "gpt-6-luna",
          toThought: "",
        },
        createdAt: 1001,
        createdAtSeq: 1001,
      },
      userInput("hi", 1002),
    ],
  });
  assert.deepEqual(
    transcript.entries.map((e) => e.role),
    ["user"],
  );
});
