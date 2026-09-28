// CUA stale pre-credential Agent 的需求边界回收回归。
//
// 复现 packaged 0.1.0-alpha.1 的实际故障序列（见 0.1.0-alpha.1 acceptance 记录）：
//   1. Agent 需求先于 Helper 出现 → resolveSpawnEnv fail-closed（spawn env 只有
//      ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE，没有 broker socket/authority）
//   2. Helper 随后恢复（settings getStatus 懒启动 hardened session）
//   3. 之后同一 workspace 的会话继续复用旧 Agent → node_repl 永远拿不到
//      ZCODE_CUA_PERMISSION_BROKER_SOCKET → "Computer Use is unavailable for this
//      node_repl session"
//
// 这里用真实的 ZCodeAgentProcessManager/ZCodeAgentService 进程装配锁定修复行为：
// - Helper 未恢复时绝不回收（fail-closed 语义不被削弱，也不产生进程抖动）
// - Helper 恢复后的下一个模型执行需求边界回收一次，新 spawn 拿到 broker 凭据键
// - 回收后的 runtime 已持有凭据键 → 不再反复回收
// - spawn env 键集合只暴露键名，凭据值永不回读
//
// Run: mise exec -- node --import tsx --test packages/services/test/cuaStaleAgentRecovery.test.ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BROKER_SOCKET_ENV, BROKER_UNAVAILABLE_ENV } from "@zcode/zcode-cua/broker";
import { ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY } from "@zcode/shared";
import { createZCodeAgentService } from "../src/zcode-agent/zcodeAgentService.js";
import { ZCodeAgentProcessManager } from "../src/zcode-agent/zcodeAgentProcessManager.js";
import type { RuntimeProcessLifecycleReporter } from "../src/process/runtimeProcessLifecycle.js";
import type { ZCodeAgentCommand } from "../src/zcode-agent/zcodeAgentProcessManager.js";

/** 永不应答的长驻占位进程：只验证进程生命周期与 spawn env 记录，不涉及协议。 */
function createSleeperCommand(): ZCodeAgentCommand {
  return {
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1 << 30)"],
    supportsStorageStartup: false,
  };
}

function createReadySelectionView(): unknown {
  return {
    revision: 1,
    providers: [
      {
        providerId: "test-provider",
        config: {},
        models: [{ modelId: "test-model" }],
      },
    ],
  };
}

interface SpawnRecord {
  pid: number;
  exited: boolean;
}

function createLifecycleRecorder() {
  const spawns = new Map<number, SpawnRecord>();
  const reporter: RuntimeProcessLifecycleReporter = {
    onSpawn(event) {
      spawns.set(event.pid, { pid: event.pid, exited: false });
    },
    onExit(event) {
      const record = spawns.get(event.pid);
      if (record) record.exited = true;
    },
  };
  return { spawns, reporter };
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      assert.ok(predicate(), `timeout waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("stale pre-credential runtime is recycled at the next demand only after helper recovery", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "cua-stale-agent-"));
  const sleeper = createSleeperCommand();
  const { spawns, reporter } = createLifecycleRecorder();
  /** 每次 spawn 依次下发：fail-closed（Helper 未就绪）→ 已恢复凭据。 */
  const spawnEnvQueue: Array<Record<string, string>> = [
    { [BROKER_UNAVAILABLE_ENV]: "broker_unavailable: helper not started (test)" },
    {
      [BROKER_SOCKET_ENV]: join(workspacePath, "test-broker.sock"),
      [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: "authority-test",
    },
  ];
  const spawnEnvSeen: Array<ReadonlySet<string>> = [];
  /** 与 node.ts 裁决同源的最小镜像：Helper 恢复且 runtime 未持凭据键才同意回收。 */
  let helperReady = false;
  const policyCalls: Array<ReadonlySet<string>> = [];

  const service = createZCodeAgentService({
    commandResolver: async () => sleeper,
    resolveSpawnEnv: async () => {
      const env = spawnEnvQueue.shift() ?? spawnEnvQueue[spawnEnvQueue.length - 1];
      spawnEnvSeen.push(new Set(Object.keys(env)));
      return env;
    },
    modelSelectionReadinessSource: {
      getView: async () => createReadySelectionView() as never,
    },
    shouldRecycleRuntimeBeforeModelExecutionDemand: ({ spawnEnvKeys }) => {
      policyCalls.push(spawnEnvKeys);
      if (spawnEnvKeys.has(BROKER_SOCKET_ENV)) return false;
      return helperReady;
    },
    processLifecycleReporter: reporter,
  });
  const params = { workspacePath };
  try {
    // 1. Agent 需求先于 Helper：fail-closed spawn，无 broker 凭据键。
    const first = await service.initialize(params);
    assert.equal(first.available, true, `first initialize failed: ${first.reason}`);
    await waitFor(() => spawns.size >= 1, "first agent spawn");
    assert.equal(spawnEnvSeen[0]?.has(BROKER_SOCKET_ENV), false);

    // 2. Helper 未恢复：同一需求边界绝不回收（不产生新 spawn，不扰动既有 runtime）。
    const second = await service.initialize(params);
    assert.equal(second.available, true, `second initialize failed: ${second.reason}`);
    assert.equal(spawns.size, 1, "helper 未恢复时不得回收/重建 runtime");
    assert.equal(policyCalls.length, 1, "每次需求边界恰好裁决一次");

    // 3. Helper 恢复后的下一个需求边界：回收一次，重新 spawn 拿到凭据键。
    helperReady = true;
    const third = await service.initialize(params);
    assert.equal(third.available, true, `post-recovery initialize failed: ${third.reason}`);
    await waitFor(() => spawns.size >= 2, "post-recovery respawn");
    assert.equal(spawnEnvSeen[1]?.has(BROKER_SOCKET_ENV), true);
    assert.equal(spawnEnvSeen[1]?.has(ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY), true);
    const [oldPid, newPid] = [...spawns.keys()];
    assert.notEqual(oldPid, newPid);
    await waitFor(() => spawns.get(oldPid)?.exited === true, "stale runtime termination");

    // 4. 回收后的 runtime 已持凭据：不再反复回收。
    const fourth = await service.initialize(params);
    assert.equal(fourth.available, true, `fourth initialize failed: ${fourth.reason}`);
    // 三次裁决：t2（未恢复→不回收）、t3（已恢复→回收）、t4（已持凭据→不回收）。
    // t1 走首次启动路径，不进入复用裁决。
    await waitFor(() => policyCalls.length >= 3, "fourth demand policy call");
    assert.equal(policyCalls[2]?.has(BROKER_SOCKET_ENV), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(spawns.size, 2, "已持凭据的 runtime 不得再回收");
  } finally {
    await service.disposeAllAndWait().catch(() => undefined);
    await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("resolved spawn env keys expose key names only, per current runtime", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "cua-stale-manager-"));
  const sleeper = createSleeperCommand();
  const manager = new ZCodeAgentProcessManager({
    commandResolver: async () => sleeper,
    resolveSpawnEnv: async () => ({
      [BROKER_SOCKET_ENV]: "/tmp/cua-test-broker.sock",
      [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: "authority-test",
    }),
  });
  const params = { workspacePath };
  try {
    assert.equal(
      manager.getResolvedSpawnEnvKeys(params),
      undefined,
      "无 runtime 时应返回 undefined",
    );
    await manager.getClient(params);
    const keys = manager.getResolvedSpawnEnvKeys(params);
    assert.ok(keys);
    assert.deepEqual(
      [...keys].sort(),
      [BROKER_SOCKET_ENV, ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY].sort(),
    );
    assert.equal(
      manager.getResolvedSpawnEnvKeys({ workspacePath: join(workspacePath, "other") }),
      undefined,
      "其他 workspace 无 runtime",
    );
    await manager.disposeWorkspace(params);
    assert.equal(manager.getResolvedSpawnEnvKeys(params), undefined, "runtime 回收后无键集合");
  } finally {
    manager.disposeAll();
    await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("recovery policy stays peek-only and fail-closed in the integrated assembly", async () => {
  // node.ts 无法在单测内整图装配（与 cuaHardenedRuntimeBoundary.test.ts 同样的约束），
  // 这里锁定装配源里与安全相关的裁决不变量。
  const { readFile } = await import("node:fs/promises");
  const nodeSource = await readFile(new URL("../src/node.ts", import.meta.url), "utf8");
  const policyStart = nodeSource.indexOf("shouldRecycleRuntimeBeforeModelExecutionDemand");
  assert.ok(policyStart > 0, "node.ts 必须注入需求边界回收裁决");
  const policyEnd = nodeSource.indexOf("sessionRuntimePreferencesAuthority", policyStart);
  const policy = nodeSource.slice(policyStart, policyEnd);

  // 已持凭据的 runtime 永不回收。
  assert.match(policy, /spawnEnvKeys\.has\(BROKER_SOCKET_ENV\)\) return false/);
  // CUA 关闭时永不回收（插件门控与 resolveSpawnEnv 同源）。
  assert.match(policy, /isCuaEnabledForContext\(context\)/);
  // 裁决 peek-only：绝不拉起 Helper / 绝不 acquire。
  assert.match(policy, /peekHardenedCuaHelperSession\(\) !== null/);
  assert.doesNotMatch(policy, /getOrCreateDefaultCuaProductHelper|ensureHardenedCuaHelperSession/);
  assert.doesNotMatch(policy, /\.start\(\)/);

  // service 侧安全边界：有在飞 RPC / 活跃 CUA turn / 并发启动时绝不回收。
  const serviceSource = await readFile(
    new URL("../src/zcode-agent/zcodeAgentService.ts", import.meta.url),
    "utf8",
  );
  assert.match(serviceSource, /async function maybeRecycleStaleRuntimeForDemand/);
  assert.match(serviceSource, /pendingOperationRequestCount > 0/);
  assert.match(serviceSource, /storageStartup\.isWaiting/);
  assert.match(serviceSource, /if \(cuaOperationTurnTracker\?\.hasActiveTurn\(\)\) return false;/);
  assert.match(serviceSource, /waitingWorkspaceStartups\.has\(workspaceKey\)/);
  // 回收后重入必须走全新 spawn 路径（重新执行 resolveSpawnEnv）。
  assert.match(
    serviceSource,
    /maybeRecycleStaleRuntimeForDemand\(workspaceKey, params, active\)[^]*?return getClient\(params\)/,
  );
});
