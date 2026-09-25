/**
 * Run: mise exec -- node --import tsx --test packages/services/test/codexHandoffTurn.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { BACKEND_HANDOFF_READY_MARKER, type BackendHandoffTranscript } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  buildCodexHandoffPrompt,
  detectUnexpectedToolActivityInHandoffTurn,
  isCodexHandoffAcknowledged,
  parseCodexHandoffReply,
} from "../src/backend-migration/codexHandoffTurn.js";

const TRANSCRIPT: BackendHandoffTranscript = {
  taskId: "task-1",
  generatedAt: 1000,
  sourceBackend: "zcode",
  compacted: false,
  entries: [
    { role: "user", content: "please refactor the auth module" },
    { role: "assistant", content: "started refactoring auth.ts" },
    { role: "tool_summary", content: "Edit completed: auth.ts" },
  ],
};

test("the handoff prompt is explicit about all four constraints and asks for the ready marker", () => {
  const prompt = buildCodexHandoffPrompt(TRANSCRIPT);
  assert.match(prompt, /CONTEXT-TRANSFER/);
  assert.match(prompt, /Do NOT:/);
  assert.match(prompt, /modify any files/);
  assert.match(prompt, /run any tool or command/i);
  assert.match(prompt, /summarize or repeat/i);
  assert.ok(prompt.includes(BACKEND_HANDOFF_READY_MARKER));
});

test("the handoff prompt carries the actual transcript content, not a placeholder", () => {
  const prompt = buildCodexHandoffPrompt(TRANSCRIPT);
  assert.ok(prompt.includes("please refactor the auth module"));
  assert.ok(prompt.includes("started refactoring auth.ts"));
  assert.ok(prompt.includes("Edit completed: auth.ts"));
});

test("a normal terminal state is acknowledged even without the exact marker string", () => {
  // spec: 正常终态 + 无标记 = 仍然接受，模型换了措辞不能让一次正常 handoff 判失败。
  const parsed = parseCodexHandoffReply("Sure thing, I'm ready to continue.");
  assert.equal(parsed.hasReadyMarker, false);
  assert.equal(
    isCodexHandoffAcknowledged({
      reachedNormalTerminalState: true,
      hasReadyMarker: parsed.hasReadyMarker,
    }),
    true,
  );
});

test("the marker is detected when present, purely as a confidence signal", () => {
  const parsed = parseCodexHandoffReply(`Got it. ${BACKEND_HANDOFF_READY_MARKER}`);
  assert.equal(parsed.hasReadyMarker, true);
});

test("a turn that errored or timed out is never acknowledged, marker or not", () => {
  assert.equal(
    isCodexHandoffAcknowledged({ reachedNormalTerminalState: false, hasReadyMarker: true }),
    false,
  );
});

function toolCallRow(
  status: "success" | "running",
): Extract<ConversationRow, { kind: "toolCall" }> {
  return {
    rowId: 1,
    turnId: "handoff-turn",
    kind: "toolCall",
    toolCallId: "tc-1",
    toolName: "Edit",
    status,
    inputText: "some file",
    createdAt: 1000,
    createdAtSeq: 1000,
  };
}

test("any tool call during the handoff turn is unexpected activity, regardless of its status", () => {
  assert.equal(detectUnexpectedToolActivityInHandoffTurn([toolCallRow("success")]), true);
  assert.equal(detectUnexpectedToolActivityInHandoffTurn([toolCallRow("running")]), true);
});

test("a handoff turn with only text rows has no unexpected tool activity", () => {
  const textRow: Extract<ConversationRow, { kind: "assistantText" }> = {
    rowId: 1,
    turnId: "handoff-turn",
    kind: "assistantText",
    text: `Ready. ${BACKEND_HANDOFF_READY_MARKER}`,
    state: "complete",
    createdAt: 1000,
    createdAtSeq: 1000,
  };
  assert.equal(detectUnexpectedToolActivityInHandoffTurn([textRow]), false);
});
