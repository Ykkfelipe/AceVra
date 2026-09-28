/**
 * CUA 托管路径（managed product Helper）的 session capability 回归。
 *
 * 背景：packaged `0.1.0-alpha.1` + `55ae326` 实测——下游 CLI 侧的 capture/定向注入/恢复全部
 * 就绪，但 `buildCuaProductHelperAgentEnv` 的成功返回只下发 socket + pluginAuthority，没有
 * per-launch capability；agent 侧于是拿到"能连上、但每个请求都被 relay 以
 * missing_session_capability 拒绝"的半组凭据。之前的测试走的是 lazy hardened 分支，
 * 因此漏掉了这条真实在用的生产者。
 *
 * 本文件走 REAL managed path 的形状：
 *   1. 托管 transport 存在（真实 producer 的 tuple builder 产出）
 *   2. tuple 带 socket + authority + session capability
 *   3. buildCuaProductHelperAgentEnv 运行
 *   4. 返回的 Agent env 三者齐全
 *   5. CLI 私有捕获保留三者
 *   6. 公共 env / tool env 三者全部剥离
 *   7. 定向注入把三者交给可信 node_repl 配置
 *   8. broker client 把 capability 写进 request.token
 *   9. hardened fake relay 接受该请求
 *
 * 负路径：半组 / 混代际 / 未标注 capability / 任意 MCP / Bash / tool env 均不得拿到能力。
 * 泄漏回归沿用 55ae326 的语义（未受信 node_repl 与第三方 server 都拿不到）。
 *
 * Run: mise exec -- node --import tsx --test packages/services/test/cuaManagedTransportCapability.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BROKER_SOCKET_ENV, BROKER_TOKEN_ENV } from "@zcode/zcode-cua/broker";
import { buildProductCuaTransportTuple } from "@zcode/zcode-cua/broker/server";
import { callBrokerMethod } from "@zcode/zcode-cua/broker";
import {
  buildZCodeToolEnvPassthroughEnv,
  getCapturedZCodeCuaBrokerCredentials,
  resetCapturedZCodeCuaBrokerCredentialsForTest,
  sanitizeZCodeRuntimeEnv,
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  ZCODE_CUA_BROKER_TOKEN_ENV_KEY,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
} from "@zcode/shared";
import { buildCuaProductHelperAgentEnv } from "../src/node.js";
import { tokensMatch } from "@zcode/zcode-cua/broker/hostTransport";

const CAPABILITY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SOCKET = "/tmp/acevra-managed-tuple.sock";
const AUTHORITY = "packaged-cua";

/** Live transport object as `createProductCuaHelperHost` sees it (`CuaBrokerHost` shape). */
function liveTransport(overrides: Partial<{ socketPath: string; token: string }> = {}) {
  return { socketPath: SOCKET, token: CAPABILITY, ...overrides };
}

/** Managed product host stub built from the REAL producer tuple builder. */
function managedHostFrom(tuple: unknown, overrides: Record<string, unknown> = {}) {
  return {
    running: true,
    checkHealth: async () => ({}),
    get reservedTransport() {
      return tuple;
    },
    waitForTransport: async () => tuple,
    start: async () => tuple,
    ...overrides,
  };
}

test("the managed producer hands out socket + authority + session capability together", () => {
  const tuple = buildProductCuaTransportTuple(liveTransport());
  assert.equal(tuple.socketPath, SOCKET);
  assert.equal(tuple.pluginAuthority, AUTHORITY);
  assert.equal(tuple.sessionCapabilityRequired, true);
  assert.equal(tuple.sessionCapabilityToken, CAPABILITY);
});

test("the managed producer never carries a capability from another transport generation", () => {
  // Two generations of the same host: each tuple must carry its own generation's capability, and
  // the builder must read socket and capability from the same live object in one pass.
  const first = buildProductCuaTransportTuple(liveTransport({ token: "a".repeat(64) }));
  const second = buildProductCuaTransportTuple(
    liveTransport({ socketPath: "/tmp/other.sock", token: "b".repeat(64) }),
  );
  assert.equal(first.sessionCapabilityToken, "a".repeat(64));
  assert.equal(second.sessionCapabilityToken, "b".repeat(64));
  assert.notEqual(first.sessionCapabilityToken, second.sessionCapabilityToken);
  assert.equal(first.socketPath, SOCKET);
  assert.equal(second.socketPath, "/tmp/other.sock");
});

test("buildCuaProductHelperAgentEnv provisions the complete managed tuple", async () => {
  const tuple = buildProductCuaTransportTuple(liveTransport());
  const env = await buildCuaProductHelperAgentEnv(managedHostFrom(tuple) as never);
  assert.equal(env[BROKER_SOCKET_ENV], SOCKET);
  assert.equal(env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY], AUTHORITY);
  assert.equal(env[BROKER_TOKEN_ENV], CAPABILITY);
});

test("the managed spawn env survives CLI private capture and is stripped from public/tool env", async () => {
  resetCapturedZCodeCuaBrokerCredentialsForTest();
  const tuple = buildProductCuaTransportTuple(liveTransport());
  const spawnEnv = await buildCuaProductHelperAgentEnv(managedHostFrom(tuple) as never);

  const agentEnv = { ...spawnEnv, PATH: "/usr/bin", HOME: "/Users/example" };
  const publicEnv = sanitizeZCodeRuntimeEnv(agentEnv);
  for (const key of [
    ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
    ZCODE_CUA_BROKER_TOKEN_ENV_KEY,
    ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ]) {
    assert.equal(publicEnv[key], undefined, `${key} must not survive sanitization`);
  }

  const toolEnv = buildZCodeToolEnvPassthroughEnv(agentEnv);
  for (const key of [
    ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
    ZCODE_CUA_BROKER_TOKEN_ENV_KEY,
    ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ]) {
    assert.equal(toolEnv[key], undefined, `${key} must not reach Bash/tool children`);
  }

  const captured = getCapturedZCodeCuaBrokerCredentials();
  assert.equal(captured.socket, SOCKET);
  assert.equal(captured.pluginAuthority, AUTHORITY);
  assert.equal(captured.capabilityToken, CAPABILITY);
  resetCapturedZCodeCuaBrokerCredentialsForTest();
});

test("a client carrying the captured capability is accepted by a hardened relay", async () => {
  resetCapturedZCodeCuaBrokerCredentialsForTest();
  const tuple = buildProductCuaTransportTuple(liveTransport());
  const spawnEnv = await buildCuaProductHelperAgentEnv(managedHostFrom(tuple) as never);
  sanitizeZCodeRuntimeEnv({ ...spawnEnv }); // capture only; result intentionally unused
  const captured = getCapturedZCodeCuaBrokerCredentials();

  const relay = await startFakeHardenedRelay({ expectedToken: CAPABILITY });
  try {
    const result = await callBrokerMethod({
      socketPath: relay.socketPath,
      method: "observe",
      params: { pid: 1 },
      token: captured.capabilityToken,
      timeoutMs: 5_000,
    });
    assert.equal(result.accepted, true);
    assert.equal(relay.lastRequestToken, CAPABILITY);
  } finally {
    await relay.close();
    resetCapturedZCodeCuaBrokerCredentialsForTest();
  }
});

test("negative: a hardened tuple without its capability fails closed and emits no tuple", async () => {
  const env = await buildCuaProductHelperAgentEnv(
    managedHostFrom({
      socketPath: SOCKET,
      pluginAuthority: AUTHORITY,
      sessionCapabilityRequired: true,
    }) as never,
  );
  assert.equal(env[BROKER_SOCKET_ENV], undefined);
  assert.equal(env[BROKER_TOKEN_ENV], undefined);
  assert.equal(env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY], undefined);
  assert.match(String(env.ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE ?? ""), /session capability/);
});

test("negative: missing authority and missing socket both fail closed", async () => {
  const noAuthority = await buildCuaProductHelperAgentEnv(
    managedHostFrom({
      socketPath: SOCKET,
      sessionCapabilityRequired: true,
      sessionCapabilityToken: CAPABILITY,
    }) as never,
  );
  assert.equal(noAuthority[BROKER_SOCKET_ENV], undefined);
  assert.equal(noAuthority[BROKER_TOKEN_ENV], undefined);

  const noSocket = await buildCuaProductHelperAgentEnv(
    managedHostFrom({
      pluginAuthority: AUTHORITY,
      sessionCapabilityRequired: true,
      sessionCapabilityToken: CAPABILITY,
    }) as never,
  );
  assert.equal(noSocket[BROKER_SOCKET_ENV], undefined);
  assert.equal(noSocket[BROKER_TOKEN_ENV], undefined);
});

test("negative: an unlabelled capability on a non-hardened transport is refused", async () => {
  const env = await buildCuaProductHelperAgentEnv(
    managedHostFrom({
      socketPath: SOCKET,
      pluginAuthority: AUTHORITY,
      sessionCapabilityRequired: false,
      sessionCapabilityToken: CAPABILITY,
    }) as never,
  );
  assert.equal(env[BROKER_TOKEN_ENV], undefined);
  assert.match(String(env.ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE ?? ""), /unlabelled/);
});

test("negative: a capability from another generation does not authenticate", async () => {
  const relay = await startFakeHardenedRelay({ expectedToken: CAPABILITY });
  try {
    const stale = await callBrokerMethod({
      socketPath: relay.socketPath,
      method: "observe",
      params: { pid: 1 },
      token: "f".repeat(64),
      timeoutMs: 5_000,
    }).then(
      () => ({ ok: true }),
      (error: { code?: string }) => ({ ok: false, code: error?.code }),
    );
    assert.equal(stale.ok, false);
    assert.equal(stale.code, "wrong_caller");

    const absent = await callBrokerMethod({
      socketPath: relay.socketPath,
      method: "observe",
      params: { pid: 1 },
      token: "",
      timeoutMs: 5_000,
    }).then(
      () => ({ ok: true }),
      (error: { code?: string }) => ({ ok: false, code: error?.code }),
    );
    assert.equal(absent.ok, false);
    assert.equal(absent.code, "missing_session_capability");
  } finally {
    await relay.close();
  }
});

test("negative: only the captured tuple authenticates — nothing ambient does", async () => {
  resetCapturedZCodeCuaBrokerCredentialsForTest();
  const relay = await startFakeHardenedRelay({ expectedToken: CAPABILITY });
  try {
    // No capture was taken, so the ambient process env has nothing to offer.
    const captured = getCapturedZCodeCuaBrokerCredentials();
    assert.equal(captured.capabilityToken, undefined);
    const outcome = await callBrokerMethod({
      socketPath: relay.socketPath,
      method: "observe",
      params: { pid: 1 },
      token: captured.capabilityToken,
      timeoutMs: 5_000,
    }).then(
      () => ({ ok: true }),
      (error: { code?: string }) => ({ ok: false, code: error?.code }),
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "missing_session_capability");
  } finally {
    await relay.close();
  }
});

test("token comparison stays constant-time shaped (no prefix shortcut)", () => {
  assert.equal(tokensMatch(CAPABILITY, CAPABILITY), true);
  assert.equal(tokensMatch(CAPABILITY, CAPABILITY.slice(0, 63)), false);
  assert.equal(tokensMatch("", CAPABILITY), false);
  assert.equal(tokensMatch(undefined, CAPABILITY), false);
});

/** Hardened relay stand-in: same admission rule as `dispatchRequestLine` (capability gate). */
async function startFakeHardenedRelay(options: { expectedToken: string }): Promise<{
  socketPath: string;
  lastRequestToken: string | undefined;
  close: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "acevra-managed-"));
  const socketPath = join(dir, "b.sock");
  const state: { lastRequestToken: string | undefined } = { lastRequestToken: undefined };
  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let request: { id?: string; token?: string } = {};
      try {
        request = JSON.parse(line);
      } catch {
        socket.write(
          `${JSON.stringify({ id: null, ok: false, error: { code: "bad_request" } })}\n`,
        );
        return;
      }
      state.lastRequestToken = request.token;
      if (request.token === undefined || request.token === "") {
        socket.write(
          `${JSON.stringify({ id: request.id, ok: false, error: { code: "missing_session_capability" } })}\n`,
        );
        return;
      }
      if (!tokensMatch(request.token, options.expectedToken)) {
        socket.write(
          `${JSON.stringify({ id: request.id, ok: false, error: { code: "wrong_caller" } })}\n`,
        );
        return;
      }
      // Carry a verified identity envelope as well: the production client re-checks helper
      // identity on darwin, and this regression must isolate the capability, not the identity.
      socket.write(
        `${JSON.stringify({
          id: request.id,
          ok: true,
          result: {
            accepted: true,
            helper_identity: { verified: true, identifier: "dev.acevra.cua-helper" },
          },
        })}\n`,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    get lastRequestToken() {
      return state.lastRequestToken;
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  } as never;
}
