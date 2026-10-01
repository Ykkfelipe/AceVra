import assert from "node:assert/strict";
import test from "node:test";
import { createTestApp } from "./helpers.js";
import {
  FakeNode,
  createTask,
  ok,
  pairNode,
  person,
  proc,
  setupTasks,
  sleep,
  taskEvents,
  taskView,
  waitState,
} from "./nodeHelpers.js";

/** Pairs + connects a node and returns it with the control-plane listener. */
async function online(options: Parameters<typeof setupTasks>[0] = {}) {
  const t = await setupTasks(options);
  const srv = await t.listen();
  const { keys, deviceId } = await pairNode(t, srv.url);
  const node = await FakeNode.connect(srv.wsUrl, deviceId, keys);
  return { t, srv, node, deviceId, keys };
}
const run = async (node: FakeNode, offer: any, events: Record<string, unknown>[] = []) => {
  node.send({ type: "task.accept", taskId: offer.taskId, attempt: offer.attempt });
  let seq = 0;
  for (const e of events)
    node.send({
      type: "task.event",
      taskId: offer.taskId,
      attempt: offer.attempt,
      seq: ++seq,
      ...e,
    });
  return seq;
};

test("create → dispatch → accept → stream → complete, with ordered events and acks", async () => {
  const { t, srv, node, deviceId } = await online();
  try {
    const { status, body } = await createTask(t, deviceId);
    assert.equal(status, 201);
    assert.equal(body.task.state, "queued");
    const offer = await node.waitFor((m) => m.type === "task.offer");
    assert.equal(offer.taskId, body.task.id);
    assert.deepEqual(offer.process, { ...proc(), env: {} });
    await waitState(t, offer.taskId, "dispatching");
    const lastSeq = await run(node, offer, [
      { event: "process.started", payload: { pid: 42 } },
      {
        event: "process.output",
        payload: { stream: "stdout", text: "71 tests discovered\n", bytes: 20 },
      },
      { event: "process.output", payload: { stream: "stderr", text: "warn: slow\n", bytes: 11 } },
      { event: "process.progress", payload: { message: "42 passed" } },
    ]);
    await waitState(t, offer.taskId, "running");
    node.send({
      type: "task.complete",
      taskId: offer.taskId,
      attempt: offer.attempt,
      seq: lastSeq + 1,
      result: ok,
    });
    await waitState(t, offer.taskId, "completed");
    const ack = await node.waitFor((m) => m.type === "task.ack" && m.terminal);
    assert.equal(ack.taskId, offer.taskId);
    const events = await taskEvents(t, offer.taskId);
    assert.deepEqual(
      events.map((e) => e.type),
      [
        "task.created",
        "task.assigned",
        "task.accepted",
        "process.started",
        "process.output",
        "process.output",
        "process.progress",
        "process.completed",
      ],
    );
    assert.deepEqual(
      events.map((e) => e.sequence),
      [1, 2, 3, 4, 5, 6, 7, 8],
      "contiguous server-ordered sequence",
    );
    assert.equal(events[4].payload.text, "71 tests discovered\n");
    assert.equal(events[5].payload.stream, "stderr");
    const view = await taskView(t, offer.taskId);
    assert.equal(view.result.exitCode, 0);
    assert.ok(view.startedAt && view.finishedAt);
    assert.equal(
      JSON.stringify(view).includes("71 tests"),
      false,
      "raw output is not in the task row",
    );
    // Incremental reads: only events after a sequence.
    assert.deepEqual(
      (await taskEvents(t, offer.taskId, 6)).map((e) => e.sequence),
      [7, 8],
    );
  } finally {
    await srv.close();
  }
});

test("non-zero exit, timeout and spawn failure end as failed with the reason recorded", async () => {
  const { t, srv, node, deviceId } = await online();
  try {
    for (const [reason, result] of [
      ["exit_nonzero", { ...ok, exitCode: 1 }],
      ["timeout", { ...ok, exitCode: null, signal: "SIGTERM", timedOut: true }],
      ["spawn_failed", { ...ok, exitCode: null, detail: "ENOENT" }],
    ] as const) {
      const { body } = await createTask(t, deviceId);
      const offer = await node.waitFor((m) => m.type === "task.offer" && m.taskId === body.task.id);
      await run(node, offer);
      node.send({
        type: "task.fail",
        taskId: offer.taskId,
        attempt: offer.attempt,
        seq: 1,
        reason,
        result,
      });
      await waitState(t, offer.taskId, "failed");
      const view = await taskView(t, offer.taskId);
      assert.equal(view.result.reason, reason);
      assert.equal(view.result.exitCode, result.exitCode);
    }
  } finally {
    await srv.close();
  }
});

test("reject by the node fails the task and the next queued task is offered", async () => {
  const { t, srv, node, deviceId } = await online();
  try {
    const first = (await createTask(t, deviceId)).body.task;
    const second = (await createTask(t, deviceId)).body.task;
    const offer = await node.waitFor((m) => m.type === "task.offer" && m.taskId === first.id);
    assert.equal(node.offers().length, 1, "serial dispatch: one active task per node");
    node.send({
      type: "task.reject",
      taskId: offer.taskId,
      attempt: offer.attempt,
      reason: "policy",
    });
    await waitState(t, first.id, "failed");
    const next = await node.waitFor((m) => m.type === "task.offer" && m.taskId === second.id);
    assert.equal(next.attempt, 1);
    assert.equal((await taskView(t, first.id)).result.reason, "rejected");
  } finally {
    await srv.close();
  }
});

test("creation is refused for offline, revoked, non-shell, non-node, foreign and unknown targets", async () => {
  const t = await setupTasks();
  const srv = await t.listen();
  try {
    const shell = await pairNode(t, srv.url);
    const noShell = await pairNode(t, srv.url, { capabilities: [], name: "Plain" });
    const foreign = await pairNode(t, srv.url, { owner: "b", name: "Bob's" });
    // Offline (paired but never connected): refused, nothing queued.
    t.clock.now += 0;
    const offline = await createTask(t, shell.deviceId);
    assert.equal(offline.status, 409);
    assert.equal(offline.body.error, "target_offline");
    await FakeNode.connect(srv.wsUrl, noShell.deviceId, noShell.keys);
    assert.equal((await createTask(t, noShell.deviceId)).body.error, "target_lacks_shell");
    // Another account's device is indistinguishable from a missing one.
    await FakeNode.connect(srv.wsUrl, foreign.deviceId, foreign.keys);
    assert.equal((await createTask(t, foreign.deviceId)).status, 404);
    assert.equal((await createTask(t, "no-such-device")).status, 404);
    // A desktop device is not a remote execution target.
    const desktop = await t.a("/v1/devices/register", {
      method: "POST",
      json: {
        installationId: "11111111-1111-4111-8111-111111111111",
        type: "desktop",
        platform: "darwin",
        displayName: "Mac",
        capabilities: ["shell"],
      },
    });
    assert.equal(
      (await createTask(t, ((await desktop.json()) as any).device.id)).body.error,
      "target_not_node",
    );
    // Revoked.
    const live = await FakeNode.connect(srv.wsUrl, shell.deviceId, shell.keys);
    await t.a(`/v1/devices/${shell.deviceId}/revoke`, { method: "POST" });
    await live.waitClosed();
    assert.equal((await createTask(t, shell.deviceId)).body.error, "target_revoked");
    assert.equal(((await (await t.a("/v1/tasks")).json()) as any).tasks.length, 0);
  } finally {
    await srv.close();
  }
});

test("targets: derived from devices with availability and reasons; no hardcoded machines", async () => {
  const t = await setupTasks();
  const srv = await t.listen();
  try {
    const shell = await pairNode(t, srv.url, { name: "Dell Server" });
    await pairNode(t, srv.url, { capabilities: [], name: "Plain Node" });
    let targets = ((await (await t.a("/v1/targets")).json()) as any).targets;
    const dell = targets.find((x: any) => x.displayName === "Dell Server");
    assert.deepEqual(
      { type: dell.type, available: dell.available, reason: dell.unavailableReason },
      { type: "node", available: false, reason: "offline" },
    );
    const node = await FakeNode.connect(srv.wsUrl, shell.deviceId, shell.keys);
    targets = ((await (await t.a("/v1/targets")).json()) as any).targets;
    const online = targets.find((x: any) => x.displayName === "Dell Server");
    assert.deepEqual(
      { available: online.available, online: online.online, caps: online.capabilities },
      { available: true, online: true, caps: ["shell"] },
    );
    assert.equal(
      targets.find((x: any) => x.displayName === "Plain Node").unavailableReason,
      "no_shell_service",
    );
    assert.deepEqual(
      ((await (await t.b("/v1/targets")).json()) as any).targets,
      [],
      "another account sees no targets",
    );
    node.drop();
  } finally {
    await srv.close();
  }
});

test("process validation: malformed or dangerous specs are rejected before queueing", async () => {
  const { t, srv, deviceId } = await online();
  try {
    for (const bad of [
      proc({ executable: "" }),
      proc({ args: "test" }),
      proc({ cwd: "" }),
      proc({ env: { PATH: "/evil" } }),
      proc({ env: { LD_PRELOAD: "x" } }),
      proc({ timeoutMs: 1 }),
      proc({ extra: true }),
      { executable: "x".repeat(300), args: [], cwd: "/p", timeoutMs: 5000 },
      "rm -rf /",
      null,
    ]) {
      const r = await t.a("/v1/tasks", {
        method: "POST",
        json: { targetDeviceId: deviceId, process: bad },
      });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal(
      (await t.a("/v1/tasks", { method: "POST", json: { process: proc() } })).status,
      400,
    );
    assert.equal(((await (await t.a("/v1/tasks")).json()) as any).tasks.length, 0);
  } finally {
    await srv.close();
  }
});

test("idempotency key: a retried create returns the same task", async () => {
  const { t, srv, deviceId } = await online();
  try {
    const one = await createTask(t, deviceId, { idempotencyKey: "req-1" });
    const two = await createTask(t, deviceId, { idempotencyKey: "req-1" });
    assert.equal(one.status, 201);
    assert.equal(two.status, 200);
    assert.equal(two.body.task.id, one.body.task.id);
    assert.equal(((await t.db.query("SELECT count(*)::int n FROM tasks")).rows[0] as any).n, 1);
    assert.equal(
      (
        await t.a("/v1/tasks", {
          method: "POST",
          json: { targetDeviceId: deviceId, process: proc(), idempotencyKey: "bad key!" },
        })
      ).status,
      400,
    );
  } finally {
    await srv.close();
  }
});

test("duplicate accept, event and completion are idempotent (no double effects)", async () => {
  const { t, srv, node, deviceId } = await online();
  try {
    const id = (await createTask(t, deviceId)).body.task.id;
    const offer = await node.waitFor((m) => m.type === "task.offer");
    await run(node, offer);
    node.send({ type: "task.accept", taskId: id, attempt: offer.attempt });
    const out = {
      type: "task.event",
      taskId: id,
      attempt: offer.attempt,
      seq: 1,
      event: "process.output",
      payload: { stream: "stdout", text: "once\n", bytes: 5 },
    };
    node.send(out);
    node.send(out);
    node.send(out);
    const done = { taskId: id, attempt: offer.attempt, seq: 2, result: ok };
    node.send({ type: "task.complete", ...done });
    node.send({ type: "task.complete", ...done });
    node.send({
      type: "task.fail",
      taskId: id,
      attempt: offer.attempt,
      seq: 3,
      reason: "exit_nonzero",
      result: { ...ok, exitCode: 2 },
    });
    await waitState(t, id, "completed");
    await sleep(100);
    const events = await taskEvents(t, id);
    assert.equal(events.filter((e) => e.type === "process.output").length, 1);
    assert.equal(events.filter((e) => e.type === "process.completed").length, 1);
    assert.equal(events.filter((e) => e.type === "task.accepted").length, 1);
    assert.equal(
      (await taskView(t, id)).state,
      "completed",
      "a late conflicting terminal does not rewrite history",
    );
  } finally {
    await srv.close();
  }
});

test("a duplicate offer is never executed twice: re-accepting an active task changes nothing", async () => {
  const { t, srv, node, deviceId } = await online();
  try {
    const id = (await createTask(t, deviceId)).body.task.id;
    const offer = await node.waitFor((m) => m.type === "task.offer");
    for (let i = 0; i < 3; i++)
      node.send({ type: "task.accept", taskId: id, attempt: offer.attempt });
    await waitState(t, id, "running");
    assert.equal(node.offers().length, 1, "the server offered it exactly once");
    assert.equal((await taskEvents(t, id)).filter((e) => e.type === "task.accepted").length, 1);
  } finally {
    await srv.close();
  }
});

test("cancel: queued cancels at once; running goes cancelling until the node confirms", async () => {
  const { t, srv, node, deviceId } = await online();
  try {
    const first = (await createTask(t, deviceId)).body.task;
    const queued = (await createTask(t, deviceId)).body.task;
    const offer = await node.waitFor((m) => m.type === "task.offer" && m.taskId === first.id);
    await run(node, offer);
    await waitState(t, first.id, "running");
    // Queued task: never ran, cancelled immediately and truthfully.
    const c1 = (await (
      await t.a(`/v1/tasks/${queued.id}/cancel`, { method: "POST", json: {} })
    ).json()) as any;
    assert.equal(c1.task.state, "cancelled");
    assert.equal((await taskEvents(t, queued.id)).at(-1).payload.ran, false);
    // Running task: node is told, state is cancelling (not cancelled).
    const c2 = (await (
      await t.a(`/v1/tasks/${first.id}/cancel`, { method: "POST", json: {} })
    ).json()) as any;
    assert.equal(c2.task.state, "cancelling");
    const cancel = await node.waitFor((m) => m.type === "task.cancel");
    assert.equal(cancel.taskId, first.id);
    assert.equal((await taskView(t, first.id)).state, "cancelling");
    // Node confirms after killing the process.
    node.send({
      type: "task.fail",
      taskId: first.id,
      attempt: offer.attempt,
      seq: 1,
      reason: "cancelled",
      result: { ...ok, exitCode: null, signal: "SIGTERM" },
    });
    await waitState(t, first.id, "cancelled");
    const last = (await taskEvents(t, first.id)).at(-1);
    assert.deepEqual(
      { type: last.type, ack: last.payload.acknowledged },
      { type: "task.cancelled", ack: true },
    );
    // Cancelling a terminal task is a harmless no-op.
    assert.equal(
      (
        (await (
          await t.a(`/v1/tasks/${first.id}/cancel`, { method: "POST", json: {} })
        ).json()) as any
      ).task.state,
      "cancelled",
    );
  } finally {
    await srv.close();
  }
});

test("cancel while the node is unavailable stays cancelling; force records an unacknowledged cancel", async () => {
  const { t, srv, node, deviceId } = await online();
  try {
    const id = (await createTask(t, deviceId)).body.task.id;
    const offer = await node.waitFor((m) => m.type === "task.offer");
    await run(node, offer);
    await waitState(t, id, "running");
    node.drop();
    await waitState(t, id, "running_unknown");
    const soft = (await (
      await t.a(`/v1/tasks/${id}/cancel`, { method: "POST", json: {} })
    ).json()) as any;
    assert.equal(
      soft.task.state,
      "cancelling",
      "not claimed cancelled: the device never confirmed",
    );
    const forced = (await (
      await t.a(`/v1/tasks/${id}/cancel`, { method: "POST", json: { force: true } })
    ).json()) as any;
    assert.equal(forced.task.state, "cancelled");
    assert.equal(forced.task.result.acknowledged, false);
    assert.equal((await taskEvents(t, id)).at(-1).payload.acknowledged, false);
  } finally {
    await srv.close();
  }
});

test("disconnect while running → running_unknown (not failed); reconnect holding the task → running again", async () => {
  const { t, srv, node, deviceId, keys } = await online();
  try {
    const id = (await createTask(t, deviceId)).body.task.id;
    const offer = await node.waitFor((m) => m.type === "task.offer");
    await run(node, offer);
    await waitState(t, id, "running");
    node.drop();
    await waitState(t, id, "running_unknown");
    const back = await FakeNode.connect(srv.wsUrl, deviceId, keys, {
      sync: [{ taskId: id, attempt: offer.attempt }],
    });
    await waitState(t, id, "running");
    assert.ok((await taskEvents(t, id)).some((e) => e.type === "task.reconciled"));
    assert.equal(back.offers().length, 0, "never offered again: no double execution");
    back.send({ type: "task.complete", taskId: id, attempt: offer.attempt, seq: 1, result: ok });
    await waitState(t, id, "completed");
  } finally {
    await srv.close();
  }
});

test("node restart (reconnects holding nothing) → the running task is failed as interrupted, never completed", async () => {
  const { t, srv, node, deviceId, keys } = await online();
  try {
    const id = (await createTask(t, deviceId)).body.task.id;
    const offer = await node.waitFor((m) => m.type === "task.offer");
    await run(node, offer);
    await waitState(t, id, "running");
    node.drop();
    await FakeNode.connect(srv.wsUrl, deviceId, keys, { sync: [] });
    await waitState(t, id, "failed");
    assert.equal((await taskView(t, id)).result.reason, "interrupted");
  } finally {
    await srv.close();
  }
});

test("a result produced while disconnected is delivered after reconnect, before sync (not misread as interrupted)", async () => {
  const { t, srv, node, deviceId, keys } = await online();
  try {
    const id = (await createTask(t, deviceId)).body.task.id;
    const offer = await node.waitFor((m) => m.type === "task.offer");
    await run(node, offer);
    await waitState(t, id, "running");
    node.drop();
    await waitState(t, id, "running_unknown");
    const back = await FakeNode.connect(srv.wsUrl, deviceId, keys, { sync: false });
    // As the real node does: resend buffered terminal frame, then sync with no active task.
    back.send({ type: "task.complete", taskId: id, attempt: offer.attempt, seq: 1, result: ok });
    back.send({ type: "task.sync", active: [] });
    await waitState(t, id, "completed");
    await sleep(100);
    assert.equal((await taskView(t, id)).state, "completed");
  } finally {
    await srv.close();
  }
});

test("a dispatching task the node never saw is re-queued and re-offered", async () => {
  const { t, srv, node, deviceId, keys } = await online();
  try {
    const id = (await createTask(t, deviceId)).body.task.id;
    await node.waitFor((m) => m.type === "task.offer");
    node.drop();
    await waitState(t, id, "queued");
    const back = await FakeNode.connect(srv.wsUrl, deviceId, keys);
    const again = await back.waitFor((m) => m.type === "task.offer");
    assert.equal(again.taskId, id);
    assert.equal(again.attempt, 2);
  } finally {
    await srv.close();
  }
});

test("queued tasks survive a node disconnect and are offered on reconnect", async () => {
  const { t, srv, node, deviceId, keys } = await online();
  try {
    const first = (await createTask(t, deviceId)).body.task;
    const queued = (await createTask(t, deviceId)).body.task;
    const offer = await node.waitFor((m) => m.type === "task.offer");
    await run(node, offer);
    node.send({
      type: "task.complete",
      taskId: first.id,
      attempt: offer.attempt,
      seq: 1,
      result: ok,
    });
    await node.waitFor((m) => m.type === "task.offer" && m.taskId === queued.id);
    node.drop();
    await waitState(t, queued.id, "queued");
    const back = await FakeNode.connect(srv.wsUrl, deviceId, keys);
    assert.equal((await back.waitFor((m) => m.type === "task.offer")).taskId, queued.id);
  } finally {
    await srv.close();
  }
});

test("control-plane restart: queue and history are durable; running work becomes unknown; the node reconciles", async () => {
  const first = await online();
  const { t, srv, node, deviceId, keys } = first;
  const doneId = (await createTask(t, deviceId)).body.task.id;
  const o1 = await node.waitFor((m) => m.type === "task.offer");
  await run(node, o1);
  node.send({ type: "task.complete", taskId: doneId, attempt: o1.attempt, seq: 1, result: ok });
  await waitState(t, doneId, "completed");
  const runningId = (await createTask(t, deviceId)).body.task.id;
  const o2 = await node.waitFor((m) => m.type === "task.offer" && m.taskId === runningId);
  await run(node, o2);
  await waitState(t, runningId, "running");
  const queuedId = (await createTask(t, deviceId)).body.task.id;
  await srv.close(); // the control plane goes away (process restart)
  // A new instance on the SAME database.
  const t2 = await createTestApp({
    users: { u_a: person("a"), u_b: person("b") },
    db: t.db,
    realClock: true,
  });
  await t2.tasks.sweep();
  const a2 = t2.as("u_a");
  const get = async (id: string) => ((await (await a2(`/v1/tasks/${id}`)).json()) as any).task;
  assert.equal((await get(doneId)).state, "completed", "history survived");
  assert.equal((await get(queuedId)).state, "queued", "queue survived");
  assert.equal(
    (await get(runningId)).state,
    "running_unknown",
    "truthful: the process may still exist",
  );
  const srv2 = await t2.listen();
  try {
    const back = await FakeNode.connect(srv2.wsUrl, deviceId, keys, {
      sync: [{ taskId: runningId, attempt: o2.attempt }],
    });
    for (let i = 0; i < 100 && (await get(runningId)).state !== "running"; i++) await sleep(15);
    assert.equal((await get(runningId)).state, "running");
    back.send({
      type: "task.complete",
      taskId: runningId,
      attempt: o2.attempt,
      seq: 1,
      result: ok,
    });
    const offer = await back.waitFor((m) => m.type === "task.offer" && m.taskId === queuedId);
    assert.equal(offer.attempt, 1);
  } finally {
    await srv2.close();
  }
});

test("sweeper: unacknowledged offers return to the queue, then fail after repeated attempts; stale queue entries expire", async () => {
  const t = await setupTasks({
    realClock: false,
    tasks: { offerTimeoutMs: 1000, queueTtlMs: 60_000 },
  });
  const srv = await t.listen();
  try {
    const { keys, deviceId } = await pairNode(t, srv.url);
    const node = await FakeNode.connect(srv.wsUrl, deviceId, keys);
    const id = (await createTask(t, deviceId)).body.task.id;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const offer = await node.waitFor((m) => m.type === "task.offer" && m.attempt === attempt);
      assert.equal(offer.attempt, attempt);
      t.clock.now += 2000; // the node never answers
      await t.tasks.sweep();
      if (attempt < 3) {
        assert.equal((await taskView(t, id)).state, "queued");
        await t.channel.kickAll();
      }
    }
    assert.equal((await taskView(t, id)).state, "failed");
    assert.equal((await taskView(t, id)).result.reason, "offer_unacknowledged");
    // Queue TTL: a command can never run unexpectedly hours later.
    node.drop();
    t.clock.now += 1;
    const lateNode = await FakeNode.connect(srv.wsUrl, deviceId, keys, { sync: false });
    const stale = (await createTask(t, deviceId)).body.task.id;
    t.clock.now += 61_000;
    await t.tasks.sweep();
    assert.equal((await taskView(t, stale)).result.reason, "queue_expired");
    lateNode.drop();
  } finally {
    await srv.close();
  }
});

test("cross-account: another account cannot read, list, stream or cancel a task", async () => {
  const { t, srv, deviceId } = await online();
  try {
    const id = (await createTask(t, deviceId)).body.task.id;
    assert.equal((await t.b(`/v1/tasks/${id}`)).status, 404);
    assert.equal((await t.b(`/v1/tasks/${id}/events`)).status, 404);
    assert.equal((await t.b(`/v1/tasks/${id}/cancel`, { method: "POST", json: {} })).status, 404);
    assert.deepEqual(((await (await t.b("/v1/tasks")).json()) as any).tasks, []);
    assert.equal((await taskView(t, id)).state !== "cancelled", true);
    assert.equal(
      (
        await t.b("/v1/tasks", {
          method: "POST",
          json: { targetDeviceId: deviceId, process: proc() },
        })
      ).status,
      404,
    );
    assert.equal((await t.b("/v1/tasks/..%2F..%2Fx")).status, 404);
  } finally {
    await srv.close();
  }
});

test("a compromised node cannot touch another device's task, even in the same account", async () => {
  const t = await setupTasks();
  const srv = await t.listen();
  try {
    const one = await pairNode(t, srv.url, { name: "Node One" });
    const two = await pairNode(t, srv.url, { name: "Node Two" });
    const n1 = await FakeNode.connect(srv.wsUrl, one.deviceId, one.keys);
    const n2 = await FakeNode.connect(srv.wsUrl, two.deviceId, two.keys);
    const id = (await createTask(t, one.deviceId)).body.task.id;
    const offer = await n1.waitFor((m) => m.type === "task.offer");
    // Node Two forges every message for Node One's task.
    n2.send({ type: "task.accept", taskId: id, attempt: offer.attempt });
    n2.send({
      type: "task.event",
      taskId: id,
      attempt: offer.attempt,
      seq: 1,
      event: "process.output",
      payload: { stream: "stdout", text: "forged", bytes: 6 },
    });
    n2.send({ type: "task.complete", taskId: id, attempt: offer.attempt, seq: 2, result: ok });
    n2.send({ type: "task.reject", taskId: id, attempt: offer.attempt, reason: "x" });
    n2.send({ type: "task.sync", active: [{ taskId: id, attempt: offer.attempt }] });
    await sleep(200);
    const view = await taskView(t, id);
    assert.equal(view.state, "dispatching", "untouched: node two is not the target");
    assert.ok(!(await taskEvents(t, id)).some((e) => e.payload?.text === "forged"));
    // The sync claim does not make node two the runner: the server asks it to stop that task.
    assert.ok((await n2.waitFor((m) => m.type === "task.cancel")).taskId === id);
    assert.equal(n2.offers().length, 0);
  } finally {
    await srv.close();
  }
});

test("stale attempts are ignored and the node is told to stop", async () => {
  const { t, srv, node, deviceId } = await online();
  try {
    const id = (await createTask(t, deviceId)).body.task.id;
    const offer = await node.waitFor((m) => m.type === "task.offer");
    node.send({ type: "task.accept", taskId: id, attempt: offer.attempt + 5 });
    await node.waitFor((m) => m.type === "task.cancel" && m.taskId === id);
    node.send({
      type: "task.complete",
      taskId: id,
      attempt: offer.attempt + 5,
      seq: 1,
      result: ok,
    });
    await sleep(100);
    assert.equal((await taskView(t, id)).state, "dispatching");
  } finally {
    await srv.close();
  }
});

test("malformed, oversized, wrongly-typed and unknown task frames close the connection", async () => {
  const t = await setupTasks();
  const srv = await t.listen();
  try {
    const { keys, deviceId } = await pairNode(t, srv.url);
    const frames: Record<string, unknown>[] = [
      { type: "task.accept" },
      { type: "task.accept", taskId: "short", attempt: 1 },
      { type: "task.accept", taskId: "task-12345678", attempt: "1" },
      { type: "task.accept", taskId: "task-12345678", attempt: 1, extra: true },
      {
        type: "task.event",
        taskId: "task-12345678",
        attempt: 1,
        seq: 1,
        event: "process.exec",
        payload: {},
      },
      {
        type: "task.event",
        taskId: "task-12345678",
        attempt: 1,
        seq: 0,
        event: "process.output",
        payload: { stream: "stdout", text: "x", bytes: 1 },
      },
      {
        type: "task.event",
        taskId: "task-12345678",
        attempt: 1,
        seq: 1,
        event: "process.output",
        payload: { stream: "stdin", text: "x", bytes: 1 },
      },
      {
        type: "task.event",
        taskId: "task-12345678",
        attempt: 1,
        seq: 1,
        event: "process.output",
        payload: { stream: "stdout", text: "x".repeat(9000), bytes: 1 },
      },
      {
        type: "task.event",
        taskId: "task-12345678",
        attempt: 1,
        seq: 1,
        event: "process.output",
        payload: { stream: "stdout", text: "x", bytes: 1, run: "id" },
      },
      {
        type: "task.complete",
        taskId: "task-12345678",
        attempt: 1,
        seq: 1,
        result: { exitCode: "0" },
      },
      {
        type: "task.fail",
        taskId: "task-12345678",
        attempt: 1,
        seq: 1,
        reason: "because",
        result: ok,
      },
      { type: "task.sync", active: "all" },
      {
        type: "task.sync",
        active: Array.from({ length: 17 }, () => ({ taskId: "task-12345678", attempt: 1 })),
      },
      { type: "task.exec", command: "id" },
      { type: "task.offer", taskId: "task-12345678", attempt: 1, process: proc() }, // server-only message
    ];
    for (const frame of frames) {
      const node = await FakeNode.connect(srv.wsUrl, deviceId, keys, { sync: false });
      node.send(frame);
      const closed = await node.waitClosed();
      assert.ok(
        [1008, 1009].includes(closed.code),
        `${JSON.stringify(frame).slice(0, 80)} → ${closed.code}`,
      );
    }
  } finally {
    await srv.close();
  }
});

test("oversized output: the control plane enforces a stored-output cap and records the truncation once", async () => {
  const { t, srv, node, deviceId } = await online({ tasks: { maxOutputBytes: 2000 } });
  try {
    const id = (await createTask(t, deviceId)).body.task.id;
    const offer = await node.waitFor((m) => m.type === "task.offer");
    await run(node, offer);
    for (let seq = 1; seq <= 10; seq++) {
      node.send({
        type: "task.event",
        taskId: id,
        attempt: offer.attempt,
        seq,
        event: "process.output",
        payload: { stream: "stdout", text: "z".repeat(500), bytes: 500 },
      });
    }
    node.send({ type: "task.complete", taskId: id, attempt: offer.attempt, seq: 11, result: ok });
    await waitState(t, id, "completed");
    const events = await taskEvents(t, id);
    const stored = events.filter((e) => e.type === "process.output");
    assert.equal(stored.length, 4, "cap of 2000 bytes keeps four 500-byte chunks");
    const markers = events.filter((e) => e.type === "process.truncated");
    assert.equal(markers.length, 1);
    assert.equal(markers[0].payload.by, "control-plane");
  } finally {
    await srv.close();
  }
});

test("revoking a device fails its queued and running tasks and closes its channel", async () => {
  const { t, srv, node, deviceId } = await online();
  try {
    const running = (await createTask(t, deviceId)).body.task.id;
    const offer = await node.waitFor((m) => m.type === "task.offer");
    await run(node, offer);
    const queued = (await createTask(t, deviceId)).body.task.id;
    await waitState(t, running, "running");
    await t.a(`/v1/devices/${deviceId}/revoke`, { method: "POST" });
    await node.waitClosed();
    await t.tasks.sweep();
    for (const id of [running, queued]) {
      const view = await taskView(t, id);
      assert.deepEqual(
        { state: view.state, reason: view.result.reason },
        { state: "failed", reason: "device_revoked" },
      );
    }
  } finally {
    await srv.close();
  }
});

test("an unreconciled node can never receive offers (sync is required first)", async () => {
  const t = await setupTasks();
  const srv = await t.listen();
  try {
    const { keys, deviceId } = await pairNode(t, srv.url);
    const node = await FakeNode.connect(srv.wsUrl, deviceId, keys, { sync: false });
    await createTask(t, deviceId);
    await sleep(200);
    assert.equal(node.offers().length, 0);
    node.send({ type: "task.sync", active: [] });
    await node.waitFor((m) => m.type === "task.offer");
  } finally {
    await srv.close();
  }
});
