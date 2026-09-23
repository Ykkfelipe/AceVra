/**
 * stdio 协议解析失败 vs 分发失败的语义回归，以及 browser-use 反向请求处理器的错误边界（零推理、零真实进程）。
 *
 * 背景：artifact 包装器丢失 executor.list 后，host 的 interaction/browserList handler 同步抛 TypeError，
 * ZCodeStdioTransport 把它当成 protocol_parse_error 关掉整个 agent 连接。这里锁定：
 * - 畸形 JSON / 非法帧仍按 protocol_parse_error 关闭连接
 * - 合法请求的 handler 抛错 → 回复 -32603，不是 protocol_parse_error，连接保持可用
 * - 随后的合法请求正常成功
 * - 通知 handler 抛错只记录，不发明回复，不断开
 * - browserList / browserExecute 的同步抛错与异步 reject 归一为同一结构化错误回复
 *
 * Run: mise exec -- node --import tsx --test packages/services/test/zcodeProtocolDispatch.test.ts
 */
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ZCodeProtocolClient } from "../src/zcode-agent/zcodeProtocolClient.js";
import { ZCodeStdioTransport } from "../src/zcode-agent/zcodeStdioTransport.js";
import {
  handleBrowserExecuteRequest,
  handleBrowserListRequest,
} from "../src/zcode-agent/zcodeAgentBrowserRpc.js";
import type { BrowserAmbientContextExecutor } from "../src/zcode-agent/zcodeAgentBrowserAmbientContext.js";

interface FakeAgent {
  child: ChildProcessWithoutNullStreams;
  /** 以 agent 身份向 host 写一帧（host 的 stdout 视角）。 */
  emitFrame(frame: string): void;
  /** host 写给 agent 的帧（host 的 stdin 视角）。 */
  sent: Array<Record<string, unknown>>;
}

function createFakeAgent(): FakeAgent {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const sent: Array<Record<string, unknown>> = [];
  let pending = "";
  stdin.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    let index = pending.indexOf("\n");
    while (index >= 0) {
      sent.push(JSON.parse(pending.slice(0, index)) as Record<string, unknown>);
      pending = pending.slice(index + 1);
      index = pending.indexOf("\n");
    }
  });
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    killed: false,
    exitCode: null,
    signalCode: null,
    pid: undefined,
  }) as unknown as ChildProcessWithoutNullStreams;
  return { child, sent, emitFrame: (frame) => stdout.write(`${frame}\n`) };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function setup() {
  const agent = createFakeAgent();
  const transport = new ZCodeStdioTransport(agent.child);
  const client = new ZCodeProtocolClient(transport);
  const closes: Array<{ reason?: string }> = [];
  transport.onClose((event) => closes.push(event));
  return { agent, transport, client, closes };
}

test("malformed JSON frame still closes the connection as protocol_parse_error", async () => {
  const { agent, closes, client } = setup();
  agent.emitFrame("{not json");
  await settle();
  assert.equal(closes.length, 1);
  assert.match(closes[0]?.reason ?? "", /^protocol_parse_error: /u);
  assert.equal(agent.sent.length, 0, "a parse failure must not invent a reply");
  client.dispose();
});

test("schema-invalid frame still closes the connection as protocol_parse_error", async () => {
  const { agent, closes, client } = setup();
  agent.emitFrame(JSON.stringify({ jsonrpc: "nope", id: {}, method: 42 }));
  await settle();
  assert.equal(closes.length, 1);
  assert.match(closes[0]?.reason ?? "", /^protocol_parse_error: /u);
  client.dispose();
});

test("a throwing request handler replies -32603, keeps the connection, and the next request succeeds", async () => {
  const { agent, closes, client } = setup();
  let throwNext = true;
  client.onRequest((request) => {
    if (throwNext) {
      throwNext = false;
      // 复现原始缺陷：包装器缺 list 时 host handler 同步抛 TypeError。
      throw new TypeError("executor.list is not a function");
    }
    void client.respond(request.id, { browsers: [] });
  });

  agent.emitFrame(
    JSON.stringify({
      id: 7,
      method: "interaction/browserList",
      params: { requestId: "r", sessionId: "s" },
    }),
  );
  await settle();
  assert.deepEqual(closes, [], "handler failure must not close the transport");
  assert.equal(client.isDisposed, false);
  assert.equal(agent.sent.length, 1);
  const errorReply = agent.sent[0] as { id: unknown; error?: { code: number; message: string } };
  assert.equal(errorReply.id, 7);
  assert.equal(errorReply.error?.code, -32603);
  assert.match(errorReply.error?.message ?? "", /executor\.list is not a function/u);
  assert.doesNotMatch(errorReply.error?.message ?? "", /protocol_parse_error/u);

  agent.emitFrame(
    JSON.stringify({
      id: 8,
      method: "interaction/browserList",
      params: { requestId: "r2", sessionId: "s" },
    }),
  );
  await settle();
  assert.deepEqual(closes, []);
  assert.deepEqual(agent.sent[1], { id: 8, result: { browsers: [] } });

  // 连接仍可双向使用：host → agent 请求照常得到响应。
  const outbound = client.request("ping/test", {});
  await settle();
  const outboundFrame = agent.sent[2] as { id: number; method: string };
  assert.equal(outboundFrame.method, "ping/test");
  agent.emitFrame(JSON.stringify({ id: outboundFrame.id, result: { pong: true } }));
  assert.deepEqual(await outbound, { pong: true });
  client.dispose();
});

test("a throwing notification handler is logged only: no reply, connection stays open", async () => {
  const { agent, closes, client } = setup();
  let notifications = 0;
  client.onNotification(() => {
    notifications += 1;
    if (notifications === 1) throw new Error("notification handler bug");
  });
  agent.emitFrame(JSON.stringify({ method: "session/event", params: { a: 1 } }));
  agent.emitFrame(JSON.stringify({ method: "session/event", params: { a: 2 } }));
  await settle();
  assert.equal(notifications, 2, "later frames keep being dispatched");
  assert.deepEqual(closes, []);
  assert.equal(agent.sent.length, 0, "notifications have no id, so no reply may be invented");
  client.dispose();
});

type Replies = Array<{ kind: "result" | "error"; id: unknown; payload: unknown }>;

function recordingResponder(replies: Replies) {
  return {
    async respond(id: string | number, result: unknown) {
      replies.push({ kind: "result", id, payload: result });
    },
    async respondError(id: string | number, error: unknown) {
      replies.push({ kind: "error", id, payload: error });
    },
  };
}

function executorWith(
  list: BrowserAmbientContextExecutor["list"],
  execute: BrowserAmbientContextExecutor["execute"],
): BrowserAmbientContextExecutor {
  return { list, execute };
}

const LIST_PARAMS = {
  requestId: "req-1",
  sessionId: "sess-1",
  workspaceKey: "/tmp/ws",
  workspacePath: "/tmp/ws",
  clientMode: "desktop-continuous",
  sessionContext: "live",
};
const EXECUTE_PARAMS = {
  requestId: "req-2",
  sessionId: "sess-1",
  command: { method: "capabilities" },
};

test("browserList: synchronous throw and asynchronous rejection yield the same structured error", async () => {
  const syncReplies: Replies = [];
  const asyncReplies: Replies = [];
  const failure = "executor.list is not a function";
  let listCalls = 0;
  assert.doesNotThrow(() =>
    handleBrowserListRequest({
      client: recordingResponder(syncReplies),
      executor: executorWith(
        () => {
          listCalls += 1;
          throw new TypeError(failure);
        },
        async () => ({ ok: true }),
      ),
      requestId: 1,
      params: LIST_PARAMS,
    }),
  );
  handleBrowserListRequest({
    client: recordingResponder(asyncReplies),
    executor: executorWith(
      () => {
        listCalls += 1;
        return Promise.reject(new TypeError(failure));
      },
      async () => ({ ok: true }),
    ),
    requestId: 1,
    params: LIST_PARAMS,
  });
  await settle();
  assert.equal(listCalls, 2, "params must be valid so the executor is actually reached");
  assert.deepEqual(syncReplies, [
    { kind: "error", id: 1, payload: { code: -32603, message: failure } },
  ]);
  assert.deepEqual(asyncReplies, syncReplies);
});

test("browserList: success passes executor output through", async () => {
  const replies: Replies = [];
  const browsers = [{ browserId: "b-1" }];
  handleBrowserListRequest({
    client: recordingResponder(replies),
    executor: executorWith(
      async () => browsers as never,
      async () => ({ ok: true }),
    ),
    requestId: 2,
    params: LIST_PARAMS,
  });
  await settle();
  assert.deepEqual(replies, [{ kind: "result", id: 2, payload: { browsers } }]);
});

test("browserExecute: synchronous throw and asynchronous rejection yield the same execution_error", async () => {
  const syncReplies: Replies = [];
  const asyncReplies: Replies = [];
  const workspace = { workspacePath: "/tmp/ws" };
  const commandSchemaCheck: Replies = [];
  handleBrowserExecuteRequest({
    client: recordingResponder(commandSchemaCheck),
    executor: executorWith(
      async () => [],
      async () => ({ ok: true }),
    ),
    requestId: 0,
    params: EXECUTE_PARAMS,
    workspace,
  });
  await settle();
  assert.deepEqual(
    commandSchemaCheck,
    [{ kind: "result", id: 0, payload: { ok: true } }],
    `fixture params must pass the schema: ${JSON.stringify(commandSchemaCheck)}`,
  );

  assert.doesNotThrow(() =>
    handleBrowserExecuteRequest({
      client: recordingResponder(syncReplies),
      executor: executorWith(
        async () => [],
        () => {
          throw new Error("cdp detached");
        },
      ),
      requestId: 3,
      params: EXECUTE_PARAMS,
      workspace,
    }),
  );
  handleBrowserExecuteRequest({
    client: recordingResponder(asyncReplies),
    executor: executorWith(
      async () => [],
      () => Promise.reject(new Error("cdp detached")),
    ),
    requestId: 3,
    params: EXECUTE_PARAMS,
    workspace,
  });
  await settle();
  assert.deepEqual(syncReplies, [
    {
      kind: "result",
      id: 3,
      payload: {
        ok: false,
        error: { code: "execution_error", message: "cdp detached" },
        elapsedMs: 0,
      },
    },
  ]);
  assert.deepEqual(asyncReplies, syncReplies);
});

test("browserExecute: executor receives defaulted params and the workspaceIdentity fallback", async () => {
  const replies: Replies = [];
  const received: unknown[] = [];
  handleBrowserExecuteRequest({
    client: recordingResponder(replies),
    executor: executorWith(
      async () => [],
      async (input) => {
        received.push(input);
        return { ok: true };
      },
    ),
    requestId: 4,
    params: { ...EXECUTE_PARAMS, turnId: "turn-1", remoteSessionId: "remote-1" },
    workspace: { workspacePath: "/tmp/ws", workspaceIdentity: "remote://host/ws" },
  });
  await settle();
  assert.deepEqual(received, [
    {
      requestId: "req-2",
      sessionId: "sess-1",
      turnId: "turn-1",
      workspaceKey: "remote://host/ws",
      workspacePath: "/tmp/ws",
      workspaceIdentity: "remote://host/ws",
      remoteSessionId: "remote-1",
      clientMode: "desktop-continuous",
      sessionContext: "live",
      command: { method: "capabilities" },
    },
  ]);
  assert.deepEqual(replies, [{ kind: "result", id: 4, payload: { ok: true } }]);
});
