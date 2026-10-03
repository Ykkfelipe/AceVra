/**
 * Personal Bot M2 Phase 2 —— host 侧个人记忆中继（interaction/personalMemoryContext）。
 *
 * 覆盖验收要求：
 * - 原始 PersonalMemoryRecord[] 绝不跨界（即便 resolver 顺手返回了整个上下文对象）；
 * - resolver 缺失或抛错时返回空上下文而不是协议错误（fail-open，记忆是增强）；
 * - 非法入参仍然是 -32602（协议错误要如实报）；
 * - 出站载荷只含 text / omittedCount / byteLength，且能被 CLI 侧的 strict schema 解析通过。
 *
 * Run: mise exec -- node --import tsx --test packages/services/test/personalMemoryRpc.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createNodeBotService } from "../src/bot/adapters/nodeBotService.js";
import { DEFAULT_MAX_MEMORY_RECORDS, MAX_MEMORY_CONTEXT_BYTES } from "../src/bot/contract.js";
import { zcodePersonalMemoryContextResultSchema } from "@zcode/shared";
import { handlePersonalMemoryContextRequest } from "../src/zcode-agent/zcodeAgentPersonalMemoryRpc.js";

const VALID_PARAMS = { requestId: "req_1", sessionId: "sess_bot", query: "what is my goal?" };

function createClient() {
  const responses: unknown[] = [];
  const errors: { code: number; message: string }[] = [];
  return {
    responses,
    errors,
    client: {
      respond: async (_id: unknown, result: unknown) => {
        responses.push(result);
      },
      respondError: async (_id: unknown, error: { code: number; message: string }) => {
        errors.push({ code: error.code, message: error.message });
      },
    },
  };
}

/** 等一次 microtask 链落地（handler 经 Promise 边界异步应答）。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("a rendered context is relayed and satisfies the CLI-side strict schema", async () => {
  const { client, responses, errors } = createClient();
  handlePersonalMemoryContextRequest({
    client: client as never,
    resolver: async () => ({ text: "- [goal] Ship M2", omittedCount: 4, byteLength: 18 }),
    requestId: "rpc_1" as never,
    params: VALID_PARAMS,
  });
  await settle();

  assert.deepEqual(errors, []);
  assert.equal(responses.length, 1);
  assert.deepEqual(responses[0], { text: "- [goal] Ship M2", omittedCount: 4, byteLength: 18 });
  // CLI 侧收到的必须是可解析的：这是跨界契约的实际校验点。
  assert.equal(zcodePersonalMemoryContextResultSchema.safeParse(responses[0]).success, true);
});

test("raw personal-memory records never cross the boundary", async () => {
  const { client, responses } = createClient();
  // resolver 故意把整个 BotMemoryContext（含 selected 原始记录）返回回来。
  handlePersonalMemoryContextRequest({
    client: client as never,
    resolver: async () =>
      ({
        text: "- [preference] Dark mode",
        omittedCount: 0,
        byteLength: 24,
        selected: [
          {
            id: "mem_secret",
            category: "preference",
            title: "Internal note",
            summary: "must not cross",
            tags: ["private"],
            pinned: false,
            source: "user",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }) as never,
    requestId: "rpc_2" as never,
    params: VALID_PARAMS,
  });
  await settle();

  assert.equal(responses.length, 1);
  const payload = responses[0] as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), ["byteLength", "omittedCount", "text"]);
  assert.equal("selected" in payload, false);
  assert.equal(JSON.stringify(payload).includes("mem_secret"), false);
});

test("a missing resolver answers with an empty context, not a protocol error", async () => {
  const { client, responses, errors } = createClient();
  handlePersonalMemoryContextRequest({
    client: client as never,
    resolver: undefined,
    requestId: "rpc_3" as never,
    params: VALID_PARAMS,
  });
  await settle();

  assert.deepEqual(errors, []);
  assert.deepEqual(responses[0], { text: "", omittedCount: 0, byteLength: 0 });
});

test("a throwing resolver fails open into an empty context", async () => {
  const { client, responses, errors } = createClient();
  handlePersonalMemoryContextRequest({
    client: client as never,
    resolver: async () => {
      throw new Error("bot store corrupt");
    },
    requestId: "rpc_4" as never,
    params: VALID_PARAMS,
  });
  await settle();

  assert.deepEqual(errors, []);
  assert.deepEqual(responses[0], { text: "", omittedCount: 0, byteLength: 0 });
});

test("malformed params are still reported as a protocol error", async () => {
  const { client, responses, errors } = createClient();
  handlePersonalMemoryContextRequest({
    client: client as never,
    resolver: async () => ({ text: "x", omittedCount: 0, byteLength: 1 }),
    requestId: "rpc_5" as never,
    // 缺 query：这是协议错误，必须与“没有记忆”区分开。
    params: { requestId: "req_1", sessionId: "sess_bot" },
  });
  await settle();

  assert.equal(responses.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.code, -32602);
});

test("the request carries no budget overrides across the boundary", async () => {
  const seen: Record<string, unknown>[] = [];
  const { client } = createClient();
  handlePersonalMemoryContextRequest({
    client: client as never,
    resolver: async (request) => {
      seen.push(request as unknown as Record<string, unknown>);
      return { text: "", omittedCount: 0, byteLength: 0 };
    },
    requestId: "rpc_6" as never,
    // 即便调用方硬塞预算参数，strict schema 也会拒绝——预算不跨界。
    params: { ...VALID_PARAMS, maxRecords: 999, maxBytes: 999_999 },
  });
  await settle();

  assert.deepEqual(seen, [], "a request carrying budget overrides must be rejected outright");
});

test("bounds survive the whole chain: bot service → wire projection → strict schema", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "acevra-mem-rpc-"));
  try {
    const service = createNodeBotService({
      rootDir: path.join(base, "personal-bot"),
      workspacePath: path.join(base, "workspace", "personal-bot"),
    });
    for (let index = 0; index < 200; index += 1) {
      await service.rememberMemory({
        category: "project",
        title: `Quarterly planning item ${index}`,
        summary: index === 0 ? "owner Ada; review Friday; quarterly planning" : `note ${index}`,
      });
    }

    const context = await service.buildMemoryContext({ query: "quarterly planning" });
    const wire = {
      text: context.text,
      omittedCount: context.omittedCount,
      byteLength: context.byteLength,
    };

    // 预算仍是 Bot 模块自己的：条数与字节数都没有被调用方放宽。
    assert.ok(context.selected.length <= DEFAULT_MAX_MEMORY_RECORDS);
    assert.ok(Buffer.byteLength(wire.text, "utf8") <= MAX_MEMORY_CONTEXT_BYTES);
    assert.equal(wire.byteLength, Buffer.byteLength(wire.text, "utf8"));
    assert.ok(wire.omittedCount > 0);
    // 且出站载荷仍是 CLI 侧可解析的。
    assert.equal(zcodePersonalMemoryContextResultSchema.safeParse(wire).success, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
