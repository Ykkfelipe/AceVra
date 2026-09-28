/**
 * CUA session capability（hardened launch token）在 CLI 侧的定向传递回归。
 *
 * 复现并锁定 packaged 实测的失败链：agent spawn env 里 socket/authority/token 齐全，
 * 但私有捕获漏 token → 定向注入只带 socket+authority → node_repl 进程内
 * `callBrokerMethod` 读不到 `ZCODE_CUA_PERMISSION_BROKER_TOKEN` → hardened relay
 * 以 missing_session_capability 拒绝每个真实请求。
 *
 * 本文件覆盖上游半程（捕获/清洗/定向注入），下游半程（fake hardened relay 接受/拒绝）
 * 见 packages/services/test/cuaBrokerSessionCapability.test.ts。
 *
 * Run: mise exec -- node --import tsx --test apps/zcode-cli/packages/bootstrap/test/cuaSessionCapability.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { McpServerConfig } from "@zcode/contracts";
import {
  buildZCodeToolEnvPassthroughEnv,
  getCapturedZCodeCuaBrokerCredentials,
  resetCapturedZCodeCuaBrokerCredentialsForTest,
  sanitizeZCodeRuntimeEnv,
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  ZCODE_CUA_BROKER_TOKEN_ENV_KEY,
  ZCODE_CUA_NODE_REPL_HOST_ENV_KEY,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY,
} from "@zcode/shared/runtime-env";
import { omitMcpServers } from "../src/mcp-config.js";

const SOCKET = "/tmp/cua-capability-test.sock";
const AUTHORITY = "authority-test-value";
const CAPABILITY = "capability-test-value";

function sanctionedSpawnEnv(): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    [ZCODE_CUA_BROKER_SOCKET_ENV_KEY]: SOCKET,
    [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: AUTHORITY,
    [ZCODE_CUA_BROKER_TOKEN_ENV_KEY]: CAPABILITY,
  };
}

test("sanitization captures the sanctioned tuple and strips it from public and tool envs", () => {
  resetCapturedZCodeCuaBrokerCredentialsForTest();
  const env = sanctionedSpawnEnv();
  const publicEnv = sanitizeZCodeRuntimeEnv(env);
  const captured = getCapturedZCodeCuaBrokerCredentials();

  // 私有快照：socket + authority + launch-scoped capability token 同批保留。
  assert.equal(captured.socket, SOCKET);
  assert.equal(captured.pluginAuthority, AUTHORITY);
  assert.equal(captured.capabilityToken, CAPABILITY);

  // 公共 env：三者全部剔除，普通子进程（Bash 等）拿到的就是这份。
  assert.equal(publicEnv[ZCODE_CUA_BROKER_SOCKET_ENV_KEY], undefined);
  assert.equal(publicEnv[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY], undefined);
  assert.equal(publicEnv[ZCODE_CUA_BROKER_TOKEN_ENV_KEY], undefined);

  // tool-env passthrough 也不得把凭据组还给 Bash/tool 子进程。
  const toolEnv = { ...publicEnv, ...buildZCodeToolEnvPassthroughEnv(env) };
  assert.equal(toolEnv[ZCODE_CUA_BROKER_SOCKET_ENV_KEY], undefined);
  assert.equal(toolEnv[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY], undefined);
  assert.equal(toolEnv[ZCODE_CUA_BROKER_TOKEN_ENV_KEY], undefined);
  const passthrough = JSON.parse(
    (toolEnv[ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY] ?? "{}") as string,
  ) as Record<string, string>;
  assert.deepEqual(
    Object.keys(passthrough).filter((key) => key.includes("ZCODE_CUA")),
    [],
  );
});

test("half-pair fails closed and never reuses a stale capability token", () => {
  resetCapturedZCodeCuaBrokerCredentialsForTest();
  sanitizeZCodeRuntimeEnv(sanctionedSpawnEnv());
  assert.equal(getCapturedZCodeCuaBrokerCredentials().capabilityToken, CAPABILITY);

  // 半组（只有 socket）：清空整份快照，token 不能靠上一轮残留活下来。
  sanitizeZCodeRuntimeEnv({ [ZCODE_CUA_BROKER_SOCKET_ENV_KEY]: SOCKET });
  const captured = getCapturedZCodeCuaBrokerCredentials();
  assert.equal(captured.socket, undefined);
  assert.equal(captured.pluginAuthority, undefined);
  assert.equal(captured.capabilityToken, undefined);
});

test("directed injection hands the tuple only to the trusted node_repl server", () => {
  resetCapturedZCodeCuaBrokerCredentialsForTest();
  sanitizeZCodeRuntimeEnv(sanctionedSpawnEnv());

  const servers = {
    node_repl: { type: "stdio", command: "node", args: ["repl-server.js"], env: {} },
    "third-party-mcp": { type: "stdio", command: "node", args: ["other.js"], env: {} },
  } as unknown as Record<string, McpServerConfig>;

  const injected = omitMcpServers(servers, new Set(), new Set(["node_repl"]));
  const nodeReplEnv = injected.node_repl?.env ?? {};
  assert.equal(nodeReplEnv[ZCODE_CUA_BROKER_SOCKET_ENV_KEY], SOCKET);
  assert.equal(nodeReplEnv[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY], AUTHORITY);
  assert.equal(nodeReplEnv[ZCODE_CUA_BROKER_TOKEN_ENV_KEY], CAPABILITY);
  assert.equal(nodeReplEnv[ZCODE_CUA_NODE_REPL_HOST_ENV_KEY], "1");

  // 任意其它 MCP server 绝不收到凭据组（哪怕同一轮注入发生了）。
  const otherEnv = injected["third-party-mcp"]?.env ?? {};
  assert.equal(otherEnv[ZCODE_CUA_BROKER_SOCKET_ENV_KEY], undefined);
  assert.equal(otherEnv[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY], undefined);
  assert.equal(otherEnv[ZCODE_CUA_BROKER_TOKEN_ENV_KEY], undefined);

  // 未受信的 node_repl（例如用户自定义同名 server）：完全不注入。
  const untrusted = omitMcpServers(servers, new Set(), new Set());
  const untrustedEnv = untrusted.node_repl?.env ?? {};
  assert.equal(untrustedEnv[ZCODE_CUA_BROKER_SOCKET_ENV_KEY], undefined);
  assert.equal(untrustedEnv[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY], undefined);
  assert.equal(untrustedEnv[ZCODE_CUA_BROKER_TOKEN_ENV_KEY], undefined);
  assert.equal(untrustedEnv[ZCODE_CUA_NODE_REPL_HOST_ENV_KEY], undefined);
});
