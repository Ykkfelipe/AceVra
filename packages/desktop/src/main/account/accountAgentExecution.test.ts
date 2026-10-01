import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTaskStartedNotice, TaskView, ZCodeExecutionTargetParams } from "@zcode/shared";
import { createAgentExecutionHandler } from "./accountAgentExecution.js";
import type { AccountTasksApi } from "./accountTasks.js";
import { LOCAL_TARGET_ID } from "./localProcessRunner.js";

const BASE = { requestId: "req-1", sessionId: "sess-A", workspacePath: "/w" } as const;
const TASK: TaskView = {
  id: "task-1",
  targetId: "dev_node",
  state: "running",
  process: { executable: "pnpm", args: ["test"], cwd: "/srv/app", timeoutMs: 600000 },
  createdAt: "2026-01-02T00:00:00Z",
  startedAt: "2026-01-02T00:00:01Z",
  finishedAt: null,
  result: null,
  lastSequence: 4,
};

function setup(overrides: Partial<AccountTasksApi> = {}) {
  const calls: string[] = [];
  const tasks: AccountTasksApi = {
    listTargets: async () => [
      {
        id: LOCAL_TARGET_ID,
        type: "desktop",
        displayName: "This Mac",
        online: true,
        capabilities: ["shell", "files"],
        isThisDevice: true,
        available: true,
      },
      {
        id: "dev_node",
        type: "node",
        displayName: "Lab box",
        online: false,
        // 未知能力（控制面以后新增）不能让 list 校验失败。
        capabilities: ["shell", "teleport" as never],
        isThisDevice: false,
        available: false,
        unavailableReason: "offline",
      },
    ],
    startRemoteProcess: async (input) => (
      calls.push(`start:${input.targetId}`),
      { ok: true, taskId: "task-1", targetId: input.targetId }
    ),
    listTasks: async () => [TASK],
    getTask: async (id) => (calls.push(`get:${id}`), id === "task-1" ? TASK : null),
    getTaskEvents: async (id, after) => (
      calls.push(`events:${id}:${after}`),
      [{ sequence: 5, type: "process.output", ts: "t", payload: { stream: "stdout", text: "ok" } }]
    ),
    cancelTask: async (id, force) => (
      calls.push(`cancel:${id}:${force}`), id === "task-1" ? { ...TASK, state: "cancelling" } : null
    ),
    ...overrides,
  };
  const notices: AgentTaskStartedNotice[] = [];
  const handle = createAgentExecutionHandler({ tasks });
  const run = (request: ZCodeExecutionTargetParams) =>
    handle(request, (notice) => notices.push(notice));
  return { run, calls, notices };
}

test("list returns targets with known capabilities only", async () => {
  const { run } = setup();
  const result = await run({ ...BASE, op: "list" });
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.op === "list");
  assert.deepEqual(
    result.targets.map((t) => [t.id, t.available, t.capabilities]),
    [
      [LOCAL_TARGET_ID, true, ["shell", "files"]],
      ["dev_node", false, ["shell"]],
    ],
  );
});

test("start on a node creates a control-plane task and notifies the session's card once", async () => {
  const { run, calls, notices } = setup();
  const result = await run({
    ...BASE,
    op: "start",
    targetId: "dev_node",
    process: { executable: "pnpm", args: ["test"], cwd: "/srv/app" },
  });
  assert.deepEqual(result, { op: "start", ok: true, taskId: "task-1", targetId: "dev_node" });
  assert.deepEqual(calls, ["start:dev_node"]);
  assert.deepEqual(notices, [{ sessionId: "sess-A", taskId: "task-1", targetId: "dev_node" }]);
});

test("start never runs on this device through the agent path", async () => {
  const { run, calls, notices } = setup();
  const result = await run({
    ...BASE,
    op: "start",
    targetId: LOCAL_TARGET_ID,
    process: { executable: "ls", cwd: "/" },
  });
  assert.deepEqual(result, { op: "start", ok: false, reason: "target_is_local" });
  assert.deepEqual(calls, []);
  assert.deepEqual(notices, []);
});

test("start failures are truthful: offline detail, not signed in, account api down", async () => {
  const offline = setup({
    startRemoteProcess: async () => ({
      ok: false,
      reason: "target_unavailable",
      detail: "target_offline",
    }),
  });
  const request = {
    ...BASE,
    op: "start" as const,
    targetId: "dev_node",
    process: { executable: "x", cwd: "/" },
  };
  assert.deepEqual(await offline.run(request), {
    op: "start",
    ok: false,
    reason: "target_unavailable",
    detail: "target_offline",
  });
  assert.deepEqual(offline.notices, []);
  const signedOut = setup({
    startRemoteProcess: async () => ({ ok: false, reason: "not_signed_in" }),
  });
  assert.equal((await signedOut.run(request)).ok, false);
  const down = setup({ startRemoteProcess: async () => ({ ok: false, reason: "unavailable" }) });
  assert.deepEqual(await down.run(request), {
    op: "start",
    ok: false,
    reason: "unavailable",
    detail: "account_api_unreachable",
  });
  const thrown = setup({
    startRemoteProcess: async () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(await thrown.run(request), { op: "start", ok: false, reason: "internal" });
});

test("read returns the task state without the command line plus events after the cursor", async () => {
  const { run, calls } = setup();
  const result = await run({ ...BASE, op: "read", taskId: "task-1", after: 4 });
  assert.ok(result.ok && result.op === "read");
  assert.equal(result.task.state, "running");
  assert.equal("process" in result.task, false);
  assert.deepEqual(
    result.events.map((e) => e.sequence),
    [5],
  );
  assert.deepEqual(calls, ["get:task-1", "events:task-1:4"]);
  assert.deepEqual(await run({ ...BASE, op: "read", taskId: "missing-1", after: 0 }), {
    op: "read",
    ok: false,
    reason: "task_not_found",
  });
});

test("cancel forwards to the existing cancel path", async () => {
  const { run, calls } = setup();
  const result = await run({ ...BASE, op: "cancel", taskId: "task-1" });
  assert.ok(result.ok && result.op === "cancel");
  assert.equal(result.task.state, "cancelling");
  assert.deepEqual(calls, ["cancel:task-1:false"]);
});

test("computer actions go to the SSH computer and announce the session once", async () => {
  const tasks = {} as AccountTasksApi;
  const seen: Array<{ sessionId: string; targetId: string; kind: string }> = [];
  const handle = createAgentExecutionHandler({
    tasks,
    computers: {
      computerAction: async (input) => (
        seen.push({
          sessionId: input.sessionId,
          targetId: input.targetId,
          kind: input.action.kind,
        }),
        { ok: true, screen: { width: 1366, height: 768 }, sessionStarted: seen.length === 1 }
      ),
    },
  });
  const sessions: Array<{ sessionId: string; computerId: string }> = [];
  const request = {
    ...BASE,
    op: "computer" as const,
    targetId: "ssh:dell",
    action: { kind: "click" as const, x: 10, y: 20 },
  };
  const first = await handle(
    request,
    () => undefined,
    (notice) => sessions.push(notice),
  );
  assert.deepEqual(first, { op: "computer", ok: true, screen: { width: 1366, height: 768 } });
  await handle(
    request,
    () => undefined,
    (notice) => sessions.push(notice),
  );
  assert.deepEqual(sessions, [{ sessionId: "sess-A", computerId: "dell" }]);
  assert.equal(seen.length, 2);
});

test("computer actions never run locally and fail truthfully when offline or paused", async () => {
  const local = createAgentExecutionHandler({ tasks: {} as AccountTasksApi });
  assert.deepEqual(
    await local(
      { ...BASE, op: "computer", targetId: LOCAL_TARGET_ID, action: { kind: "screenshot" } },
      () => undefined,
    ),
    { op: "computer", ok: false, reason: "target_is_local" },
  );
  const offline = createAgentExecutionHandler({
    tasks: {} as AccountTasksApi,
    computers: {
      computerAction: async () => ({
        ok: false,
        reason: "computer_offline",
        detail: "unreachable",
      }),
    },
  });
  assert.deepEqual(
    await offline(
      { ...BASE, op: "computer", targetId: "ssh:dell", action: { kind: "screenshot" } },
      () => undefined,
    ),
    { op: "computer", ok: false, reason: "computer_offline", detail: "unreachable" },
  );
  const paused = createAgentExecutionHandler({
    tasks: {} as AccountTasksApi,
    computers: {
      computerAction: async () => ({
        ok: false,
        reason: "computer_paused",
        detail: "physical_input",
      }),
    },
  });
  const result = await paused(
    { ...BASE, op: "computer", targetId: "ssh:dell", action: { kind: "type", text: "x" } },
    () => undefined,
  );
  assert.equal(result.ok === false && result.reason, "computer_paused");
});
