/**
 * hardened（host-owned transport）relay 的 session capability 回归。
 *
 * 用真实 client（@zcode/zcode-cua/broker 的 callBrokerMethod）对 fake relay 发起请求：
 * - 进程 env 携带 ZCODE_CUA_PERMISSION_BROKER_TOKEN 时，请求行必须带 request.token，
 *   relay 接受（替代 packaged 实测的 missing_session_capability 拒绝）；
 * - 未携带 token → relay 以 missing_session_capability 拒绝（fail-closed）；
 * - token 错误 → wrong_caller。
 *
 * fake relay 复刻 packages/zcode-cua/host-transport.js dispatchRequestLine 的 capability
 * 门：常量时间比较不在此断言（由该模块自身测试覆盖），这里只锁定请求确实携带 token。
 *
 * Run: mise exec -- node --import tsx --test packages/services/test/cuaBrokerSessionCapability.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BROKER_TOKEN_ENV, callBrokerMethod } from "@zcode/zcode-cua/broker";

const LAUNCH_TOKEN = "launch-capability-test-token";

function startFakeHardenedRelay(socketPath: string): Promise<Server> {
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as {
        id?: unknown;
        token?: unknown;
      };
      const token = typeof request.token === "string" ? request.token : undefined;
      if (token !== LAUNCH_TOKEN) {
        socket.write(
          `${JSON.stringify({
            id: request.id ?? null,
            ok: false,
            error: {
              code: token === undefined ? "missing_session_capability" : "wrong_caller",
              message:
                token === undefined
                  ? "the session capability token is required"
                  : "the presented session capability is not valid",
            },
          })}\n`,
        );
        return;
      }
      socket.write(
        `${JSON.stringify({ id: request.id ?? null, ok: true, result: { accepted: true } })}\n`,
      );
    });
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve(server)));
}

test("hardened relay accepts the request once the session capability token is present", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cua-session-capability-"));
  const socketPath = join(dir, "b.sock");
  const server = await startFakeHardenedRelay(socketPath);
  const previousToken = process.env[BROKER_TOKEN_ENV];
  try {
    // 1) node_repl 宿主恢复 token 后：请求携带 request.token，relay 接受。
    process.env[BROKER_TOKEN_ENV] = LAUNCH_TOKEN;
    const result = await callBrokerMethod({
      socketPath,
      method: "permission_status",
      requireVerifiedIdentity: false,
      timeoutMs: 2_000,
    });
    assert.deepEqual(result, { accepted: true });

    // 2) 未恢复 token（packaged 实测的缺陷形态）：missing_session_capability。
    delete process.env[BROKER_TOKEN_ENV];
    await assert.rejects(
      callBrokerMethod({
        socketPath,
        method: "permission_status",
        requireVerifiedIdentity: false,
        timeoutMs: 2_000,
      }),
      (error: { code?: string }) => error?.code === "missing_session_capability",
    );

    // 3) token 错误：wrong_caller，绝不静默降级为无 token 请求。
    process.env[BROKER_TOKEN_ENV] = "wrong-capability-token";
    await assert.rejects(
      callBrokerMethod({
        socketPath,
        method: "permission_status",
        requireVerifiedIdentity: false,
        timeoutMs: 2_000,
      }),
      (error: { code?: string }) => error?.code === "wrong_caller",
    );
  } finally {
    if (previousToken === undefined) {
      delete process.env[BROKER_TOKEN_ENV];
    } else {
      process.env[BROKER_TOKEN_ENV] = previousToken;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
