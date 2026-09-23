/**
 * 轮尾自动观察截图必须显式标注 captureIntent:"observation"，host 才能只把用户/模型显式截图登记为
 * 任务 artifact（不依赖 sha256 去重）。broker 转发见 bootstrap/test/browser-capture-intent-broker.test.ts。
 *
 * Run: mise exec -- node --import tsx --test apps/zcode-cli/packages/core/test/browser-capture-intent.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { appendBrowserTurnScreenshot } from "../src/runtime/methods/browser-turn-screenshot.js";
import { recordBrowserTurnToolResult } from "../src/repl/browser-turn-state.js";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

test("turn-end observation screenshot is marked captureIntent=observation; the tab listing is not", async () => {
  const sessionId = "sess_11111111-2222-4333-8444-555555555555";
  const turnId = "turn_capture_intent";
  recordBrowserTurnToolResult({
    sessionId: sessionId as never,
    turnId: turnId as never,
    toolName: "mcp__node_repl__js",
    output: { _meta: { "zcode/browserTurnScreenshot": { browserId: "iab:x", browserGeneration: 1 } } },
  });
  const calls: Array<{ command: { method: string }; captureIntent?: string }> = [];
  const runtime = {
    sessionId,
    browserControlPort: {
      async list() {
        return [];
      },
      async execute(input: { command: { method: string }; captureIntent?: string }) {
        calls.push(input);
        return input.command.method === "list"
          ? { ok: true, tabs: [{ tabId: "tab-1", active: true }] }
          : { ok: true, image: { base64: PNG_BASE64, mimeType: "image/png" } };
      },
    },
    logger: { debug() {}, warn() {} },
    async persistPart() {},
    createEvent: (type: unknown, payload: unknown) => ({ type, payload }),
    async appendEvent() {},
  };
  const state = { turnId, events: [] as unknown[], turnTraceContext: undefined, turnAbortSignal: undefined };
  await appendBrowserTurnScreenshot(runtime as never, state as never, "msg-1" as never);

  assert.deepEqual(
    calls.map((call) => [call.command.method, call.captureIntent]),
    [
      ["list", undefined],
      ["screenshot", "observation"],
    ],
  );
  assert.ok(state.events.length > 0, "the observation screenshot still reaches the conversation display");
});
