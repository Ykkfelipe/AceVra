/**
 * 后端迁移 × 真实 TaskIndexRepo（SQLite）的持久化边界测试（spec Amendment 3）。
 *
 * 覆盖：栅栏准入（含两个 Host 实例共享同一个库）、zcode 快照同步不得冲掉迁移字段、
 * 每个事务阶段崩溃后的重启恢复、存活 Host 的在途迁移不被抢占、恢复后的陈旧写入者不能提交、
 * 以及每一跳之间都「重启」一次的多跳链路。
 *
 * Run: mise exec -- node --import tsx --test packages/services/test/backendMigrationPersistence.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  BackendTransitionPhase,
  PendingBackendTransition,
  ZCodeTaskMeta,
} from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { setDataBaseDir } from "../src/paths.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import {
  migrateBackend,
  type BackendMigrationDependencies,
  type BackendMigrationTaskStore,
} from "../src/backend-migration/backendMigrationOrchestrator.js";
import { ConcurrentBackendTransitionError } from "../src/backend-migration/backendTransitionStateMachine.js";
import {
  createTaskIndexMigrationStore,
  readBackendMigrationTaskState,
} from "../src/backend-migration/taskIndexMigrationStore.js";
import { recoverOrphanedBackendTransitions } from "../src/backend-migration/recoverOrphanedBackendTransitions.js";
import { createOwnerLivenessCheck } from "../src/backend-migration/hostInstanceIdentity.js";

const WORKSPACE = "/example/workspace";
const TASK_ID = "task-migrate-1";
const REF = { workspacePath: WORKSPACE };

function baseMeta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: TASK_ID,
    traceId: "trace-1",
    workspacePath: WORKSPACE,
    title: "Migration task",
    mode: "build",
    createdAt: 1,
    updatedAt: 2,
    provider: "glm",
    model: "zai/glm-4.6",
    ...overrides,
  };
}

async function withDatabase(run: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "acevra-backend-migration-"));
  setDataBaseDir(dir);
  try {
    await run(join(dir, "tasks.sqlite"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

let rowCounter = 1;
function textRow(kind: "user" | "assistant", text: string, turnId: string): ConversationRow {
  const rowId = rowCounter++;
  if (kind === "user") {
    return {
      rowId,
      turnId,
      kind: "userInput",
      text,
      origin: "realUser",
      createdAt: rowId,
      createdAtSeq: rowId,
    } as ConversationRow;
  }
  return {
    rowId,
    turnId,
    kind: "assistantText",
    text,
    state: "complete",
    createdAt: rowId,
    createdAtSeq: rowId,
  } as ConversationRow;
}

interface FakeWorld {
  rows: ConversationRow[];
  threadCounter: number;
  abandoned: string[];
  seededDeleted: string[];
  prompts: string[];
}

function createDeps(params: {
  store: BackendMigrationTaskStore;
  world: FakeWorld;
  ownerInstanceId: string;
  clock: { value: number };
}): BackendMigrationDependencies {
  const { world } = params;
  return {
    now: () => (params.clock.value += 1),
    ownerInstanceId: params.ownerInstanceId,
    generateTranscriptRevision: (t) => `rev-${t.entries.length}`,
    readSourceHistory: async () => {
      // 模拟组合器：handoff 轮不属于规范历史。
      const rows = world.rows.filter((row) => row.turnId !== "handoff");
      return {
        rows,
        liveSegment: { firstRowId: rows[0]?.rowId ?? null, lastRowId: rows.at(-1)?.rowId ?? null },
      };
    },
    resolveDestinationBudget: () => ({ contextWindowTokens: 1_000_000 }),
    summarizePrefix: async () => "unused",
    workspacePath: WORKSPACE,
    taskTitle: "Migration task",
    codex: {
      createThread: async () => ({ codexThreadId: `thread-${(world.threadCounter += 1)}` }),
      runHandoffTurn: async ({ prompt }) => {
        world.prompts.push(prompt);
        const request = textRow("user", prompt, "handoff");
        const reply = textRow("assistant", "ACEVRA_HANDOFF_READY", "handoff");
        world.rows.push(request, reply);
        return {
          turnId: `codex-turn-${world.prompts.length}`,
          reachedNormalTerminalState: true,
          handoffTurnRows: [request, reply],
          replyText: "ACEVRA_HANDOFF_READY",
        };
      },
      abandonThread: async (id) => {
        world.abandoned.push(id);
      },
    },
    zcode: {
      seedHistory: async () => ({ seedLastRowId: world.rows.at(-1)?.rowId ?? null }),
      startAndConfirmReady: async () => ({ ready: true }),
      deleteSeededHistory: async (taskId) => {
        world.seededDeleted.push(taskId);
      },
    },
    store: params.store,
  };
}

function newWorld(): FakeWorld {
  return { rows: [], threadCounter: 0, abandoned: [], seededDeleted: [], prompts: [] };
}

/** 包一层 store：持久化到 crashAfter 阶段后，下一次写入永远挂起——模拟进程在这里死掉。 */
function crashingStore(
  inner: BackendMigrationTaskStore,
  crashAfter: BackendTransitionPhase,
): { store: BackendMigrationTaskStore; release: () => void; crashed: Promise<void> } {
  let crashed = false;
  let release!: () => void;
  let markCrashed!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const crashedSignal = new Promise<void>((resolve) => (markCrashed = resolve));
  const crash = (): void => {
    crashed = true;
    markCrashed();
  };
  const maybeHang = async (): Promise<void> => {
    if (crashed) await gate;
  };
  return {
    release,
    crashed: crashedSignal,
    store: {
      begin: async (taskId, pending) => {
        await inner.begin(taskId, pending);
        if (crashAfter === "prepared" && pending.phase === "prepared") crash();
      },
      advance: async (taskId, pending) => {
        await maybeHang();
        await inner.advance(taskId, pending);
        if (pending.phase === crashAfter && crashAfter !== "prepared") crash();
      },
      finish: async (taskId, pending, outcome) => {
        await maybeHang();
        await inner.finish(taskId, pending, outcome);
      },
      read: inner.read,
    },
  };
}

test("begin fence: a second migration is rejected even from another Host instance on the same database", async () => {
  await withDatabase(async (dbPath) => {
    const hostA = new TaskIndexRepo(dbPath);
    const hostB = new TaskIndexRepo(dbPath);
    await hostA.syncTaskMeta({ meta: baseMeta() });
    const pending: PendingBackendTransition = {
      phase: "prepared",
      to: "codex",
      requestedAt: 100,
      ownerInstanceId: "1:boot-a",
    };
    await createTaskIndexMigrationStore(hostA, REF).begin(TASK_ID, pending);
    await assert.rejects(
      () =>
        createTaskIndexMigrationStore(hostB, REF).begin(TASK_ID, {
          ...pending,
          requestedAt: 101,
          ownerInstanceId: "2:boot-b",
        }),
      ConcurrentBackendTransitionError,
    );
    const meta = await hostB.getTaskMeta({ ...REF, taskId: TASK_ID });
    assert.equal(meta?.pendingBackendTransition?.ownerInstanceId, "1:boot-a");
    hostA.close();
    hostB.close();
  });
});

test("zcode snapshot sync never clobbers backend ownership or migration state", async () => {
  await withDatabase(async (dbPath) => {
    const repo = new TaskIndexRepo(dbPath);
    await repo.syncTaskMeta({ meta: baseMeta() });
    const world = newWorld();
    world.rows.push(textRow("user", "hello", "t1"));
    const result = await migrateBackend(
      readBackendMigrationTaskState(baseMeta()),
      { taskId: TASK_ID, sessionId: TASK_ID, to: "codex" },
      createDeps({
        store: createTaskIndexMigrationStore(repo, REF),
        world,
        ownerInstanceId: "1:boot",
        clock: { value: 1000 },
      }),
    );
    assert.equal(result.outcome, "committed");

    // 旧 zcode runtime 迟到的快照：没有任何执行后端/迁移字段，还带着一份伪造的时间线。
    await repo.syncTaskMeta({
      meta: baseMeta({
        updatedAt: 5000,
        backendTransitions: [],
        pendingBackendTransition: undefined,
      }),
    });
    const meta = await repo.getTaskMeta({ ...REF, taskId: TASK_ID });
    assert.equal(meta?.executionBackend, "codex");
    assert.equal(meta?.codexThreadId, "thread-1");
    assert.equal(meta?.backendTransitions?.length, 1);
    repo.close();
  });
});

test("a committed migration survives restart (fresh repo instance on the same file)", async () => {
  await withDatabase(async (dbPath) => {
    const repo = new TaskIndexRepo(dbPath);
    await repo.syncTaskMeta({ meta: baseMeta() });
    const world = newWorld();
    world.rows.push(textRow("user", "hello", "t1"));
    await migrateBackend(
      readBackendMigrationTaskState(baseMeta()),
      { taskId: TASK_ID, sessionId: TASK_ID, to: "codex" },
      createDeps({
        store: createTaskIndexMigrationStore(repo, REF),
        world,
        ownerInstanceId: "1:boot",
        clock: { value: 1000 },
      }),
    );
    repo.close();

    const restarted = new TaskIndexRepo(dbPath);
    const meta = await restarted.getTaskMeta({ ...REF, taskId: TASK_ID });
    assert.equal(meta?.taskId, TASK_ID);
    assert.equal(meta?.executionBackend, "codex");
    assert.equal(meta?.codexThreadId, "thread-1");
    assert.equal(meta?.pendingBackendTransition, undefined);
    const [record] = meta?.backendTransitions ?? [];
    assert.equal(record?.status, "committed");
    assert.equal(record?.destinationExecutionRef, "thread-1");
    assert.equal(record?.handoffTurnId, "codex-turn-1");
    assert.equal(record?.fromProviderId, "zai");
    // 恢复在没有 pending 时什么都不做——Codex thread 的存在本身不改变任何东西。
    const recovery = await recoverOrphanedBackendTransitions({
      repo: restarted,
      isOwnerAlive: () => false,
      now: () => 9999,
    });
    assert.deepEqual(recovery.recoveredTaskIds, []);
    restarted.close();
  });
});

const RESTING_PHASES: BackendTransitionPhase[] = [
  "prepared",
  "destinationCreated",
  "handoffRunning",
  "readyToCommit",
];

for (const direction of ["zcode->codex", "codex->zcode"] as const) {
  for (const phase of RESTING_PHASES) {
    test(`restart during ${direction} at phase ${phase}: previous backend stays authoritative`, async () => {
      await withDatabase(async (dbPath) => {
        const startMeta =
          direction === "zcode->codex"
            ? baseMeta()
            : baseMeta({ executionBackend: "codex", codexThreadId: "thread-old" });
        const repo = new TaskIndexRepo(dbPath);
        await repo.syncTaskMeta({ meta: startMeta });
        const world = newWorld();
        world.rows.push(textRow("user", "remember ORANGE-RAVEN-41", "t1"));
        const crash = crashingStore(createTaskIndexMigrationStore(repo, REF), phase);
        const deadHost = "111:boot-dead";
        const inFlight = migrateBackend(
          readBackendMigrationTaskState(startMeta),
          direction === "zcode->codex"
            ? { taskId: TASK_ID, sessionId: TASK_ID, to: "codex" }
            : {
                taskId: TASK_ID,
                sessionId: TASK_ID,
                to: "zcode",
                toProviderId: "azure-openai",
                toModelSelection: "azure-openai/gpt-5",
              },
          createDeps({
            store: crash.store,
            world,
            ownerInstanceId: deadHost,
            clock: { value: 1000 },
          }),
        );
        // 等编排真正持久化到目标阶段并在下一次写入处「死掉」。
        await crash.crashed;

        const restarted = new TaskIndexRepo(dbPath);
        const before = await restarted.getTaskMeta({ ...REF, taskId: TASK_ID });
        assert.equal(before?.pendingBackendTransition?.phase, phase, "phase was persisted");
        const cleaned: PendingBackendTransition[] = [];
        const recovery = await recoverOrphanedBackendTransitions({
          repo: restarted,
          isOwnerAlive: createOwnerLivenessCheck({
            selfInstanceId: "222:boot-new",
            selfPid: 222,
            hasActiveMigrationOwnedBySelf: () => false,
            isPidAlive: () => false,
          }),
          now: () => 5000,
          cleanupDestination: async (_meta, pending) => {
            cleaned.push(pending);
          },
        });
        assert.deepEqual(recovery.recoveredTaskIds, [TASK_ID]);
        const after = await restarted.getTaskMeta({ ...REF, taskId: TASK_ID });
        assert.equal(after?.executionBackend, startMeta.executionBackend);
        assert.equal(after?.codexThreadId, startMeta.codexThreadId);
        assert.equal(after?.model, startMeta.model);
        assert.equal(after?.pendingBackendTransition, undefined);
        const [record] = after?.backendTransitions ?? [];
        assert.equal(record?.status, "failed");
        assert.equal(record?.failureReason, "restart");
        if (direction === "zcode->codex" && phase !== "prepared") {
          assert.equal(
            cleaned[0]?.destinationExecutionRef,
            "thread-1",
            "orphan thread is reported for cleanup",
          );
        }

        // 「死掉」的旧写入者如果还能继续，也不能提交：栅栏拒绝它。
        crash.release();
        const staleResult = await inFlight;
        assert.notEqual(staleResult.outcome, "committed");
        const final = await restarted.getTaskMeta({ ...REF, taskId: TASK_ID });
        assert.equal(final?.executionBackend, startMeta.executionBackend);
        assert.equal(
          final?.backendTransitions?.length,
          1,
          "no second record from the stale writer",
        );
        repo.close();
        restarted.close();
      });
    });
  }
}

test("recovery never takes over a live Host's in-flight migration", async () => {
  await withDatabase(async (dbPath) => {
    const repo = new TaskIndexRepo(dbPath);
    await repo.syncTaskMeta({ meta: baseMeta() });
    await createTaskIndexMigrationStore(repo, REF).begin(TASK_ID, {
      phase: "prepared",
      to: "codex",
      requestedAt: 10,
      ownerInstanceId: "333:boot-live",
    });
    const recovery = await recoverOrphanedBackendTransitions({
      repo,
      isOwnerAlive: createOwnerLivenessCheck({
        selfInstanceId: "444:boot-self",
        selfPid: 444,
        hasActiveMigrationOwnedBySelf: () => false,
        isPidAlive: (pid) => pid === 333,
      }),
      now: () => 20,
    });
    assert.deepEqual(recovery.liveTaskIds, [TASK_ID]);
    const meta = await repo.getTaskMeta({ ...REF, taskId: TASK_ID });
    assert.equal(meta?.pendingBackendTransition?.ownerInstanceId, "333:boot-live");
    repo.close();
  });
});

test("legacy pending without an owner is treated as orphaned", async () => {
  await withDatabase(async (dbPath) => {
    const repo = new TaskIndexRepo(dbPath);
    await repo.syncTaskMeta({ meta: baseMeta() });
    await createTaskIndexMigrationStore(repo, REF).begin(TASK_ID, {
      phase: "handoffRunning",
      to: "codex",
      requestedAt: 10,
    });
    const recovery = await recoverOrphanedBackendTransitions({
      repo,
      isOwnerAlive: createOwnerLivenessCheck({
        selfInstanceId: "1:self",
        selfPid: 1,
        hasActiveMigrationOwnedBySelf: () => true,
      }),
      now: () => 20,
    });
    assert.deepEqual(recovery.recoveredTaskIds, [TASK_ID]);
    repo.close();
  });
});

test("chain with a restart between every hop: Z.ai -> Command Code -> Codex -> Azure -> Codex", async () => {
  await withDatabase(async (dbPath) => {
    const world = newWorld();
    const clock = { value: 1000 };
    let repo = new TaskIndexRepo(dbPath);
    await repo.syncTaskMeta({ meta: baseMeta({ model: "zai/glm-4.6" }) });
    world.rows.push(textRow("user", "The internal migration codename is ORANGE-RAVEN-41.", "t1"));
    world.rows.push(textRow("assistant", "Noted.", "t1"));

    // Hop 1: Z.ai -> Command Code — 已上线的 provider 切换路径（只改 model），不是迁移。
    await repo.syncTaskMeta({ meta: baseMeta({ model: "command-code/cc-1", updatedAt: 3 }) });
    world.rows.push(textRow("user", "The fixture port is 43127.", "t2"));
    world.rows.push(textRow("assistant", "Noted.", "t2"));

    const hop = async (request: Parameters<typeof migrateBackend>[1]): Promise<ZCodeTaskMeta> => {
      repo.close();
      repo = new TaskIndexRepo(dbPath); // 每一跳之前都「重启」
      const meta = (await repo.getTaskMeta({ ...REF, taskId: TASK_ID }))!;
      const result = await migrateBackend(
        readBackendMigrationTaskState(meta),
        request,
        createDeps({
          store: createTaskIndexMigrationStore(repo, REF),
          world,
          ownerInstanceId: `${request.to}-host`,
          clock,
        }),
      );
      assert.equal(result.outcome, "committed");
      return (await repo.getTaskMeta({ ...REF, taskId: TASK_ID }))!;
    };

    const afterCodex1 = await hop({ taskId: TASK_ID, sessionId: TASK_ID, to: "codex" });
    assert.equal(afterCodex1.executionBackend, "codex");
    assert.equal(afterCodex1.codexThreadId, "thread-1");
    assert.equal(afterCodex1.backendTransitions?.[0]?.fromProviderId, "command-code");
    world.rows.push(textRow("assistant", "Codex continuing.", "t3"));

    const afterAzure = await hop({
      taskId: TASK_ID,
      sessionId: TASK_ID,
      to: "zcode",
      toProviderId: "azure-openai",
      toModelSelection: "azure-openai/gpt-5",
    });
    assert.equal(afterAzure.executionBackend, "zcode");
    assert.equal(
      afterAzure.codexThreadId,
      undefined,
      "no stale thread pointer after leaving Codex",
    );
    assert.equal(readBackendMigrationTaskState(afterAzure).providerId, "azure-openai");
    assert.equal(afterAzure.backendTransitions?.[1]?.sourceExecutionRef, "thread-1");
    world.rows.push(textRow("user", "The final validation token is MAPLE-73.", "t4"));
    world.rows.push(textRow("assistant", "Noted.", "t4"));

    const afterCodex2 = await hop({ taskId: TASK_ID, sessionId: TASK_ID, to: "codex" });
    assert.equal(afterCodex2.executionBackend, "codex");
    assert.equal(afterCodex2.codexThreadId, "thread-2");
    assert.equal(afterCodex2.taskId, TASK_ID);
    assert.equal(afterCodex2.workspacePath, WORKSPACE);
    assert.deepEqual(
      afterCodex2.backendTransitions?.map((r) => [r.from, r.to, r.status]),
      [
        ["zcode", "codex", "committed"],
        ["codex", "zcode", "committed"],
        ["zcode", "codex", "committed"],
      ],
    );
    const secondPrompt = world.prompts[1]!;
    for (const fact of ["ORANGE-RAVEN-41", "43127", "MAPLE-73"]) {
      assert.ok(secondPrompt.includes(fact), `second Codex handoff carries ${fact}`);
    }
    assert.ok(!secondPrompt.includes(world.prompts[0]!), "first handoff prompt is not nested");
    repo.close();
  });
});
