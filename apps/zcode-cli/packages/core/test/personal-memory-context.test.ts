/**
 * Personal Bot M2 Phase 2 —— personal_memory_context 的 runtime 注入。
 *
 * 覆盖验收要求：
 * - 相关记忆注入 personal_bot 轮次；
 * - 无匹配/空上下文零注入；
 * - RPC/port 失败 fail-open，turn 不受影响；
 * - 非 personal_bot 会话永不注入（并且不产生 host 往返）；
 * - 重复轮次不堆积同一份正文（按正文去重）；
 * - CLI 侧不产生记忆选择：只搬运 port 给的文本。
 *
 * Run: mise exec -- node --import tsx --test apps/zcode-cli/packages/core/test/personal-memory-context.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PersonalMemoryContextPort, TraceContext } from "@zcode/contracts";
import { createMessageHistory } from "../src/agent/message-history.js";
import { injectPersonalMemoryContextFromTurn } from "../src/runtime/methods/personal-memory-context.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

const TRACE = { traceId: "trace_mem", sessionId: "sess_bot", turnId: "turn_1" } as unknown as TraceContext;

const RENDERED_CONTEXT =
  "Personal memory (remembered from earlier conversations with this user; only entries relevant to the current request):\n- [goal] Ship the Bot conversation — voice notes come later";

function fakeRuntime(options: {
  taskType?: string;
  port?: Partial<PersonalMemoryContextPort> | undefined;
}) {
  const history = createMessageHistory();
  const logs: { message: string; data: Record<string, unknown> }[] = [];
  const runtime = {
    config: { taskType: options.taskType ?? "personal_bot" },
    messageHistory: history,
    ...(options.port ? { personalMemoryPort: options.port } : {}),
    logger: {
      debug: (message: string, data: Record<string, unknown>) => logs.push({ message, data }),
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  } as unknown as AgentRuntimeInternal;
  return { runtime, history, logs };
}

function attachments(history: ReturnType<typeof createMessageHistory>): string[] {
  return history
    .borrowReadOnlyRuntimeEntries()
    .flatMap((entry) => ("kind" in entry && entry.kind === "attachment" ? [entry.content] : []));
}

test("relevant memory is injected for a personal_bot turn", async () => {
  const calls: { query: string; turnId?: string }[] = [];
  const { runtime, history } = fakeRuntime({
    port: {
      requestContext: async (request) => {
        calls.push({ query: request.query, ...(request.turnId ? { turnId: request.turnId } : {}) });
        return { text: RENDERED_CONTEXT, omittedCount: 3, byteLength: 118 };
      },
    },
  });

  await injectPersonalMemoryContextFromTurn(runtime, {
    userInput: "what was my goal?",
    traceContext: TRACE,
  });

  assert.deepEqual(attachments(history), [RENDERED_CONTEXT]);
  // 查询用的是本轮规范用户输入，并带上 turnId 供诊断关联。
  assert.deepEqual(calls, [{ query: "what was my goal?", turnId: "turn_1" }]);
});

test("an empty or missing context injects nothing", async () => {
  const empty = fakeRuntime({ port: { requestContext: async () => null } });
  await injectPersonalMemoryContextFromTurn(empty.runtime, {
    userInput: "hello",
    traceContext: TRACE,
  });
  assert.deepEqual(attachments(empty.history), []);

  // 只有空白字符也算“没有相关记忆”。
  const blank = fakeRuntime({
    port: { requestContext: async () => ({ text: "   \n ", omittedCount: 0, byteLength: 4 }) },
  });
  await injectPersonalMemoryContextFromTurn(blank.runtime, {
    userInput: "hello",
    traceContext: TRACE,
  });
  assert.deepEqual(attachments(blank.history), []);
});

test("a failing port fails open and never throws", async () => {
  const { runtime, history, logs } = fakeRuntime({
    port: {
      requestContext: async () => {
        throw new Error("host unavailable");
      },
    },
  });

  // 不抛 = turn 不会被记忆检索挡住。
  await injectPersonalMemoryContextFromTurn(runtime, {
    userInput: "hello",
    traceContext: TRACE,
  });

  assert.deepEqual(attachments(history), []);
  assert.equal(
    logs.some((entry) => entry.data.event === "personal_memory.context.failed"),
    true,
    "the failure must be observable in debug logs",
  );
});

test("non-personal_bot sessions never get memory and never call the host", async () => {
  for (const taskType of ["interactive", "fork", "workflow_parent", "subagent_child"]) {
    let called = 0;
    const { runtime, history } = fakeRuntime({
      taskType,
      port: {
        requestContext: async () => {
          called += 1;
          return { text: RENDERED_CONTEXT, omittedCount: 0, byteLength: 118 };
        },
      },
    });

    await injectPersonalMemoryContextFromTurn(runtime, {
      userInput: "hello",
      traceContext: TRACE,
    });

    assert.deepEqual(attachments(history), [], `${taskType} must not receive Bot memory`);
    assert.equal(called, 0, `${taskType} must not even reach the host`);
  }
});

test("repeated turns do not accumulate duplicate blocks", async () => {
  let served = 0;
  const { runtime, history } = fakeRuntime({
    port: {
      requestContext: async () => {
        served += 1;
        return { text: RENDERED_CONTEXT, omittedCount: 0, byteLength: 118 };
      },
    },
  });

  await injectPersonalMemoryContextFromTurn(runtime, { userInput: "a", traceContext: TRACE });
  await injectPersonalMemoryContextFromTurn(runtime, { userInput: "b", traceContext: TRACE });
  await injectPersonalMemoryContextFromTurn(runtime, { userInput: "c", traceContext: TRACE });

  // 每轮都问了 host（上下文可能变），但同一份正文只进历史一次。
  assert.equal(served, 3);
  assert.deepEqual(attachments(history), [RENDERED_CONTEXT]);
});

test("a changed context is appended while the old one stays in history", async () => {
  let turn = 0;
  const { runtime, history } = fakeRuntime({
    port: {
      requestContext: async () => {
        turn += 1;
        return { text: `block-${turn}`, omittedCount: 0, byteLength: 8 };
      },
    },
  });

  await injectPersonalMemoryContextFromTurn(runtime, { userInput: "a", traceContext: TRACE });
  await injectPersonalMemoryContextFromTurn(runtime, { userInput: "b", traceContext: TRACE });

  assert.deepEqual(attachments(history), ["block-1", "block-2"]);
});

test("a missing port is a no-op, not a failure", async () => {
  const { runtime, history } = fakeRuntime({});
  await injectPersonalMemoryContextFromTurn(runtime, {
    userInput: "hello",
    traceContext: TRACE,
  });
  assert.deepEqual(attachments(history), []);
});
