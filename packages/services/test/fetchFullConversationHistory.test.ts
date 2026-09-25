/**
 * Run: mise exec -- node --import tsx --test packages/services/test/fetchFullConversationHistory.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  ConversationHistoryPagingLimitExceededError,
  fetchFullConversationHistory,
} from "../src/backend-migration/fetchFullConversationHistory.js";

function userRow(rowId: number): Extract<ConversationRow, { kind: "userInput" }> {
  return {
    rowId,
    turnId: `turn-${rowId}`,
    kind: "userInput",
    text: `message ${rowId}`,
    origin: "realUser",
    createdAt: rowId,
    createdAtSeq: rowId,
  };
}

test("a single page (hasMore=false immediately) returns exactly that page", async () => {
  const rows = await fetchFullConversationHistory({
    sessionId: "session-1",
    readRange: async () => ({
      rows: [userRow(1), userRow(2)],
      atSeq: 2,
      atRevision: 1,
      atLogEpoch: "epoch-1",
      hasMore: false,
    }),
  });
  assert.deepEqual(
    rows.map((r) => r.rowId),
    [1, 2],
  );
});

test("multiple pages are walked oldest-first and reassembled in rowId order", async () => {
  // 模拟总共 5 行、每页 2 行：第一次调用（无 beforeRowId）拿到最新的 [4,5]；
  // 用 beforeRowId=4 再拿 [2,3]；再用 beforeRowId=2 拿到 [1]，hasMore=false 结束。
  const calls: (number | undefined)[] = [];
  const rows = await fetchFullConversationHistory({
    sessionId: "session-1",
    pageLimit: 2,
    readRange: async (params) => {
      calls.push(params.beforeRowId);
      if (params.beforeRowId === undefined) {
        return {
          rows: [userRow(4), userRow(5)],
          atSeq: 5,
          atRevision: 1,
          atLogEpoch: "e",
          hasMore: true,
        };
      }
      if (params.beforeRowId === 4) {
        return {
          rows: [userRow(2), userRow(3)],
          atSeq: 5,
          atRevision: 1,
          atLogEpoch: "e",
          hasMore: true,
        };
      }
      if (params.beforeRowId === 2) {
        return { rows: [userRow(1)], atSeq: 5, atRevision: 1, atLogEpoch: "e", hasMore: false };
      }
      throw new Error(`unexpected beforeRowId ${params.beforeRowId}`);
    },
  });
  assert.deepEqual(calls, [undefined, 4, 2]);
  assert.deepEqual(
    rows.map((r) => r.rowId),
    [1, 2, 3, 4, 5],
  );
});

test("an empty conversation returns an empty array without looping", async () => {
  const rows = await fetchFullConversationHistory({
    sessionId: "session-1",
    readRange: async () => ({ rows: [], atSeq: 0, atRevision: 0, atLogEpoch: "e", hasMore: false }),
  });
  assert.deepEqual(rows, []);
});

test("a paging cursor that never converges is caught rather than looping forever", async () => {
  await assert.rejects(
    () =>
      fetchFullConversationHistory({
        sessionId: "session-1",
        maxPages: 3,
        readRange: async () => ({
          rows: [userRow(1)],
          atSeq: 1,
          atRevision: 1,
          atLogEpoch: "e",
          // 恒为 true 且下一页游标不变——模拟一个坏掉的分页实现。
          hasMore: true,
        }),
      }),
    ConversationHistoryPagingLimitExceededError,
  );
});
