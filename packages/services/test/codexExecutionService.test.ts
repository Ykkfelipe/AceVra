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
import {
  CODEX_EXECUTION_POLICY_PRESETS,
  DEFAULT_CODEX_EXECUTION_POLICY,
  resolveCodexExecutionPolicy,
} from "../src/codex/domain/codexPolicy.js";

interface FakeBridgeState {
  installed: boolean;
  generation: number;
  calls: Array<{ method: string; params: unknown }>;
  responses: Array<{ rawId: number; result: unknown }>;
  /** method → result（或 error）。未配置的方法返回 {id: "<method>"}。 */
  results: Map<string, unknown>;
  errors: Map<string, string>;
  /** 可选的动态应答器：返回非 undefined 时优先于 results/errors（用于翻页等有状态形状）。 */
  callOverride?: (method: string, params: unknown) => unknown | undefined;
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
    results: new Map<string, unknown>([
      ["account/read", { account: { type: "chatgpt", email: "u@example.com", planType: "plus" } }],
      // E2E 观察：thread id 嵌套在 result.thread.id；turn id 在 result.turn.id（schema）。
      ["thread/start", { thread: { id: "id-thread-start" } }],
      ["turn/start", { turn: { id: "id-turn-start" } }],
    ]),
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
      const overridden = state.callOverride?.(method, params);
      if (overridden !== undefined) return overridden as T;
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

function makeService(
  bridge = makeBridge(),
  taskIndex = makeTaskIndex(),
  policy = DEFAULT_CODEX_EXECUTION_POLICY,
) {
  const created = createCodexExecutionService({
    bridge: bridge.port,
    taskIndex: taskIndex.port,
    policy,
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
  // 宿主执行策略必须显式下发（安全默认：审批开启 + 只读沙箱），不允许静默走 Codex 默认。
  const threadStart = service.bridge.state.calls.find((call) => call.method === "thread/start");
  assert.ok(threadStart);
  assert.deepEqual(threadStart.params, {
    cwd: "/tmp/ws",
    approvalPolicy: "on-request",
    sandbox: "read-only",
  });
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

test("stop maps to turn/interrupt {threadId, turnId}; unsupported commands are rejected", async () => {
  const service = makeService();
  const created = await service.service.createTask({ workspacePath: "/tmp/ws" });
  const taskId = created.task.taskId;
  // turn id 未知（turn/start 响应缺 turn 字段且无 turn/started 通知）→ 宁可失败也不发缺字段 payload。
  const earlyStop = await service.service.sendConversationCommandV4({
    envelope: { commandId: "c-stop-early", clientId: "client-1", sessionId: taskId, type: "stop", payload: {}, issuedAt: 0 },
  });
  assert.equal(earlyStop.status, "failed");
  assert.equal(earlyStop.reasonCode, "codex_interrupt_no_active_turn");
  // 正常路径：sendText 后 codexTurnId 取自 turn/start 响应 {turn:{id}}。
  await service.service.sendConversationCommandV4({
    envelope: {
      commandId: "c-1b",
      clientId: "client-1",
      sessionId: taskId,
      type: "sendText",
      payload: { text: "long turn" },
      issuedAt: 0,
    },
  });
  const stopAck = await service.service.sendConversationCommandV4({
    envelope: { commandId: "c-2", clientId: "client-1", sessionId: taskId, type: "stop", payload: {}, issuedAt: 0 },
  });
  assert.equal(stopAck.status, "accepted");
  const interrupt = service.bridge.state.calls.find((call) => call.method === "turn/interrupt");
  assert.ok(interrupt, "turn/interrupt must be issued");
  assert.deepEqual(interrupt.params, { threadId: "id-thread-start", turnId: "id-turn-start" });
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

test("turn/started notification backfills the interrupt turn id and turn/completed clears it", async () => {
  const service = makeService();
  const created = await service.service.createTask({ workspacePath: "/tmp/ws" });
  const taskId = created.task.taskId;
  // 响应缺 turn 字段的形状：turnId 只能来自 turn/started 通知。
  service.bridge.state.results.set("turn/start", {});
  await service.service.sendConversationCommandV4({
    envelope: {
      commandId: "c-1c",
      clientId: "client-1",
      sessionId: taskId,
      type: "sendText",
      payload: { text: "streaming" },
      issuedAt: 0,
    },
  });
  for (const handler of service.bridge.state.notifications) {
    handler("turn/started", { threadId: "id-thread-start", turnId: "codex-live-turn" }, undefined);
  }
  const stopAck = await service.service.sendConversationCommandV4({
    envelope: { commandId: "c-2b", clientId: "client-1", sessionId: taskId, type: "stop", payload: {}, issuedAt: 0 },
  });
  assert.equal(stopAck.status, "accepted");
  const interrupt = service.bridge.state.calls.find((call) => call.method === "turn/interrupt");
  assert.deepEqual(interrupt?.params, { threadId: "id-thread-start", turnId: "codex-live-turn" });
  for (const handler of service.bridge.state.notifications) {
    handler("turn/completed", { threadId: "id-thread-start", turnId: "codex-live-turn", status: "ok" }, undefined);
  }
  const lateStop = await service.service.sendConversationCommandV4({
    envelope: { commandId: "c-2c", clientId: "client-1", sessionId: taskId, type: "stop", payload: {}, issuedAt: 0 },
  });
  assert.equal(lateStop.status, "failed");
  assert.equal(lateStop.reasonCode, "codex_interrupt_no_active_turn");
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
  // schema 真形：CommandExecutionApprovalDecision 用 accept/decline，不是 approved/denied。
  assert.deepEqual(service.bridge.state.responses, [{ rawId: 77, result: { decision: "accept" } }]);
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

test("unroutable approval requests fail closed with schema-true denial bodies", async () => {
  const service = makeService();
  const created = await service.service.createTask({ workspacePath: "/tmp/other-ws" });
  // 该任务绑定 id-thread-start；用未知 threadId 制造 unroutable 审批。
  await service.service.sendConversationCommandV4({
    envelope: {
      commandId: "c-r-0",
      clientId: "client-1",
      sessionId: created.task.taskId,
      type: "sendText",
      payload: { text: "trigger" },
      issuedAt: 0,
    },
  });
  for (const handler of service.bridge.state.notifications) {
    handler(
      "item/commandExecution/requestApproval",
      { threadId: "unknown-thread", command: "rm -rf /" },
      { method: "item/commandExecution/requestApproval", params: { threadId: "unknown-thread" }, rawId: 900 },
    );
    handler(
      "item/permissions/requestApproval",
      { threadId: "unknown-thread", permissions: { fileSystem: { read: ["/etc"] } } },
      { method: "item/permissions/requestApproval", params: { threadId: "unknown-thread" }, rawId: 901 },
    );
  }
  assert.deepEqual(service.bridge.state.responses, [
    { rawId: 900, result: { decision: "decline" } },
    { rawId: 901, result: { permissions: {}, scope: "turn" } },
  ]);
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
  // 桥换代：进程重启。resume 返回 {}（E2E 观察形状）；items/list 返回 E2E 观察的
  // {data:[{turnId, item:{…}}]} 包装形状，并带 nextCursor 验证重建翻页跟随。
  service.bridge.state.generation = 2;
  service.bridge.state.results.set("thread/resume", {});
  let itemsPage = 0;
  service.bridge.state.callOverride = (method, params) => {
    if (method !== "thread/items/list") return undefined;
    const cursor = (params as { cursor?: string }).cursor;
    if (itemsPage === 0 && !cursor) {
      itemsPage = 1;
      return {
        data: [{ turnId: "turn-hist", item: { type: "agentMessage", id: "hist-1", text: "history answer" } }],
        nextCursor: "cursor-2",
        backwardsCursor: null,
      };
    }
    assert.equal(cursor, "cursor-2", "second history page must follow nextCursor");
    itemsPage = 2;
    return {
      data: [{ turnId: "turn-hist", item: { type: "agentMessage", id: "hist-2", text: "page two" } }],
      nextCursor: null,
      backwardsCursor: null,
    };
  };
  service.bridge.state.results.set("thread/items/list", {
    data: [
      {
        turnId: "turn-hist",
        item: { type: "agentMessage", id: "hist-1", text: "history answer" },
      },
    ],
    nextCursor: null,
    backwardsCursor: null,
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
  // resume 必须 excludeTurns:true（schema 推荐，全量 hydration 已废弃）并重申宿主策略。
  const resume = service.bridge.state.calls.find((call) => call.method === "thread/resume");
  assert.deepEqual(resume?.params, {
    threadId: "id-thread-start",
    approvalPolicy: "on-request",
    sandbox: "read-only",
    excludeTurns: true,
  });
  // 恢复的历史行可经 rowsRange 读取（E2E 观察的 {turnId, item} 包装必须被解包 + 翻页齐全）。
  const rows = await service.service.conversationRowsRangeV4({ sessionId: taskId, limit: 10 });
  const historyTexts = rows.rows.filter((row) => row.kind === "assistantText").map((row) => row.text);
  assert.deepEqual(historyTexts.sort(), ["history answer", "page two"]);
  dispose.dispose();
});

test("execution policy resolves by preset name and fails closed on unknown names", () => {
  assert.deepEqual(resolveCodexExecutionPolicy(null).policy, CODEX_EXECUTION_POLICY_PRESETS.safeInteractive);
  assert.deepEqual(resolveCodexExecutionPolicy(undefined).adoptedDefault, false);
  assert.deepEqual(resolveCodexExecutionPolicy("workspaceWrite").policy, {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
  // 显式指名才可达 unrestricted；未知名称回落默认并标记 adoptedDefault。
  assert.deepEqual(resolveCodexExecutionPolicy("unrestricted").policy, CODEX_EXECUTION_POLICY_PRESETS.unrestricted);
  const unknown = resolveCodexExecutionPolicy("yolo");
  assert.deepEqual(unknown.policy, DEFAULT_CODEX_EXECUTION_POLICY);
  assert.equal(unknown.adoptedDefault, true);
});
