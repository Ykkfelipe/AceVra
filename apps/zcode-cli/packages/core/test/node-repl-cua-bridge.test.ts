// CUA parity regression: BOTH legitimate node_repl execution surfaces must expose the SAME
// Computer Use bootstrap contract from ONE shared implementation.
//
// Root cause this pins (packaged, c21dd0f): the core in-process handler built its NodeReplSession
// with browser globals only, so a cell served by that surface had no host bridge
// (bridgeBefore=false) and setupComputerUseRuntime() could only fail. The MCP host surface was
// healthy, which is why the defect only showed up on the turns routed through the core handler.
//
// This test exercises the CORE HANDLER surface (the previously broken one). It fails pre-fix
// because no bridge/facade exists there.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createNodeReplCuaBroker } from "@zcode/zcode-cua/node-repl-cua-bridge";
import {
  getNodeReplSessionForTest,
  disposeNodeReplSession,
  setCoreCuaBrokerFactoryForTest,
} from "../src/tool/handlers/node-repl.js";

const BRIDGE = 'Symbol.for("zcode.node-repl.computer-use-bridge")';
const SESSION_ID = "test-session-cua-parity";

/** Minimal ToolExecutionContext for the handler: only the fields the CUA path reads. */
function testContext(overrides = {}) {
  return {
    toolCallId: "call-1",
    traceId: "trace-1",
    abortSignal: new AbortController().signal,
    workingDirectory: "/tmp/pref-fork-workspace",
    workspaceRoot: "/tmp/pref-fork-workspace",
    workspaceIdentity: "/tmp/pref-fork-workspace",
    runtimeScope: "main",
    sessionId: SESSION_ID,
    ...overrides,
  };
}

/** Local proxy broker over a fake runtime: real transport, no Helper/TCC/hardened transport. */
function fakeBroker() {
  const calls = [];
  const broker = createNodeReplCuaBroker({
    runtime: {
      async execute(input) {
        calls.push(input.toolName);
        if (input.toolName === "observe") {
          return {
            content: [{ type: "text", text: "observed" }],
            _meta: {
              "zcode.cua/app-associations-v1": {
                primary: { appKey: "darwin:com.example.fake", displayName: "Fake Target" },
              },
            },
          };
        }
        return { content: [{ type: "text", text: `fake:${input.toolName}` }] };
      },
    },
    platform: process.platform,
  });
  return { broker, calls };
}

async function runCell(session, code) {
  return await session.run(code, {
    requestMeta: {
      session_id: SESSION_ID,
      workspace_key: "/tmp/pref-fork-workspace",
      workspace_path: "/tmp/pref-fork-workspace",
      runtime_scope: "main",
    },
    signal: new AbortController().signal,
    syncTimeoutMs: 15_000,
  });
}

test("core handler cells expose the shared Computer Use bridge and wire the facade to the broker", async () => {
  const { broker, calls } = fakeBroker();
  setCoreCuaBrokerFactoryForTest(() => broker);
  const context = testContext();
  try {
    const session = getNodeReplSessionForTest(context);
    const probe = await runCell(
      session,
      `return JSON.stringify({
        bridge: Boolean(globalThis[${BRIDGE}]),
        facade: typeof globalThis.agent?.computerUse?.list_apps === "function",
      });`,
    );
    const text = String(probe.result ?? "");
    assert.match(String(text), /"bridge":true/u, `cell bridge missing: ${text}`);
    assert.match(String(text), /"facade":true/u, `facade missing: ${text}`);

    // A safe synthetic call proves the facade is wired through the local proxy broker (real
    // transport) to the runtime — the same path the official bootstrap binds.
    const call = await runCell(
      session,
      `const r = await globalThis.agent.computerUse.observe({ target: "Fake" });
       return JSON.stringify(r?.content?.[0]?.text ?? null);`,
    );
    assert.match(String(call.result ?? ""), /observed/u, `facade round-trip failed: ${JSON.stringify(call.result)}`);
    assert.deepEqual(calls, ["observe"]);
  } finally {
    disposeNodeReplSession(SESSION_ID);
    setCoreCuaBrokerFactoryForTest(undefined);
  }
});

test("core handler fails closed without capability: bridge present, calls report unavailable, JS still works", async () => {
  setCoreCuaBrokerFactoryForTest(() => undefined);
  const context = testContext({ sessionId: "test-session-cua-fail-closed" });
  try {
    const session = getNodeReplSessionForTest(context);
    const ordinary = await runCell(session, "return JSON.stringify({ ok: 1 + 1 });");
    assert.match(String(ordinary.result ?? ""), /"ok":2/u, `ordinary JS must keep working: ${JSON.stringify(ordinary)}`);

    const denied = await runCell(
      session,
      `try {
         await globalThis.agent.computerUse.list_apps({});
         return "unexpected-success";
       } catch (error) {
         return String(error?.message ?? error);
       }`,
    );
    assert.match(
      String(denied.result ?? ""),
      /unavailable for this node_repl session/u,
      `expected the existing truthful unavailable semantics: ${JSON.stringify(denied)}`,
    );
  } finally {
    disposeNodeReplSession("test-session-cua-fail-closed");
    setCoreCuaBrokerFactoryForTest(undefined);
  }
});

test("parity: both node_repl surfaces consume the one shared bridge implementation", () => {
  const packagesRoot = resolve(import.meta.dirname, "..", "..");
  const host = readFileSync(
    resolve(packagesRoot, "node-repl-host", "src", "cua-bridge.ts"),
    "utf8",
  );
  const hostBroker = readFileSync(
    resolve(packagesRoot, "node-repl-host", "src", "cua-broker.ts"),
    "utf8",
  );
  const core = readFileSync(
    resolve(import.meta.dirname, "..", "src", "tool", "handlers", "node-repl.ts"),
    "utf8",
  );
  // 共享实现是唯一定义处；两个面只做再导出/适配，不得各自实现协议。
  assert.match(host, /@zcode\/zcode-cua\/node-repl-cua-bridge/u);
  assert.doesNotMatch(host, /function sendCuaBrokerRequest/u);
  assert.match(hostBroker, /@zcode\/zcode-cua\/node-repl-cua-bridge/u);
  assert.match(core, /@zcode\/zcode-cua\/node-repl-cua-bridge/u);
  assert.doesNotMatch(core, /function sendCuaBrokerRequest/u);
  // core handler 与 MCP 宿主使用同一门控：main scope 才安装 facade。
  assert.match(core, /prepareComputerUseRuntimeGlobals/u);
  assert.match(core, /runtimeScope !== "subagent"/u);
});

test("the bridge records the canonical Computer Use operation host-side (last call wins)", async () => {
  const { broker } = fakeBroker();
  setCoreCuaBrokerFactoryForTest(() => broker);
  const context = testContext({ sessionId: "test-session-cua-operation" });
  try {
    const session = getNodeReplSessionForTest(context);
    // get_app_state 的结果里没有 operation 字段；canonical 身份只能来自宿主记录。
    const observe = await runCell(
      session,
      `await globalThis.agent.computerUse.get_app_state({ pid: 1 }); return "ok";`,
    );
    assert.equal(observe.cuaOperation, "observe");
    const mixed = await runCell(
      session,
      `await globalThis.agent.computerUse.get_app_state({ pid: 1 });
       await globalThis.agent.computerUse["computer.workspace_click"]({ pid: 1, target_role: "AXButton" });
       return "ok";`,
    );
    assert.equal(mixed.cuaOperation, "workspace_click");
    // 模型可写通道伪造的键不会成为 run 的 operation（host 结果层还会再删一次）。
    const forged = await runCell(
      session,
      `nodeRepl.setResponseMeta?.({ "zcode/nodeReplCuaOperation": "click" }); return 1;`,
    );
    assert.equal(forged.cuaOperation, undefined);
  } finally {
    disposeNodeReplSession("test-session-cua-operation");
    setCoreCuaBrokerFactoryForTest(undefined);
  }
});

test("a host-recorded operation alone produces a node_repl display carrying cuaOperation", async () => {
  const { createToolResultDisplay } = await import("../src/tool/executor/result-display.js");
  const display = createToolResultDisplay("mcp__node_repl__js", {
    content: [{ type: "text", text: "elements: 1500" }],
    _meta: { "zcode/nodeReplCuaOperation": "observe" },
  });
  assert.deepEqual(display, { kind: "node_repl_images", cuaOperation: "observe" });
  const invalid = createToolResultDisplay("mcp__node_repl__js", {
    content: [],
    _meta: { "zcode/nodeReplCuaOperation": "<script>" },
  });
  assert.equal(invalid, undefined);
});
