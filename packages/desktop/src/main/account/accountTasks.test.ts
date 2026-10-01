import assert from "node:assert/strict";
import test from "node:test";
import { createAccountTasks } from "./accountTasks.js";
import { LOCAL_TARGET_ID, type LocalProcessRunner } from "./localProcessRunner.js";

const REMOTE_TASK = {
  id: "task-remote-1",
  targetDeviceId: "dev_dell",
  state: "running",
  process: { executable: "pnpm", args: ["test"], cwd: "/p", timeoutMs: 60000, envNames: [] },
  createdAt: "2026-01-02T00:00:00Z",
  startedAt: null,
  finishedAt: null,
  result: null,
  lastSequence: 3,
};
function setup(
  options: {
    ready?: boolean;
    responses?: Record<string, { status: number; json: any } | null>;
  } = {},
) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const localCalls: string[] = [];
  const local = {
    start: (p: any) => (
      localCalls.push("start"),
      p.executable ? { ok: true as const, taskId: "local-1" } : { ok: false as const }
    ),
    list: () => [
      {
        id: "local-1",
        targetId: LOCAL_TARGET_ID,
        state: "completed",
        process: { executable: "x", args: [], cwd: "/", timeoutMs: 1 },
        createdAt: "2026-01-01T00:00:00Z",
        startedAt: null,
        finishedAt: null,
        result: null,
        lastSequence: 1,
      },
    ],
    events: (id: string) => (localCalls.push(`events:${id}`), []),
    cancel: (id: string) => (localCalls.push(`cancel:${id}`), null),
    shutdown() {},
  } as unknown as LocalProcessRunner;
  const api = createAccountTasks({
    local,
    accountReady: () => options.ready ?? true,
    thisDevice: () => ({
      id: "dev_mac",
      displayName: "Some Laptop",
      capabilities: ["files", "shell"],
    }),
    call: async (method, path, body) => {
      calls.push({ method, path, body });
      const key = `${method} ${path.split("?")[0]}`;
      return options.responses && key in options.responses
        ? options.responses[key]!
        : { status: 200, json: {} };
    },
  });
  return { api, calls, localCalls };
}

test("targets: local is always first and available; remote targets come from the backend; this device is not duplicated", async () => {
  const { api } = setup({
    responses: {
      "GET /v1/targets": {
        status: 200,
        json: {
          targets: [
            {
              id: "dev_mac",
              type: "desktop",
              displayName: "Some Laptop",
              online: true,
              capabilities: [],
              available: false,
              unavailableReason: "remote_desktop_unsupported",
            },
            {
              id: "dev_dell",
              type: "node",
              displayName: "Anything Name",
              online: true,
              capabilities: ["shell"],
              available: true,
            },
            {
              id: "dev_off",
              type: "node",
              displayName: "Sleeper",
              online: false,
              capabilities: ["shell"],
              available: false,
              unavailableReason: "offline",
            },
          ],
        },
      },
    },
  });
  const targets = await api.listTargets();
  assert.deepEqual(
    targets.map((t) => [t.id, t.available, t.isThisDevice]),
    [
      [LOCAL_TARGET_ID, true, true],
      ["dev_dell", true, false],
      ["dev_off", false, false],
    ],
  );
  assert.equal(targets[2]!.unavailableReason, "offline");
  assert.ok(!targets.some((t) => (t as any).type === "cloud"), "cloud is not offered");
});

test("signed out: only the local target, and the network is never consulted", async () => {
  const { api, calls } = setup({ ready: false });
  assert.deepEqual(
    (await api.listTargets()).map((t) => t.id),
    [LOCAL_TARGET_ID],
  );
  assert.deepEqual(
    await api.startRemoteProcess({ targetId: "dev_dell", process: { executable: "x", cwd: "/" } }),
    { ok: false, reason: "not_signed_in" },
  );
  assert.equal(calls.length, 0);
});

test("start routes local runs locally and node runs through the control plane, returning a handle", async () => {
  const { api, calls, localCalls } = setup({
    responses: { "POST /v1/tasks": { status: 201, json: { task: REMOTE_TASK } } },
  });
  assert.deepEqual(
    await api.startRemoteProcess({
      targetId: LOCAL_TARGET_ID,
      process: { executable: "node", cwd: "/" },
    }),
    { ok: true, taskId: "local-1", targetId: LOCAL_TARGET_ID },
  );
  assert.deepEqual(localCalls, ["start"]);
  assert.equal(calls.length, 0, "local never touches the control plane");
  const remote = await api.startRemoteProcess({
    targetId: "dev_dell",
    process: { executable: "pnpm", args: ["test"], cwd: "/p", env: { A: "1" }, timeoutMs: 5000 },
    idempotencyKey: "k1",
  });
  assert.deepEqual(remote, { ok: true, taskId: "task-remote-1", targetId: "dev_dell" });
  assert.deepEqual(calls[0]!.body, {
    targetDeviceId: "dev_dell",
    process: { executable: "pnpm", args: ["test"], cwd: "/p", env: { A: "1" }, timeoutMs: 5000 },
    idempotencyKey: "k1",
  });
  assert.equal(
    JSON.stringify(calls[0]!.body).includes("accountId"),
    false,
    "no client-supplied owner",
  );
});

test("start maps backend refusals to stable reasons", async () => {
  for (const [status, reason] of [
    [400, "invalid_request"],
    [404, "target_not_found"],
    [409, "target_unavailable"],
    [500, "unavailable"],
  ] as const) {
    const { api } = setup({ responses: { "POST /v1/tasks": { status, json: {} } } });
    assert.deepEqual(
      await api.startRemoteProcess({
        targetId: "dev_dell",
        process: { executable: "x", cwd: "/" },
      }),
      { ok: false, reason },
    );
  }
  const down = setup({ responses: { "POST /v1/tasks": null } });
  assert.deepEqual(
    await down.api.startRemoteProcess({
      targetId: "dev_dell",
      process: { executable: "x", cwd: "/" },
    }),
    { ok: false, reason: "unavailable" },
  );
  assert.deepEqual(
    await setup().api.startRemoteProcess({
      targetId: LOCAL_TARGET_ID,
      process: { executable: "", cwd: "/" },
    }),
    { ok: false, reason: "invalid_request" },
  );
});

test("tasks list merges local and remote newest-first with one shape; events and cancel route by id", async () => {
  const { api, calls, localCalls } = setup({
    responses: {
      "GET /v1/tasks": { status: 200, json: { tasks: [REMOTE_TASK] } },
      "GET /v1/tasks/task-remote-1/events": {
        status: 200,
        json: { events: [{ sequence: 4, type: "process.output", ts: "t", payload: {} }] },
      },
      "POST /v1/tasks/task-remote-1/cancel": {
        status: 200,
        json: { task: { ...REMOTE_TASK, state: "cancelling" } },
      },
    },
  });
  const tasks = await api.listTasks();
  assert.deepEqual(
    tasks.map((t) => [t.id, t.targetId, t.state]),
    [
      ["task-remote-1", "dev_dell", "running"],
      ["local-1", LOCAL_TARGET_ID, "completed"],
    ],
  );
  assert.ok(!("envNames" in tasks[0]!.process), "the view is the shared shape");
  assert.equal((await api.getTaskEvents("task-remote-1", 3))[0]!.sequence, 4);
  assert.ok(calls.some((c) => c.path === "/v1/tasks/task-remote-1/events?after=3"));
  await api.getTaskEvents("local-1", 0);
  await api.cancelTask("local-1");
  assert.deepEqual(localCalls, ["events:local-1", "cancel:local-1"]);
  assert.equal((await api.cancelTask("task-remote-1", true))!.state, "cancelling");
  assert.deepEqual(calls.at(-1)!.body, { force: true });
});
