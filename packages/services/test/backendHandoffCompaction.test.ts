/**
 * Run: mise exec -- node --import tsx --test packages/services/test/backendHandoffCompaction.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { BackendHandoffEntry, BackendHandoffTranscript } from "@zcode/shared";
import {
  compactHandoffTranscriptIfNeeded,
  estimateHandoffTranscriptTokens,
  handoffTranscriptFitsBudget,
} from "../src/backend-migration/backendHandoffCompaction.js";

function makeTranscript(entries: BackendHandoffEntry[]): BackendHandoffTranscript {
  return { taskId: "task-1", generatedAt: 1000, sourceBackend: "zcode", entries, compacted: false };
}

test("a short transcript fits a normal-sized budget and needs no compaction", async () => {
  const transcript = makeTranscript([
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ]);
  let summarizeCalled = false;
  const result = await compactHandoffTranscriptIfNeeded({
    transcript,
    budget: { contextWindowTokens: 100_000 },
    summarizePrefix: async () => {
      summarizeCalled = true;
      return "should not be called";
    },
    now: () => 2000,
  });
  assert.equal(
    result,
    transcript,
    "an already-fitting transcript is returned unchanged, same reference",
  );
  assert.equal(summarizeCalled, false);
});

test("handoffTranscriptFitsBudget respects the output reserve and buffer, not just the raw window", () => {
  const bigEntry: BackendHandoffEntry = { role: "user", content: "x".repeat(300) };
  // contextWindow=100, reserve=50, buffer=10 -> threshold=40 tokens; 300 chars / 3 = 100 tokens, does not fit.
  assert.equal(
    handoffTranscriptFitsBudget([bigEntry], {
      contextWindowTokens: 100,
      outputReserveTokens: 50,
      bufferTokens: 10,
    }),
    false,
  );
});

test("an oversized transcript is compacted: prefix summarized, recent tail kept verbatim", async () => {
  const entries: BackendHandoffEntry[] = [];
  for (let i = 0; i < 50; i += 1) {
    entries.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `entry number ${i} `.repeat(50),
    });
  }
  const transcript = makeTranscript(entries);
  const summarizedPrefixes: readonly BackendHandoffEntry[][] = [];
  const result = await compactHandoffTranscriptIfNeeded({
    transcript,
    budget: { contextWindowTokens: 2_000, outputReserveTokens: 200, bufferTokens: 100 },
    summarizePrefix: async (prefix) => {
      summarizedPrefixes.push(prefix);
      return "the user asked for a refactor and it is halfway done";
    },
    now: () => 5000,
  });

  assert.equal(result.compacted, true);
  assert.equal(summarizedPrefixes.length, 1);
  assert.ok(summarizedPrefixes[0]!.length > 0, "some entries were sent to summarization");
  // 摘要条目在最前面，角色是 task_note，带上时间戳。
  assert.equal(result.entries[0]?.role, "task_note");
  assert.equal(result.entries[0]?.timestamp, 5000);
  assert.ok(result.entries[0]!.content.includes("the user asked for a refactor"));
  // 尾部原文保持不变——摘要条目之后的内容必须是原始 entries 数组的一段连续后缀。
  const tail = result.entries.slice(1);
  const originalTail = entries.slice(entries.length - tail.length);
  assert.deepEqual(tail, originalTail);
  // 整个压缩后的结果本身应当能塞进预算——否则压缩没有达到目的。
  assert.ok(
    estimateHandoffTranscriptTokens(result.entries) <= estimateHandoffTranscriptTokens(entries),
  );
});

test("compaction never silently drops everything when even the recent tail alone does not fit", async () => {
  // 单条 entry 本身就超预算：没有「更旧的部分」可以摘要，splitForCompaction 会把它整个
  // 划进 tail，prefix 为空——这时必须原样返回，不能假装压缩成功却丢了内容。
  const hugeEntry: BackendHandoffEntry = { role: "user", content: "x".repeat(100_000) };
  const transcript = makeTranscript([hugeEntry]);
  const result = await compactHandoffTranscriptIfNeeded({
    transcript,
    budget: { contextWindowTokens: 100, outputReserveTokens: 10, bufferTokens: 5 },
    summarizePrefix: async () => {
      throw new Error("must not be called when there is nothing to summarize");
    },
    now: () => 9000,
  });
  assert.deepEqual(result.entries, [hugeEntry]);
  assert.equal(result.compacted, false);
});

test("a failing summarization call propagates — the orchestrator, not this function, decides that's a migration failure", async () => {
  const entries: BackendHandoffEntry[] = Array.from({ length: 30 }, (_, i) => ({
    role: "user" as const,
    content: `line ${i} `.repeat(50),
  }));
  const transcript = makeTranscript(entries);
  await assert.rejects(
    () =>
      compactHandoffTranscriptIfNeeded({
        transcript,
        budget: { contextWindowTokens: 1_000, outputReserveTokens: 100, bufferTokens: 50 },
        summarizePrefix: async () => {
          throw new Error("model call failed");
        },
        now: () => 1000,
      }),
    /model call failed/,
  );
});
