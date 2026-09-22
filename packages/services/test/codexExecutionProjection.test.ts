/**
 * Codex 执行后端 — 投影域纯函数回归测试（不触达 Codex，零推理）。
 *
 * 固定语义：
 * - 助手文本 delta 增量累积 + item/completed 全量收敛，
 * - 命令执行/文件修改/MCP 项 → toolCall 行（结构化输入摘要），
 * - 审批请求 → pendingInteraction + 锚点行 pendingApproval，未知 interactionId 拒绝，
 * - turn/completed → turnHeader 终态 + control 收敛，
 * - 快照必须通过 zcode-protocol-v4 的 conversationSnapshotSchema 校验，
 * - 未知通知被丢弃（不 fatal、不产生空帧）。
 *
 * Run: mise exec -- node --import tsx --test packages/services/test/codexExecutionProjection.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { conversationSnapshotSchema } from "@zcode/shared/zcode-protocol-v4";
import { CodexThreadProjection } from "../src/codex/domain/codexProjection.js";
import {
  parseCodexNotification,
  parseCodexServerRequest,
  scrubCodexErrorDetail,
} from "../src/codex/domain/codexWire.js";

let clock = 1_000;
function tick(): number {
  clock += 1;
  return clock;
}

function freshProjection(): CodexThreadProjection {
  clock = 1_000;
  return new CodexThreadProjection("codex-1", tick);
}

function beginTurn(projection: CodexThreadProjection, text = "fix the bug"): void {
  projection.beginUserTurn({ text, turnId: "turn-1", commandId: "cmd-1" });
}

test("beginUserTurn emits turnHeader + userInput rows and running control", () => {
  const projection = freshProjection();
  const commit = projection.beginUserTurn({ text: "fix the bug", turnId: "turn-1", commandId: "cmd-1" });
  assert.equal(commit.deltas.length, 3);
  assert.equal(commit.deltas[0]?.op, "row.appended");
  assert.equal(commit.deltas[1]?.op, "row.appended");
  const turnHeader = commit.deltas[0]?.row;
  assert.equal(turnHeader?.kind, "turnHeader");
  assert.equal(turnHeader?.state, "running");
  const userInput = commit.deltas[1]?.row;
  assert.equal(userInput?.kind, "userInput");
  assert.equal(userInput?.text, "fix the bug");
  const snapshot = projection.buildSnapshot("task-1");
  assert.equal(snapshot.control.phase, "running");
  assert.equal(snapshot.control.canStop, true);
});

test("assistant message deltas accumulate into the streaming row", () => {
  const projection = freshProjection();
  beginTurn(projection);
  const started = projection.applyNotification(
    parseCodexNotification("item/started", { itemId: "itm-1", item: { type: "agentMessage", id: "itm-1", text: "" } }),
  );
  assert.ok(started);
  const delta1 = projection.applyNotification(
    parseCodexNotification("item/agentMessage/delta", { itemId: "itm-1", delta: "Hel" }),
  );
  const delta2 = projection.applyNotification(
    parseCodexNotification("item/agentMessage/delta", { itemId: "itm-1", delta: "lo" }),
  );
  assert.ok(delta1 && delta2);
  assert.equal(delta2.deltas[0]?.op, "row.delta");
  const completed = projection.applyNotification(
    parseCodexNotification("item/completed", { itemId: "itm-1", item: { type: "agentMessage", id: "itm-1", text: "Hello world" } }),
  );
  assert.ok(completed);
  const row = completed.deltas[0]?.row;
  assert.equal(row?.kind, "assistantText");
  assert.equal(row?.state, "complete");
  assert.equal(row?.text, "Hello world");
});

test("command execution item maps to a structured toolCall row with output", () => {
  const projection = freshProjection();
  beginTurn(projection);
  projection.applyNotification(
    parseCodexNotification("item/started", {
      itemId: "cmd-1",
      item: { type: "commandExecution", id: "cmd-1", command: "cargo test" },
    }),
  );
  projection.applyNotification(
    parseCodexNotification("item/commandExecution/outputDelta", { itemId: "cmd-1", delta: "ok 1" }),
  );
  const completed = projection.applyNotification(
    parseCodexNotification("item/completed", {
      itemId: "cmd-1",
      item: { type: "commandExecution", id: "cmd-1", command: "cargo test", aggregatedOutput: "ok 1\nok 2", exitCode: 0, status: "completed" },
    }),
  );
  assert.ok(completed);
  const row = completed.deltas[0]?.row;
  assert.equal(row?.kind, "toolCall");
  assert.equal(row?.toolName, "codex.commandExecution");
  assert.equal(row?.inputText, "cargo test");
  assert.equal(row?.status, "success");
  assert.equal(row?.output?.text, "ok 1\nok 2");
});

test("file change item keeps the change list as structured input", () => {
  const projection = freshProjection();
  beginTurn(projection);
  const started = projection.applyNotification(
    parseCodexNotification("item/started", {
      itemId: "fc-1",
      item: {
        type: "fileChange",
        id: "fc-1",
        changes: [
          { path: "src/a.ts", kind: "update" },
          { path: "src/b.ts", kind: "add" },
        ],
      },
    }),
  );
  assert.ok(started);
  const row = started.deltas[0]?.row;
  assert.equal(row?.kind, "toolCall");
  assert.equal(row?.toolName, "codex.fileChange");
  assert.match(row?.inputText ?? "", /update src\/a\.ts/);
  assert.match(row?.inputText ?? "", /add src\/b\.ts/);
});

test("approval request surfaces as pendingInteraction and resolves via the table", () => {
  const projection = freshProjection();
  beginTurn(projection);
  projection.applyNotification(
    parseCodexNotification("item/started", {
      itemId: "cmd-9",
      item: { type: "commandExecution", id: "cmd-9", command: "rm -rf build" },
    }),
  );
  const request = parseCodexServerRequest("item/commandExecution/requestApproval", { command: "rm -rf build" }, 42);
  assert.equal(request.type, "approval");
  const { commit, record } = projection.registerApproval(
    { kind: request.info.kind, toolName: request.info.toolName, summary: request.info.summary },
    request.rawId,
  );
  assert.match(record.interactionId, /^codex-approval-\d+$/);
  const interactions = projection.buildSnapshot("task-1").pendingInteractions;
  assert.equal(interactions.length, 1);
  assert.equal(interactions[0]?.interactionId, record.interactionId);
  assert.equal(interactions[0]?.payload.kind, "permission");
  // 审批选项就是 decision 词表：approved / denied。
  const options = interactions[0]?.payload.options ?? [];
  assert.deepEqual(options.map((option) => option.optionId), ["approved", "denied"]);
  const anchor = commit.deltas.find((delta) => delta.op === "row.upserted");
  assert.equal(anchor?.row?.status, "pendingApproval");
  assert.equal(anchor?.row?.approvalInteractionId, record.interactionId);

  // 未知 interactionId 必须被拒绝（绝不静默放行）。
  assert.equal(projection.resolveApproval("codex-approval-999", "approved"), null);
  assert.equal(projection.pendingApprovals.length, 1);

  const resolution = projection.resolveApproval(record.interactionId, "approved");
  assert.ok(resolution);
  // schema 真形：CommandExecutionApprovalDecision 是 accept/decline 词表，不是 approved/denied。
  assert.deepEqual(resolution.codexResponse, { decision: "accept" });
  assert.equal(projection.buildSnapshot("task-1").pendingInteractions.length, 0);

  // 权限类审批：拒绝 = 空 profile（不授予任何额外权限）；批准 = 回传请求的 profile。
  const permRequest = parseCodexServerRequest(
    "item/permissions/requestApproval",
    { threadId: "t1", turnId: "turn-1", itemId: "itm-9", permissions: { fileSystem: { read: ["/tmp/x"] } } },
    43,
  );
  assert.equal(permRequest.type, "approval");
  assert.ok(permRequest.type === "approval");
  const perm = projection.registerApproval(
    { kind: permRequest.info.kind, toolName: permRequest.info.toolName, summary: permRequest.info.summary },
    permRequest.rawId,
    permRequest.requestedPermissions,
  );
  const permDenial = projection.resolveApproval(perm.record.interactionId, "denied");
  assert.ok(permDenial);
  assert.deepEqual(permDenial.codexResponse, { permissions: {}, scope: "turn" });
  const permApprove = projection.resolveApproval("codex-approval-999", "approved");
  assert.equal(permApprove, null);
  const second = parseCodexServerRequest(
    "item/permissions/requestApproval",
    { threadId: "t1", turnId: "turn-1", itemId: "itm-9", permissions: { fileSystem: { read: ["/tmp/x"] } } },
    44,
  );
  assert.ok(second.type === "approval");
  const perm2 = projection.registerApproval(
    { kind: second.info.kind, toolName: second.info.toolName, summary: second.info.summary },
    second.rawId,
    second.requestedPermissions,
  );
  const permGrant = projection.resolveApproval(perm2.record.interactionId, "approved");
  assert.ok(permGrant);
  assert.deepEqual(permGrant.codexResponse, {
    permissions: { fileSystem: { read: ["/tmp/x"] } },
    scope: "turn",
  });
});

test("turn completion drives turnHeader state and control phase", () => {
  const projection = freshProjection();
  beginTurn(projection);
  const failed = projection.applyNotification(
    parseCodexNotification("turn/completed", { threadId: "t1", turnId: "turn-1", status: "failed", error: { message: "rate limited" } }),
  );
  assert.ok(failed);
  assert.equal(projection.buildSnapshot("task-1").control.phase, "error");
  assert.match(projection.buildSnapshot("task-1").control.lastError?.message ?? "", /rate limited/);

  beginTurn2(projection);
  const interrupted = projection.applyNotification(
    parseCodexNotification("turn/completed", { threadId: "t1", turnId: "turn-2", status: "interrupted" }),
  );
  assert.ok(interrupted);
  const snapshot = projection.buildSnapshot("task-1");
  assert.equal(snapshot.control.phase, "completedInterrupted");
  assert.equal(snapshot.control.sessionEnded, true);
});

function beginTurn2(projection: CodexThreadProjection): void {
  projection.beginUserTurn({ text: "second", turnId: "turn-2", commandId: "cmd-2" });
}

test("snapshot passes the v4 conversation snapshot schema", () => {
  const projection = freshProjection();
  beginTurn(projection);
  projection.applyNotification(
    parseCodexNotification("item/started", { itemId: "itm-1", item: { type: "agentMessage", id: "itm-1", text: "" } }),
  );
  projection.applyNotification(
    parseCodexNotification("item/agentMessage/delta", { itemId: "itm-1", delta: "partial answer" }),
  );
  projection.applyNotification(
    parseCodexNotification("item/started", {
      itemId: "cmd-1",
      item: { type: "commandExecution", id: "cmd-1", command: "ls" },
    }),
  );
  const snapshot = projection.buildSnapshot("task-1");
  const parsed = conversationSnapshotSchema.safeParse(snapshot);
  assert.ok(parsed.success, `snapshot schema mismatch: ${JSON.stringify(parsed.error?.issues ?? []).slice(0, 600)}`);
  assert.equal(parsed.data.sessionId, "task-1");
  assert.equal(parsed.data.logEpoch, "codex-1");
  // 不建模的区段必须为空，不能伪造。
  assert.equal(parsed.data.goal, null);
  assert.equal(parsed.data.plan, null);
  assert.deepEqual(parsed.data.queue.items, []);
  assert.deepEqual(parsed.data.backgroundWorks, []);
});

test("unknown notifications and delta for unknown items are dropped", () => {
  const projection = freshProjection();
  beginTurn(projection);
  assert.equal(projection.applyNotification({ type: "unknown", method: "thread/queue/changed" }), null);
  assert.equal(
    projection.applyNotification(
      parseCodexNotification("item/agentMessage/delta", { itemId: "nope", delta: "x" }),
    ),
    null,
  );
  // thread/started 采纳 threadId 兜底（app 层职责，这里只确认不产生帧）。
  assert.equal(
    projection.applyNotification(parseCodexNotification("turn/started", { threadId: "t1" })),
    null,
  );
});

test("error detail scrubbing strips absolute paths and caps length", () => {
  const scrubbed = scrubCodexErrorDetail("failed to read /Users/me/secret/dir/config.toml value", 60);
  assert.doesNotMatch(scrubbed, /\/Users\/me/);
  assert.match(scrubbed, /<path>/);
  const long = scrubCodexErrorDetail("x".repeat(500));
  assert.ok(long.length <= 201);
});
