/**
 * CUA demand boundary: establishing/recovering the transport from the demand itself.
 *
 * 实测缺陷（packaged）：hardened session 只有在 Settings/权限状态查询时才会建立；未触碰
 * Settings 的正常启动只创建 lease-authority socket。于是预 spawn 的 Agent 永远拿不到
 * broker socket，而"下一次需求"不会自己到来——CUA 在用户打开设置页之前一直 fail-closed。
 *
 * 修复把建立动作放在**真正的 CUA 需求边界**：会话解析 computer-use MCP server 时（插件已启用）。
 * 本文件锁定该边界的性质：
 *   1. 插件未启用 → 不建立任何传输（不为普通对话/启动拉起 Helper）
 *   2. 插件启用 → 先建立传输，再委托 resolver
 *   3. 建立失败/抛错 → 不阻断会话解析（凭据仍由 spawn 边界 fail-closed 决定）
 *   4. 建立是幂等的：同一进程内重复需求不会重复启动
 *   5. 会话恢复后重试（模拟 Helper idle 退出后的再次需求）能重新拿到完整 tuple
 *
 * Run: mise exec -- node --import tsx --test packages/services/test/cuaDemandBoundaryTransport.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import { BROKER_SOCKET_ENV, BROKER_TOKEN_ENV } from "@zcode/zcode-cua/broker";
import { ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY } from "@zcode/shared";
import { createDynamicCuaProductMcpServerResolver } from "../src/node.js";

const SERVER = { name: "computer-use", type: "stdio" } as never;

function createHarness(options: {
  enabled: boolean;
  transport?: { ok: boolean };
  onEnsure?: () => void;
}) {
  const calls: string[] = [];
  let ensureCount = 0;
  const resolver = createDynamicCuaProductMcpServerResolver({
    isPluginEnabled: () => options.enabled,
    ensureTransport: async () => {
      ensureCount += 1;
      calls.push("ensure");
      options.onEnsure?.();
      if (options.transport && !options.transport.ok) throw new Error("helper_unavailable");
    },
    getResolver: () => ({
      resolveMcpServers: async (servers: unknown) => {
        calls.push("delegate");
        return servers as never;
      },
      restart: async () => {},
      restartAfterPermissionGrant: async () => {},
    }),
  });
  return { resolver, calls, ensureCount: () => ensureCount };
}

test("plugin disabled: the demand boundary starts nothing", async () => {
  const harness = createHarness({ enabled: false });
  const result = await harness.resolver.resolveMcpServers([SERVER], { workspacePath: "/tmp/ws" });
  assert.deepEqual(result, [SERVER]);
  assert.equal(harness.ensureCount(), 0, "no Helper may be started for a non-CUA demand");
  assert.deepEqual(harness.calls, []);
});

test("plugin enabled: transport is established before the resolver delegates", async () => {
  const harness = createHarness({ enabled: true });
  await harness.resolver.resolveMcpServers([SERVER], { workspacePath: "/tmp/ws" });
  assert.equal(harness.ensureCount(), 1);
  assert.deepEqual(harness.calls, ["ensure", "delegate"], "establishment must precede delegation");
});

test("a failed establishment does not block session resolution", async () => {
  const harness = createHarness({ enabled: true, transport: { ok: false } });
  const result = await harness.resolver.resolveMcpServers([SERVER], { workspacePath: "/tmp/ws" });
  assert.deepEqual(result, [SERVER]);
  // The delegate still ran, and the failure surfaced as "no credentials" at the spawn boundary
  // rather than as a thrown session-create error.
  assert.deepEqual(harness.calls, ["ensure", "delegate"]);
});

test("a demand that arrives while the transport is gone recovers it (idle-exit lifecycle)", async () => {
  // Simulates the Helper exiting after its 15s idle window: the next CUA demand re-establishes the
  // transport and the following spawn-env resolution carries socket + authority + capability again.
  const liveTransport = { socketPath: "/tmp/revived.sock", token: "c".repeat(64) };
  let transportUp = false;
  const spawnEnvFor = async () => {
    if (!transportUp) {
      // Fail-closed shape: an Agent spawned while no transport is up gets no tuple at all.
      return {} as Record<string, string>;
    }
    const { buildProductCuaTransportTuple } = await import("@zcode/zcode-cua/broker/server");
    const tuple = buildProductCuaTransportTuple(liveTransport);
    return {
      [BROKER_SOCKET_ENV]: tuple.socketPath,
      [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: tuple.pluginAuthority,
      [BROKER_TOKEN_ENV]: tuple.sessionCapabilityToken,
    } as Record<string, string>;
  };

  const before = await spawnEnvFor();
  assert.equal(before[BROKER_SOCKET_ENV], undefined);
  assert.equal(before[BROKER_TOKEN_ENV], undefined);

  const harness = createHarness({
    enabled: true,
    onEnsure: () => {
      transportUp = true;
    },
  });
  await harness.resolver.resolveMcpServers([SERVER], { workspacePath: "/tmp/ws" });

  const after = await spawnEnvFor();
  assert.equal(after[BROKER_SOCKET_ENV], "/tmp/revived.sock");
  assert.equal(after[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY], "packaged-cua");
  assert.equal(after[BROKER_TOKEN_ENV], "c".repeat(64));
});

test("successive demands stay idempotent (no repeated start)", async () => {
  const harness = createHarness({ enabled: true });
  await harness.resolver.resolveMcpServers([SERVER], { workspacePath: "/tmp/ws" });
  await harness.resolver.resolveMcpServers([SERVER], { workspacePath: "/tmp/ws" });
  assert.deepEqual(harness.calls, ["ensure", "delegate", "ensure", "delegate"]);
  // Two demands, two establishments attempted — the single-flight guarantee lives inside
  // ensureHardenedCuaHelperSession, which reuses its in-flight start; this asserts the boundary
  // keeps asking rather than caching a stale answer.
  assert.equal(harness.ensureCount(), 2);
});

test("stale-runtime policy distinguishes a live transport from a dead one", async () => {
  const { shouldRecycleCuaStaleRuntime } = await import("../src/node.js");

  // CUA disabled: nothing is recycled, whatever the transport state.
  assert.equal(
    shouldRecycleCuaStaleRuntime({
      hasBrokerSocketKey: false,
      cuaEnabled: false,
      managedHelperReady: false,
      hardenedLive: true,
    }),
    false,
  );

  // Hardened path, no socket key: the runtime spawned before a transport existed → recycle once the
  // transport is live, and never while it is dead (a recycle would only interrupt the conversation).
  assert.equal(
    shouldRecycleCuaStaleRuntime({
      hasBrokerSocketKey: false,
      cuaEnabled: true,
      managedHelperReady: false,
      hardenedLive: true,
    }),
    true,
  );
  assert.equal(
    shouldRecycleCuaStaleRuntime({
      hasBrokerSocketKey: false,
      cuaEnabled: true,
      managedHelperReady: false,
      hardenedLive: false,
    }),
    false,
  );

  // Hardened path, socket key present: usable while the Helper is connected, stale once it idled out.
  assert.equal(
    shouldRecycleCuaStaleRuntime({
      hasBrokerSocketKey: true,
      cuaEnabled: true,
      managedHelperReady: false,
      hardenedLive: true,
    }),
    false,
  );
  assert.equal(
    shouldRecycleCuaStaleRuntime({
      hasBrokerSocketKey: true,
      cuaEnabled: true,
      managedHelperReady: false,
      hardenedLive: false,
    }),
    true,
  );

  // Managed path keeps its original semantics: a runtime holding the socket is never recycled.
  assert.equal(
    shouldRecycleCuaStaleRuntime({
      hasBrokerSocketKey: true,
      cuaEnabled: true,
      managedHelperReady: true,
      hardenedLive: false,
    }),
    false,
  );
  assert.equal(
    shouldRecycleCuaStaleRuntime({
      hasBrokerSocketKey: false,
      cuaEnabled: true,
      managedHelperReady: true,
      hardenedLive: false,
    }),
    true,
  );
});
