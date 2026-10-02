/**
 * capability_context 的 runtime 注入：零开销主路径、按正文去重、目标列表有界且不编造、
 * 每轮度量。
 *
 * Run: mise exec -- node --import tsx --test apps/zcode-cli/packages/core/test/capability-context-runtime.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sanitizeZCodeRuntimeEnv,
  resetCapturedZCodeCuaBrokerCredentialsForTest,
} from "@zcode/shared";
import { CoreErrorType } from "@zcode/contracts";
import type { ExecutionTargetInfo, ModelToolContract, TraceContext } from "@zcode/contracts";
import { createMessageHistory } from "../src/agent/message-history.js";
import {
  buildRuntimeCapabilitySnapshot,
  injectCapabilityContextFromTurn,
} from "../src/runtime/methods/capability-context.js";
import {
  flushCapabilityTurnMetrics,
  recordCapabilityToolResults,
  startCapabilityTurnMetrics,
} from "../src/runtime/methods/capability-metrics.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { ToolExecutionResult } from "../src/tool/types.js";

const TRACE = { traceId: "trace_cap", sessionId: "sess_cap" } as unknown as TraceContext;

function fakeRuntime(options: {
  tools?: string[];
  listTargets?: () => Promise<{ ok: true; targets: ExecutionTargetInfo[] }>;
}) {
  const history = createMessageHistory();
  const logs: { message: string; data: Record<string, unknown> }[] = [];
  const tools: ModelToolContract[] = (options.tools ?? ["Read", "Bash", "js"]).map((name) => ({
    name,
    inputSchema: { type: "object" },
  }));
  const runtime = {
    config: { runtimeFeatures: { computerUse: true, nodeRepl: true }, taskType: "interactive" },
    getTools: () => tools,
    messageHistory: history,
    initializeMcp: async () => {},
    ...(options.listTargets
      ? {
          executionTargetPort: {
            selectedTarget: () => undefined,
            listTargets: options.listTargets,
          },
        }
      : {}),
    logger: {
      debug: (message: string, data: Record<string, unknown>) => logs.push({ message, data }),
      info: (message: string, data: Record<string, unknown>) => logs.push({ message, data }),
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

test("no relevant capability ⇒ nothing injected", async () => {
  const { runtime, history } = fakeRuntime({});
  await injectCapabilityContextFromTurn(runtime, {
    userInput: "Refactor utils.ts",
    traceContext: TRACE,
  });
  assert.deepEqual(attachments(history), []);
});

test("Computer request injects once; identical context is not re-appended", async () => {
  const { runtime, history } = fakeRuntime({});
  const input = {
    userInput: "Open Chrome in the background and search for cats",
    traceContext: TRACE,
  };
  await injectCapabilityContextFromTurn(runtime, input);
  await injectCapabilityContextFromTurn(runtime, input);
  const injected = attachments(history);
  assert.equal(injected.length, 1);
  // 测试进程没有 Helper 凭据：如实注入"不可用"及原因，而不是宣传动作。
  assert.match(injected[0] ?? "", /Helper is not connected/u);
});

test("slow target listing is bounded and never fabricated", async () => {
  const { runtime, history } = fakeRuntime({
    tools: ["Read", "js", "ExecutionTargets", "RunOnTarget", "TargetTask", "RemoteComputer"],
    listTargets: () => new Promise(() => {}),
  });
  const startedAt = Date.now();
  await injectCapabilityContextFromTurn(runtime, { userInput: "use my Dell", traceContext: TRACE });
  assert.ok(Date.now() - startedAt < 2_000);
  const text = attachments(history)[0] ?? "";
  assert.match(text, /computer list was not resolved yet; call ExecutionTargets/u);
  assert.equal(buildRuntimeCapabilitySnapshot(runtime).diagnostics.targetListResolved, false);
});

test("resolved targets are cached and named in the context", async () => {
  let calls = 0;
  const dell: ExecutionTargetInfo = {
    id: "node-dell",
    type: "ssh",
    displayName: "Dell",
    online: true,
    available: true,
    capabilities: ["computerUse"],
    isThisDevice: false,
  };
  const { runtime, history } = fakeRuntime({
    tools: ["Read", "js", "ExecutionTargets", "RunOnTarget", "TargetTask", "RemoteComputer"],
    listTargets: async () => {
      calls += 1;
      return { ok: true, targets: [dell] };
    },
  });
  await injectCapabilityContextFromTurn(runtime, { userInput: "use my Dell", traceContext: TRACE });
  await injectCapabilityContextFromTurn(runtime, {
    userInput: "now on the Dell open Chrome",
    traceContext: TRACE,
  });
  assert.equal(calls, 1);
  const text = attachments(history).join("\n");
  assert.match(text, /Known SSH computer: Dell — targetId "node-dell"/u);
});

test("turn metrics count invalid calls, discovery calls and first valid action", () => {
  const { runtime, logs } = fakeRuntime({});
  const startedAt = Date.now() - 1_000;
  startCapabilityTurnMetrics(runtime, startedAt);
  const at = (offset: number) => new Date(startedAt + offset);
  const result = (partial: Partial<ToolExecutionResult>): ToolExecutionResult =>
    ({
      toolCallId: "x",
      toolName: "js",
      success: true,
      output: {},
      durationMs: 1,
      startedAt: at(0),
      completedAt: at(0),
      ...partial,
    }) as ToolExecutionResult;
  recordCapabilityToolResults(
    runtime,
    [
      result({
        toolCallId: "a",
        toolName: "type_text",
        success: false,
        error: { type: CoreErrorType.ToolNotFound, message: "Tool not found" },
      }),
      result({
        toolCallId: "b",
        output: { error: "TypeError: agent.computerUse.press is not a function" },
        completedAt: at(200),
      }),
      result({ toolCallId: "c", completedAt: at(300) }),
      result({ toolCallId: "e", toolName: "Bash", completedAt: at(350) }),
      result({ toolCallId: "f", completedAt: at(360) }),
      result({ toolCallId: "d", completedAt: at(400) }),
    ],
    [
      { id: "a", name: "type_text", input: {} },
      { id: "b", name: "js", input: { code: "await agent.computerUse.press({})" } },
      { id: "c", name: "js", input: { code: "await agent.computerUse.describe()" } },
      {
        id: "e",
        name: "Bash",
        input: {
          command:
            "find ~/.zcode/cli/plugins/cache/zcode-plugins-official/computer-use -name client.mjs",
        },
      },
      {
        id: "f",
        name: "js",
        input: { code: "nodeRepl.write(Object.keys(agent.computerUse).join())" },
      },
      {
        id: "d",
        name: "js",
        input: {
          code: 'await agent.computerUse["computer.open_app"]({bundle_id:"com.google.Chrome"})',
        },
      },
    ],
  );
  const metrics = flushCapabilityTurnMetrics(runtime, TRACE);
  assert.equal(metrics?.invalidToolCalls, 2);
  assert.equal(metrics?.discoveryCalls, 3);
  assert.equal(metrics?.firstValidToolActionMs, 400);
  assert.ok(logs.some((log) => log.data.event === "capability.turn.metrics"));
});

test("prepared desktop context advertises a provisioned idle Helper and complete canonical names", async () => {
  sanitizeZCodeRuntimeEnv({
    ZCODE_CUA_PERMISSION_BROKER_SOCKET: "/test/verified-socket",
    ZCODE_CUA_PLUGIN_AUTHORITY: "test-authority",
  });
  try {
    const { runtime, history } = fakeRuntime({});
    // 本地 desktop 的缺省 metadata 与 bridge 执行语义相同。
    await injectCapabilityContextFromTurn(runtime, {
      userInput: "Computer Use: take over my screen",
      traceContext: TRACE,
    });
    const text = attachments(history).join("\n");
    for (const name of [
      "computer.acquire_control",
      "computer.control_status",
      "computer.release_control",
      "computer.screenshot",
    ]) {
      assert.ok(text.includes(name), name);
    }
    assert.doesNotMatch(text, /UNAVAILABLE|Helper is not connected/u);
  } finally {
    resetCapturedZCodeCuaBrokerCredentialsForTest();
  }
});
