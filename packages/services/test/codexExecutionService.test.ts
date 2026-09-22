/**
 * Codex 执行后端 — 服务层回归测试（fake bridge + fake task index，不触达 Codex，零推理）。
 *
 * 固定语义：
 * - createTask：account 门禁 fail closed、thread/start 取 id、meta 持久化
 *   executionBackend/codexThreadId、firstInput 立即 turn/start，
 * - sendText/stop/resolveInteraction/renameSession 的 v4 命令映射与 ACK 形状，
 * - 不支持的命令一律 rejected（fault.command.unsupportedBackend），
 * - 审批：服务器请求登记 → pendingInteraction 下发 → 决定回传 rawId（bridge.respond），
 * - 桥换代（generation bump）：runtime stale → 经 thread/resume 重建投影（logEpoch 更换）。
 *
 * Run: mise exec -- node --import tsx --test packages/services/test/codexExecutionService.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import type { CodexAppServerPort, CodexTaskIndexPort } from "../src/codex/app/codexPorts.js";
import { createCodexExecutionService } from "../src/codex/app/codexExecutionServiceImpl.js";

interface FakeBridgeState {
  installed: boolean;
  generation: number;
  calls: Array<{ method: string; params: unknown }>;
  responses: Array<{ rawId: number; result: unknown }>;
  /** method → result（或 error）。未配置的方法返回 {id: "<method>"}。 */
  results: Map<string, unknown>;
  errors: Map<string, string>;
  notifications: Array<(method: string, params: unknown, rawRequest?: { method: string; params: unknown; rawId: number }) => void>;
}

function makeBridge(overrides: Partial<FakeBridgeState> = {}): {
  port: CodexAppServerPort;
  state: FakeBridgeState;
} {
  const state: FakeBridgeState = {
    installed: true,
    generation: 1,
    calls: [],
    responses: [],
    results: new Map([["account/read", { account: { type: "chatgpt", email: "u@example.com", planType: "plus" } }]]),
    errors: new Map(),
    notifications: [],
    ...overrides,
  };
  const port: CodexAppServerPort = {
    get installed() {
      return state.installed;
    },
    get generation() {
      return state.generation;
    },
    async call<T>(method: string, params: unknown = {}): Promise<T> {
      state.calls.push({ method, params });
      const error = state.errors.get(method);
      if (error) throw new Error(error);
      const configured = state.results.get(method);
      return (configured ?? { id: `id-${method.replace("/", "-")}` }) as T;
    },
    respond(rawId: number, result: unknown): void {
      state.responses.push({ rawId, result });
    },
    onNotification(handler): () => void {
      state.notifications.push(
        handler as (method: string, params: unknown, rawRequest?: { method: string; params: unknown; rawId: number }) => void,
      );
      return () => {};
    },
  };
  return { port, state };
}

function makeTaskIndex() : { port: CodexTaskIndexPort; rows: Map<string, ZCodeTaskMeta> } {
  const rows = new Map<string, ZCodeTaskMeta>();
  return {
    rows,
    port: {
      async syncTaskMeta(params) {
        rows.set(params.meta.taskId, params.meta);
        return params.meta;
      },
      async updateTaskState(params) {
        const existing = rows.get(params.taskId);
        if (existing) {
          const next: ZCodeTaskMeta = { ...existing, ...params.patch };
          rows.set(params.taskId, next);
        }
        return rows.get(params.taskId)!;
      },
      async getTaskMeta(params) {
        return rows.get(params.taskId) ?? null;
      },
      async listTaskMetas() {
        return [...rows.values()];
      },
    },
  };
}

function makeService(bridge = makeBridge(), taskIndex = makeTaskIndex()) {
  const created = createCodexExecutionService({
    bridge: bridge.port,
    taskIndex: taskIndex.port,
  });
  return { ...created, bridge, taskIndex };
}

function frameLog(frames: ConversationTopicFrame[], subscriptionId?: string): ConversationTopicFrame[] {
  return frames.filter((frame) => !subscriptionId || frame.subscriptionId === subscriptionId);
}

test("createTask fails closed without a signed-in Codex account", async () => {
  const service = makeService();
  service.bridge.state.results.set("account/read", { account: null, requiresOpenaiAuth: true });
  await assert.rejects(
    service.service.createTask({ workspacePath: "/tmp/ws", firstInput: "hi" }),
    /codex_not_signed_in/,
  );
});

test("createTask persists the harness task ↔ codex thread binding and starts the first turn", async () => {
  const service = makeService();
  const result = await service.service.createTask({ workspacePath: "/tmp/ws", firstInput: "fix the bug" });
  const taskId = result.task.taskId;
  assert.equal(result.task.executionBackend, "codex");
  assert.equal(result.task.codexThreadId, "id-thread-start");
  const meta = service.taskIndex.rows.get(taskId);
  assert.equal(meta?.executionBackend, "codex");
  assert.equal(meta?.codexThreadId, "id-thread-start");
  assert.equal(meta?.title, "fix the bug");
  assert.ok(service.bridge.state.calls.some((call) => call.method === "thread/start"));
  assert.ok(
    service.bridge.state.calls.some(
      (call) => call.method === "turn/start" && JSON.stringify(call.params).includes("fix the bug"),
    ),
  );
  // 订阅后 initial snapshot 必须包含首发 userInput 行。
  await new Promise((resolve) => setTimeout(resolve, 10));
  const frames: ConversationTopicFrame[] = [];
  const off = service.service.onDynamicConversationFrame();
  const dispose = off((frame) => frames.push(frame));
  const subscribeAck = await service.service.subscribeConversationV4({ topic: `conversation/${taskId}` });
  await new Promise((resolve) => setTimeout(resolve, 10));
  dispose.dispose();
  const snapshots = frameLog(frames, subscribeAck.ack.subscriptionId).filter(
    (frame) => frame.payload.kind === "snapshot",
  );
  assert.ok(snapshots.length > 0);
  const snapshot = snapshots[0]!.payload.kind === "snapshot" ? snapshots[0]!.payload.snapshot : null;
  assert.ok(snapshot?.rows.window.some((row) => row.kind === "userInput" && row.text === "fix the bug"));
  assert.equal(await service.service.isCodexTask(taskId), true);
  assert.equal(await service.service.isCodexTask("unknown-id"), false);
});

test("sendText over the v4 envelope maps to turn/start and is acknowledged", async () => {
  const service = makeService();
  const created = await service.service.createTask({ workspacePath: "/tmp/ws" });
  const taskId = created.task.taskId;
  const frames: ConversationTopicFrame[] = [];
  const dispose = service.service.onDynamicConversationFrame()((frame) => frames.push(frame));
  const subscribeAck = await service.service.subscribeConversationV4({ topic: `conversation/${taskId}` });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const ack = await service.service.sendConversationCommandV4({
    envelope: {
      commandId: "c-1",
      clientId: "client-1",
      sessionId: taskId,
      type: "sendText",
      payload: { text: "second turn" },
      issuedAt: 0,
    },
  });
  assert.equal(ack.status, "accepted");
  assert.equal(ack.result?.type, "inputAccepted");
  assert.ok(
    service.bridge.state.calls.some((call) => call.method === "turn/start"),
    "turn/start must be issued",
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  // P0 回归守卫：store 只应用 fromSeq === 当前水位的 deltas 帧。snapshot 帧 fromSeq=0，
  // 其后的 deltas 帧必须是 (snapshotSeq, snapshotSeq+1]，否则流式增量会退化成 recovery 风暴。
  const mine = frameLog(frames, subscribeAck.ack.subscriptionId);
  const snapshot = mine.find((frame) => frame.payload.kind === "snapshot");
  const deltas = mine.filter((frame) => frame.payload.kind === "deltas");
  assert.ok(snapshot && deltas.length > 0);
  assert.equal(snapshot.fromSeq, 0);
  assert.deepEqual(
    deltas.map((frame) => [frame.fromSeq, frame.toSeq]),
    deltas.map((frame) => [frame.toSeq - 1, frame.toSeq]),
  );
  assert.equal(deltas[0]!.fromSeq, snapshot.toSeq);
  dispose.dispose();
});

test("stop maps to turn/interrupt; unsupported commands are rejected", async () => {
  const service = makeService();
  const created = await service.service.createTask({ workspacePath: "/tmp/ws" });
  const taskId = created.task.taskId;
  const stopAck = await service.service.sendConversationCommandV4({
    envelope: { commandId: "c-2", clientId: "client-1", sessionId: taskId, type: "stop", payload: {}, issuedAt: 0 },
  });
  assert.equal(stopAck.status, "accepted");
  assert.ok(service.bridge.state.calls.some((call) => call.method === "turn/interrupt"));
  const forkAck = await service.service.sendConversationCommandV4({
    envelope: {
      commandId: "c-3",
      clientId: "client-1",
      sessionId: taskId,
      type: "forkAssistant",
      payload: { target: { rowId: 1, entityId: "e" } },
      issuedAt: 0,
    },
  });
  assert.equal(forkAck.status, "rejected");
  assert.equal(forkAck.reasonCode, "fault.command.unsupportedBackend");
});

test("approval server requests reach the harness and decisions answer the raw request id", async () => {
  const service = makeService();
  const created = await service.service.createTask({ workspacePath: "/tmp/ws" });
  const taskId = created.task.taskId;
  await service.service.sendConversationCommandV4({
    envelope: {
      commandId: "c-4",
      clientId: "client-1",
      sessionId: taskId,
      type: "sendText",
      payload: { text: "run something" },
      issuedAt: 0,
    },
  });
  // 模拟 app-server 的审批服务器请求。
  for (const handler of service.bridge.state.notifications) {
    handler("item/commandExecution/requestApproval", { threadId: "id-thread-start", command: "rm -rf build" }, {
      method: "item/commandExecution/requestApproval",
      params: { threadId: "id-thread-start", command: "rm -rf build" },
      rawId: 77,
    });
  }
  const info = await service.service.listTasks();
  assert.equal(info.tasks.length, 1);
  // 通过 v4 resolveInteraction 命令应答。
  const interactions = await (async () => {
    const frames: ConversationTopicFrame[] = [];
    const dispose = service.service.onDynamicConversationFrame()((frame) => frames.push(frame));
    const subscribeAck = await service.service.subscribeConversationV4({ topic: `conversation/${taskId}` });
    // initial frame 由服务端 queueMicrotask 投递，先让出再退订。
    await new Promise((resolve) => setTimeout(resolve, 10));
    dispose.dispose();
    const latest = frames
      .filter(
        (frame) =>
          frame.subscriptionId === subscribeAck.ack.subscriptionId &&
          frame.payload.kind === "snapshot",
      )
      .at(-1);
    return latest && latest.payload.kind === "snapshot" ? latest.payload.snapshot.pendingInteractions : [];
  })();
  assert.equal(interactions.length, 1);
  const interactionId = interactions[0]!.interactionId;
  const ack = await service.service.sendConversationCommandV4({
    envelope: {
      commandId: "c-5",
      clientId: "client-1",
      sessionId: taskId,
      type: "resolveInteraction",
      payload: { interactionId, answer: { optionId: "approved" } },
      issuedAt: 0,
    },
  });
  assert.equal(ack.status, "accepted");
  assert.deepEqual(service.bridge.state.responses, [{ rawId: 77, result: { decision: "approved" } }]);
  // 决议后 pendingInteractions 清空；未知 interactionId 拒绝。
  const replay = await service.service.sendConversationCommandV4({
    envelope: {
      commandId: "c-6",
      clientId: "client-1",
      sessionId: taskId,
      type: "resolveInteraction",
      payload: { interactionId, answer: { optionId: "approved" } },
      issuedAt: 0,
    },
  });
  assert.equal(replay.status, "rejected");
  assert.equal(replay.reasonCode, "codex_approval_unknown_interaction");
});

test("unsupported commands without a session are rejected; renameSession updates the title", async () => {
  const service = makeService();
  const noSession = await service.service.sendConversationCommandV4({
    envelope: { commandId: "c-7", clientId: "client-1", sessionId: null, type: "sendText", payload: { text: "x" }, issuedAt: 0 },
  });
  assert.equal(noSession.status, "rejected");
  const created = await service.service.createTask({ workspacePath: "/tmp/ws", title: "my task" });
  const taskId = created.task.taskId;
  await service.service.sendConversationCommandV4({
    envelope: {
      commandId: "c-8",
      clientId: "client-1",
      sessionId: taskId,
      type: "renameSession",
      payload: { title: "renamed" },
      issuedAt: 0,
    },
  });
  assert.equal(service.taskIndex.rows.get(taskId)?.title, "renamed");
});

test("bridge generation bump marks runtimes stale; subscribe rebuilds via thread/resume", async () => {
  const service = makeService();
  const created = await service.service.createTask({ workspacePath: "/tmp/ws" });
  const taskId = created.task.taskId;
  const frames: ConversationTopicFrame[] = [];
  const dispose = service.service.onDynamicConversationFrame()((frame) => frames.push(frame));
  // 桥换代：进程重启。resume 配置返回同 id；items/list 返回历史条目。
  service.bridge.state.generation = 2;
  service.bridge.state.results.set("thread/items/list", {
    items: [{ type: "agentMessage", id: "hist-1", text: "history answer" }],
  });
  const subscribeAck = await service.service.subscribeConversationV4({ topic: `conversation/${taskId}` });
  assert.equal(subscribeAck.ack.mode, "snapshot");
  assert.equal(subscribeAck.ack.logEpoch, "codex-2");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const snapshots = frameLog(frames, subscribeAck.ack.subscriptionId).filter(
    (frame) => frame.payload.kind === "snapshot",
  );
  assert.ok(snapshots.length > 0, "rebuilt snapshot must arrive");
  const snapshot = snapshots[0]!.payload.kind === "snapshot" ? snapshots[0]!.payload.snapshot : null;
  assert.ok(snapshot);
  assert.equal(snapshot.logEpoch, "codex-2");
  assert.ok(
    service.bridge.state.calls.some((call) => call.method === "thread/resume"),
    "thread/resume must be issued after a generation bump",
  );
  // 恢复的历史行可经 rowsRange 读取。
  const rows = await service.service.conversationRowsRangeV4({ sessionId: taskId, limit: 10 });
  assert.ok(rows.rows.some((row) => row.kind === "assistantText"));
  dispose.dispose();
});
