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
// 冷启动顺序补充（packaged 63836/63852 实测）：readiness 转换发生在预 spawn 的
// resolveSpawnEnv 内部，恢复边界的扫描此时还没有任何可扫描的 client → 空转且不再被
// 触发。注册结算因此也接入同一次扫描（spawn-settle 收敛）：
// - readiness 先于注册完成时，注册结算自行收敛，无需模型失败或人工触发
// - 陈旧代际在运行中（CLI running 会话）绝不回收，工作结束后由下一个安全边界收敛
// - 健康/持凭据代际不因 spawn-settle 触发被评估或抖动；idle 退出语义保持不变
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

/** 长驻占位 Agent：只应答 session/list（预热线程用它创建只读 entry），其余请求不回。 */
function createSleeperCommand(): ZCodeAgentCommand {
  return {
    command: process.execPath,
    args: [
      "-e",
      [
        "let buf='';",
        "process.stdin.on('data',(c)=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){",
        "const line=buf.slice(0,i);buf=buf.slice(i+1);",
        "try{const m=JSON.parse(line);if(m.id!==undefined&&m.method==='session/list'){",
        "process.stdout.write(JSON.stringify({id:m.id,result:{sessions:[]}})+'\\n')}}catch{}}});",
        "setInterval(()=>{},1<<30);",
      ].join(" "),
    ],
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

/** 长驻占位 Agent：session/list 的状态由状态文件决定（running → busy，其他 → 空闲）。 */
function createStatefulSleeperCommand(statePath: string): ZCodeAgentCommand {
  return {
    command: process.execPath,
    args: [
      "-e",
      [
        "const fs=require('fs');",
        `const statePath=${JSON.stringify(statePath)};`,
        "let buf='';",
        "process.stdin.on('data',(c)=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){",
        "const line=buf.slice(0,i);buf=buf.slice(i+1);",
        "try{const m=JSON.parse(line);if(m.id!==undefined&&m.method==='session/list'){",
        "let status='idle';try{status=fs.readFileSync(statePath,'utf8').trim()}catch{}",
        "const sessions=status==='running'?[{sessionId:'sess-busy',workspace:{workspacePath:'/busy',workspaceKey:'/busy'},sessionKind:'interactive',title:'busy',mode:'build',status:'running',createdAt:1,updatedAt:2}]:[];",
        "process.stdout.write(JSON.stringify({id:m.id,result:{sessions}})+'\\n')}}catch{}}});",
        "setInterval(()=>{},1<<30);",
      ].join(" "),
    ],
    supportsStorageStartup: false,
  };
}

test("pre-credential generation converges automatically when readiness lands during the spawn", async () => {
  // 复现 packaged 冷启动的失败顺序：readiness 转换发生在预 spawn 窗口内（readiness 先于
  // 注册结算完成），此时 Helper 恢复边界的扫描还没有任何 client 可扫描。注册结算必须
  // 补跑同一次扫描收敛，不得要求模型先失败一次或人工触发。旧实现（80e48e6）没有该
  // 触发：回收永远不会发生，本测试超时失败。
  const workspacePath = await mkdtemp(join(tmpdir(), "cua-stale-race-"));
  const sleeper = createSleeperCommand();
  const { spawns, reporter } = createLifecycleRecorder();
  const spawnEnvQueue: Array<Record<string, string>> = [
    { [BROKER_UNAVAILABLE_ENV]: "broker_unavailable: helper not started (prewarm lost race)" },
    {
      [BROKER_SOCKET_ENV]: join(workspacePath, "test-broker.sock"),
      [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: "authority-test",
    },
  ];
  const spawnEnvSeen: Array<ReadonlySet<string>> = [];
  /** readiness 在失败 spawn 的组合窗口内翻转（冷启动 1s 预算输掉、Helper 随后就绪）。 */
  let helperReady = false;
  const policyCalls: Array<ReadonlySet<string>> = [];

  const service = createZCodeAgentService({
    commandResolver: async () => sleeper,
    resolveSpawnEnv: async () => {
      const env = spawnEnvQueue.shift() ?? spawnEnvQueue[spawnEnvQueue.length - 1];
      spawnEnvSeen.push(new Set(Object.keys(env)));
      helperReady = true;
      return env;
    },
    modelSelectionReadinessSource: {
      getView: async () => createReadySelectionView() as never,
    },
    shouldRecycleStaleProvisionedRuntime: ({ spawnEnvKeys }) => {
      policyCalls.push(spawnEnvKeys);
      if (spawnEnvKeys.has(BROKER_SOCKET_ENV)) return false;
      return helperReady;
    },
    processLifecycleReporter: reporter,
  });
  const params = { workspacePath };
  try {
    // 1. 预 spawn（fail-closed 代际）；readiness 在同一窗口内已就绪。
    const sessions = await service.listSessions({ ...params, runtimePolicy: "start-if-needed" });
    assert.deepEqual(sessions, []);
    await waitFor(() => spawns.size >= 1, "prewarm agent spawn");
    assert.equal(spawnEnvSeen[0]?.has(BROKER_SOCKET_ENV), false);
    const stalePid = [...spawns.keys()][0];
    console.error("__M1__ registered");

    // 2. 不调用任何手工扫描：注册结算触发必须自行收敛（回收恰好一次）。
    await waitFor(() => spawns.get(stalePid)?.exited === true, "automatic stale runtime recycle");
    console.error("__M2__ recycled");
    assert.ok(policyCalls.length >= 1, "spawn 结算扫描必须评估裁决");

    // 3. 下一个自然需求拉起替代代际：拿到当前 broker tuple。
    console.error("__M3__ before respawn");
    const followup = await service.listSessions({ ...params, runtimePolicy: "start-if-needed" });
    console.error("__M4__ respawned");
    assert.deepEqual(followup, []);
    await waitFor(() => spawns.size >= 2, "post-recovery respawn");
    assert.equal(spawnEnvSeen[1]?.has(BROKER_SOCKET_ENV), true);
    assert.equal(spawnEnvSeen[1]?.has(ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY), true);
    console.error("__M5__ env checked");
    const replacementPid = [...spawns.keys()].find((pid) => pid !== stalePid);
    assert.ok(replacementPid, "replacement runtime must have a new pid");

    // 4. 替代代际已持凭据：扫描不再回收（无循环）。
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(spawns.size, 2);
    assert.equal(await service.recycleStaleProvisionedRuntimes(), 0);
  } finally {
    await service.disposeAllAndWait().catch(() => undefined);
    await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a busy stale runtime is never killed and converges on the next safe boundary", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "cua-stale-busy-"));
  const sessionStatePath = join(workspacePath, "session-state.txt");
  const sleeper = createStatefulSleeperCommand(sessionStatePath);
  const { spawns, reporter } = createLifecycleRecorder();
  const spawnEnvQueue: Array<Record<string, string>> = [
    { [BROKER_UNAVAILABLE_ENV]: "broker_unavailable: helper not started (prewarm lost race)" },
    {
      [BROKER_SOCKET_ENV]: join(workspacePath, "test-broker.sock"),
      [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: "authority-test",
    },
  ];
  const spawnEnvSeen: Array<ReadonlySet<string>> = [];
  let helperReady = false;

  const service = createZCodeAgentService({
    commandResolver: async () => sleeper,
    resolveSpawnEnv: async () => {
      const env = spawnEnvQueue.shift() ?? spawnEnvQueue[spawnEnvQueue.length - 1];
      spawnEnvSeen.push(new Set(Object.keys(env)));
      helperReady = true;
      return env;
    },
    modelSelectionReadinessSource: {
      getView: async () => createReadySelectionView() as never,
    },
    shouldRecycleStaleProvisionedRuntime: ({ spawnEnvKeys }) => {
      if (spawnEnvKeys.has(BROKER_SOCKET_ENV)) return false;
      return helperReady;
    },
    processLifecycleReporter: reporter,
  });
  const params = { workspacePath };
  try {
    // 1. 陈旧代际在运行中（CLI 报告 running 会话）：注册结算触发扫描，但绝不回收。
    const { writeFileSync } = await import("node:fs");
    writeFileSync(sessionStatePath, "running");
    const sessions = await service.listSessions({ ...params, runtimePolicy: "start-if-needed" });
    // CLI 真相就是“有 running 会话”（会话列表由状态文件驱动）。
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.status, "running");
    await waitFor(() => spawns.size >= 1, "prewarm agent spawn");
    const stalePid = [...spawns.keys()][0];
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(spawns.get(stalePid)?.exited, false, "忙碌的 runtime 不得被回收");
    assert.equal(spawns.size, 1, "忙碌窗口内不得产生替代代际");

    // 2. 工作结束（CLI 报告空闲）：下一个安全边界回收恰好一次，替代代际带凭据。
    writeFileSync(sessionStatePath, "idle");
    assert.equal(await service.recycleStaleProvisionedRuntimes(), 1);
    await waitFor(() => spawns.get(stalePid)?.exited === true, "idle stale runtime recycle");
    const followup = await service.listSessions({ ...params, runtimePolicy: "start-if-needed" });
    assert.deepEqual(followup, []);
    await waitFor(() => spawns.size >= 2, "replacement spawn after idle");
    assert.equal(spawnEnvSeen[1]?.has(BROKER_SOCKET_ENV), true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(spawns.size, 2, "恰好一代替代运行时");
  } finally {
    await service.disposeAllAndWait().catch(() => undefined);
    await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("healthy credentialed generations are never touched by the spawn-settle sweep", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "cua-stale-healthy-"));
  const sleeper = createSleeperCommand();
  const { spawns, reporter } = createLifecycleRecorder();
  const spawnEnvSeen: Array<ReadonlySet<string>> = [];
  let helperReady = true;
  const policyCalls: Array<ReadonlySet<string>> = [];

  const service = createZCodeAgentService({
    commandResolver: async () => sleeper,
    resolveSpawnEnv: async () => {
      const env = {
        [BROKER_SOCKET_ENV]: join(workspacePath, "test-broker.sock"),
        [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: "authority-test",
      };
      spawnEnvSeen.push(new Set(Object.keys(env)));
      return env;
    },
    modelSelectionReadinessSource: {
      getView: async () => createReadySelectionView() as never,
    },
    shouldRecycleStaleProvisionedRuntime: ({ spawnEnvKeys }) => {
      policyCalls.push(spawnEnvKeys);
      // 与 node.ts 裁决同源的最小镜像：无凭据键 → 传输可用即可回收；有凭据键 → 仅在
      // 传输失效时回收（Helper idle 退出后由边界重连/回收，恢复后不再回收）。
      return spawnEnvKeys.has(BROKER_SOCKET_ENV) ? !helperReady : helperReady;
    },
    processLifecycleReporter: reporter,
  });
  const params = { workspacePath };
  try {
    // 1. 健康代际（已持凭据键）：spawn 结算触发不调度、不评估、不回收。
    await service.listSessions({ ...params, runtimePolicy: "start-if-needed" });
    await waitFor(() => spawns.size >= 1, "healthy agent spawn");
    const healthyPid = [...spawns.keys()][0];
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(spawnEnvSeen[0]?.has(BROKER_SOCKET_ENV), true);
    assert.equal(policyCalls.length, 0, "持凭据的代际不得触发 spawn 结算扫描");
    assert.equal(spawns.get(healthyPid)?.exited, false);

    // 2. 显式边界扫描：凭据键在 + 传输可用 → 不回收（既有语义）。
    assert.equal(await service.recycleStaleProvisionedRuntimes(), 0);
    assert.equal(policyCalls.length, 1);

    // 3. Helper 按 15s idle 退出（传输失效）后，持凭据 runtime 不因 spawn 结算触发被抖动；
    // 既有边界语义（传输失效可回收）保持不变，恢复连接后不再回收（无循环）。
    helperReady = false;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(spawns.size, 1, "idle 退出不得由 spawn 结算触发回收");
    assert.equal(policyCalls.length, 1, "持凭据的代际始终不触发 spawn 结算扫描");
    assert.equal(await service.recycleStaleProvisionedRuntimes(), 1);
    await waitFor(() => spawns.get(healthyPid)?.exited === true, "transport-dead recycle");
    const followup = await service.listSessions({ ...params, runtimePolicy: "start-if-needed" });
    assert.deepEqual(followup, []);
    await waitFor(() => spawns.size >= 2, "post-recovery respawn");
    helperReady = true;
    assert.equal(await service.recycleStaleProvisionedRuntimes(), 0, "恢复后不得再回收");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(spawns.size, 2, "无循环回收");
  } finally {
    await service.disposeAllAndWait().catch(() => undefined);
    await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("stale pre-credential runtime is recycled by the helper-recovery sweep only", async () => {
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
    shouldRecycleStaleProvisionedRuntime: ({ spawnEnvKeys }) => {
      policyCalls.push(spawnEnvKeys);
      if (spawnEnvKeys.has(BROKER_SOCKET_ENV)) return false;
      return helperReady;
    },
    processLifecycleReporter: reporter,
  });
  const params = { workspacePath };
  try {
    // 1. 预热（packaged 实况）：只读 read 路径先 spawn Agent（fail-closed，无凭据键）。
    const sessions = await service.listSessions({ ...params, runtimePolicy: "start-if-needed" });
    assert.deepEqual(sessions, []);
    await waitFor(() => spawns.size >= 1, "prewarm agent spawn");
    assert.equal(spawnEnvSeen[0]?.has(BROKER_SOCKET_ENV), false);

    // 2. Helper 未恢复：恢复扫描评估裁决但绝不回收（fake agent 无 running 会话）。
    // spawn 结算触发会先自行评估一次（fail-closed 代际），先等它落地再测显式扫描的增量。
    await waitFor(() => policyCalls.length >= 1, "spawn-settle sweep consulted the verdict");
    const callsBeforeExplicitSweep = policyCalls.length;
    assert.equal(await service.recycleStaleProvisionedRuntimes(), 0);
    assert.equal(spawns.size, 1, "helper 未恢复时不得回收/重建 runtime");
    assert.equal(policyCalls.length, callsBeforeExplicitSweep + 1, "恢复扫描必须评估裁决");
    assert.equal(policyCalls.at(-1)?.has(BROKER_SOCKET_ENV), false);

    // 3. Helper 恢复后的下一次扫描：回收一次。扫描本身不 respawn——新 runtime 由
    // 下一个自然需求（这里是只读 listSessions）按全新 spawn 路径拉起，拿到凭据键。
    helperReady = true;
    assert.equal(await service.recycleStaleProvisionedRuntimes(), 1);
    await waitFor(
      () => spawns.get([...spawns.keys()][0])?.exited === true,
      "stale runtime termination",
    );
    const [oldPid] = [...spawns.keys()];
    const followup = await service.listSessions({ ...params, runtimePolicy: "start-if-needed" });
    assert.deepEqual(followup, []);
    await waitFor(() => spawns.size >= 2, "post-recovery respawn");
    assert.equal(spawnEnvSeen[1]?.has(BROKER_SOCKET_ENV), true);
    assert.equal(spawnEnvSeen[1]?.has(ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY), true);
    const newPid = [...spawns.keys()].find((pid) => pid !== oldPid);
    assert.ok(newPid, "replacement runtime must have a new pid");

    // 4. 回收后的 runtime 已持凭据：后续扫描不再回收（无循环）。
    // 裁决序列：旧 runtime（无凭据键）→ 回收；新 runtime（有凭据键）→ false。
    assert.equal(await service.recycleStaleProvisionedRuntimes(), 0);
    assert.equal(policyCalls.at(-1)?.has(BROKER_SOCKET_ENV), true, "最终扫描作用于持凭据 runtime");
    // 持凭据的代际不再触发 spawn 结算扫描：新增裁决只来自上面的显式扫描。
    const callsAfterFinalSweep = policyCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(policyCalls.length, callsAfterFinalSweep, "持凭据 runtime 不再触发结算扫描");
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
  const policyStart = nodeSource.indexOf("shouldRecycleStaleProvisionedRuntime");
  assert.ok(policyStart > 0, "node.ts 必须注入 Helper 恢复扫描的回收裁决");
  // 只取裁决函数本身：紧随其后的 onCuaExecutionDemand 是需求边界的恢复入口（允许调用恢复），
  // 不属于裁决体，混进来会让 peek-only 断言失去意义。
  const policyEnd = nodeSource.indexOf("// 执行需求边界", policyStart);
  const policy = nodeSource.slice(policyStart, policyEnd);
  // 扫描只在 Helper 恢复边界触发；绝不挂在 send/getClient 路径上（packaged 实测：
  // 发送边界回收会冲掉 UI 草稿绑定，turn 静默丢失）。
  assert.match(nodeSource, /scheduleCuaStaleRuntimeRecoverySweep\(\)/);
  assert.match(
    nodeSource,
    /hardenedCuaHelperSession = started\.session;[^]*?scheduleCuaStaleRuntimeRecoverySweep\(\)/,
  );
  // 传输就绪边界的另一半：托管 Helper 后台 startup 真正成功时也补跑同一次扫描；
  // 装配层把它接到 scheduleCuaStaleRuntimeRecoverySweep（packaged 冷启动预 spawn 输家
  // 在 Helper ready 后自动收敛）。
  assert.match(
    nodeSource,
    /setCuaProductHelperReadyListener\(\(\) => scheduleCuaStaleRuntimeRecoverySweep\(\)\)/,
  );
  assert.match(nodeSource, /cuaProductHelperReadyListener\?\.\(\)/);
  assert.match(
    nodeSource,
    /recycleStaleProvisionedRuntimesRef = \(\) => zcodeAgentService\.recycleStaleProvisionedRuntimes\(\)/,
  );
  const serviceSlice = nodeSource.slice(0, policyStart);
  assert.doesNotMatch(serviceSlice, /getClient[^]*?recycleStaleProvisionedRuntimes/);

  // 裁决仍以键名 + 插件门控为输入，并显式把“该传输是否可用”作为独立事实传入：Helper 按
  // 15s idle 退出后 socket 名与 capability 都还在，只有 helperConnected 能区分可用/已失效。
  assert.match(policy, /hasBrokerSocketKey: context\.spawnEnvKeys\.has\(BROKER_SOCKET_ENV\)/);
  assert.match(policy, /cuaEnabled: isCuaEnabledForContext\(context\)/);
  assert.match(policy, /hardenedLive = hardenedSession\?\.host\.helperConnected === true/);
  assert.match(policy, /shouldRecycleCuaStaleRuntime\(\{/);
  // 裁决 peek-only：绝不拉起 Helper / 绝不 acquire / 绝不 start。
  assert.doesNotMatch(policy, /getOrCreateDefaultCuaProductHelper|ensureHardenedCuaHelperSession/);
  assert.doesNotMatch(policy, /\.start\(\)/);
  assert.doesNotMatch(policy, /requestHardenedCuaTransportRecovery/);
  // 纯函数的语义不变量：已持凭据且传输可用时永不回收；传输失效时绝不当作可用。
  const { shouldRecycleCuaStaleRuntime } = await import("../src/node.js");
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

  // service 侧安全边界：有在飞 RPC / 活跃 CUA turn / 并发启动时绝不回收。
  const serviceSource = await readFile(
    new URL("../src/zcode-agent/zcodeAgentService.ts", import.meta.url),
    "utf8",
  );
  assert.match(serviceSource, /async function maybeRecycleStaleRuntimeForDemand/);
  // turn 真相以 CLI 为准：running/waiting 会话绝不回收；并发 UI 读不构成忙。
  assert.match(serviceSource, /async function hasRunningSessionTurn/);
  assert.match(serviceSource, /session\.status === "running" \|\| session\.status === "waiting"/);
  assert.match(serviceSource, /lifecycle: "observation", timeoutMs: 5_000/);
  assert.doesNotMatch(
    serviceSource,
    /pendingOperationRequestCount > 0[\s\S]{0,80}return false;\n\s*}\n\s*if \(cuaOperationTurnTracker/,
  );
  assert.match(serviceSource, /storageStartup\.isWaiting/);
  assert.match(serviceSource, /if \(cuaOperationTurnTracker\?\.hasActiveTurn\(\)\) return false;/);
  assert.match(serviceSource, /waitingWorkspaceStartups\.has\(workspaceKey\)/);
  // 扫描入口是唯一回收触发点；send/getClient 路径绝不回收。
  assert.match(serviceSource, /async recycleStaleProvisionedRuntimes\(\): Promise<number>/);
  assert.match(
    serviceSource,
    /for \(const \[workspaceKey, active\] of \[\.\.\.activeClientsByWorkspaceKey\]\)/,
  );
  const getClientBody = serviceSource.slice(
    serviceSource.indexOf("async function getClient("),
    serviceSource.indexOf("async function getReadOnlyClient("),
  );
  assert.ok(getClientBody.length > 0);
  assert.doesNotMatch(getClientBody, /maybeRecycleStaleRuntimeForDemand/);
  // spawn 结算触发：readiness 与注册顺序不定，两条注册路径各补跑同一次扫描；
  // 触发条件只看“缺 broker 键的 fail-closed 代际”，健康代际不调度（不新增回收类别）。
  assert.match(serviceSource, /function scheduleStaleRecoverySweepAfterSpawnSettle\(/);
  assert.match(
    serviceSource,
    /const spawnEnvKeys = processManager\.getResolvedSpawnEnvKeys\(params\);\n\s*if \(!spawnEnvKeys \|\| spawnEnvKeys\.has\(BROKER_SOCKET_ENV\)\) return;/,
  );
  assert.equal(
    (serviceSource.match(/scheduleStaleRecoverySweepAfterSpawnSettle\(params, /g) ?? []).length,
    2,
    "两条注册路径都必须接入 spawn 结算触发",
  );
  // 触发与公开入口共用同一个扫描本体；公开入口不得有第二份循环实现。
  assert.match(serviceSource, /async function sweepStaleProvisionedRuntimes\(\): Promise<number>/);
  assert.match(
    serviceSource,
    /async recycleStaleProvisionedRuntimes\(\): Promise<number> \{\n\s*return await sweepStaleProvisionedRuntimes\(\);/,
  );
});
