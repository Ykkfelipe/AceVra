/**
 * 后端迁移端到端集成（backend-migration.md Amendment 3/4），真实组件：
 *   BackendMigrationService + 真实 SQLite TaskIndexRepo + 真实 Codex 执行服务与迁移桥
 *   （投影、冷恢复、通知路由、写权限校验）+ 共享时间线组合器（UI 读取路径）。
 * 假的只有两端「外部进程」：
 *   - FakeCodexAppServer：thread/start、turn/start、thread/items/list、审批请求；它的「模型」
 *     只能从该 thread 收到过的输入里找事实——事实出现在回答里，就证明上下文真的被交接了；
 *   - FakeZCodeAgent：zcode 会话行（rowId 稳定）+ 模型上下文（可见消息 + model-only 种子）。
 *
 * Run: mise exec -- node --import tsx --test packages/services/test/backendMigrationIntegration.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  layoutFromTaskTimelineView,
  readFullComposedTimeline,
  type BackendMigrationTaskTarget,
  type BackendTimelineSegmentReader,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import type { CommandEnvelope, ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { setDataBaseDir } from "../src/paths.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import {
  createCodexExecutionService,
  DEFAULT_CODEX_EXECUTION_POLICY,
  type CodexAppServerPort,
} from "../src/codex/contract.js";
import { BackendMigrationService } from "../src/backend-migration/backendMigrationServiceImpl.js";
import {
  backendMigrationConnectionScopeFactory,
  type IBackendMigrationService,
} from "../src/backend-migration/backendMigrationService.js";
import type { BackendMigrationAgentService } from "../src/backend-migration/backendMigrationSources.js";
import { rejectZCodeSendWithoutExecutionOwnership } from "../src/zcode-agent/zcodeExecutionOwnershipFence.js";

const WORKSPACE = "/example/workspace";
const TASK_ID = "task-e2e-1";
const TARGET: BackendMigrationTaskTarget = { taskId: TASK_ID, workspacePath: WORKSPACE };
const FACT_PATTERN = /ORANGE-RAVEN-\d+|\b43127\b|CEDAR-\d+|MAPLE-\d+/g;

/** 「模型」：只从自己的上下文里取事实。 */
function answerFromContext(context: readonly string[]): string {
  const facts = [...new Set(context.join("\n").match(FACT_PATTERN) ?? [])];
  return facts.length > 0 ? `Known facts: ${facts.join(", ")}` : "I know no facts yet.";
}

// ───────────────────────── Fake Codex App Server ─────────────────────────
interface CodexItemRecord {
  readonly turnId: string;
  readonly item: Record<string, unknown>;
}

function createFakeCodexAppServer() {
  const threads = new Map<string, { items: CodexItemRecord[]; inputs: string[] }>();
  const handlers = new Set<Parameters<CodexAppServerPort["onNotification"]>[0]>();
  const responses: { rawId: number; result: unknown }[] = [];
  const handoffPrompts: string[] = [];
  let threadCounter = 0;
  let turnCounter = 0;
  let itemCounter = 0;
  let rawIdCounter = 100;
  let pending = Promise.resolve();
  const faults = {
    threadStart: false,
    handoffTurnStart: false,
    handoffToolActivity: false,
    /** 非 null 时 handoff 轮在 release 之前不结束（用于并发/在途测试）。 */
    holdHandoff: null as null | { release: () => void; released: Promise<void> },
  };

  const emit = (
    method: string,
    params: unknown,
    rawRequest?: { method: string; params: unknown; rawId: number },
  ) => {
    for (const handler of handlers) handler(method, params, rawRequest);
  };

  const later = (work: () => Promise<void> | void) => {
    pending = pending.then(() => new Promise<void>((resolve) => setImmediate(resolve))).then(work);
  };

  const port: CodexAppServerPort = {
    installed: true,
    generation: 1,
    async call<T>(method: string, params?: unknown): Promise<T> {
      const p = (params ?? {}) as Record<string, unknown>;
      switch (method) {
        case "account/read":
          return { account: { type: "chatgpt" } } as T;
        case "thread/start": {
          if (faults.threadStart) throw new Error("thread/start rejected");
          const id = `thread-${(threadCounter += 1)}`;
          threads.set(id, { items: [], inputs: [] });
          return { thread: { id } } as T;
        }
        case "thread/resume":
          return {} as T;
        case "thread/items/list": {
          const thread = threads.get(String(p.threadId));
          return { items: thread?.items ?? [] } as T;
        }
        case "turn/interrupt":
          return {} as T;
        case "turn/start": {
          const threadId = String(p.threadId);
          const thread = threads.get(threadId);
          if (!thread) throw new Error("unknown thread");
          const input = (p.input as { text: string }[])[0]!.text;
          const isHandoff = input.startsWith("This is a CONTEXT-TRANSFER turn");
          if (isHandoff && faults.handoffTurnStart) throw new Error("turn/start failed");
          if (isHandoff) handoffPrompts.push(input);
          const turnId = `ct-${(turnCounter += 1)}`;
          thread.inputs.push(input);
          const userItem = {
            type: "userMessage",
            id: `item-${(itemCounter += 1)}`,
            content: [{ type: "text", text: input }],
          };
          const reply = isHandoff
            ? "Ready to continue. ACEVRA_HANDOFF_READY"
            : answerFromContext(thread.inputs);
          const agentItem = { type: "agentMessage", id: `item-${(itemCounter += 1)}`, text: reply };
          const hold = isHandoff ? faults.holdHandoff : null;
          const toolActivity = isHandoff && faults.handoffToolActivity;
          later(async () => {
            emit("turn/started", { threadId, turn: { id: turnId } });
            emit("item/started", { threadId, turnId, item: userItem });
            thread.items.push({ turnId, item: userItem });
            if (toolActivity) {
              const toolItem = {
                type: "commandExecution",
                id: `item-${(itemCounter += 1)}`,
                command: "rm -rf build",
                status: "inProgress",
              };
              emit("item/started", { threadId, turnId, item: toolItem });
              emit(
                "item/commandExecution/requestApproval",
                { threadId, turnId, command: "rm -rf build" },
                {
                  method: "item/commandExecution/requestApproval",
                  params: { threadId, turnId, command: "rm -rf build" },
                  rawId: (rawIdCounter += 1),
                },
              );
            }
            if (hold) await hold.released;
            emit("item/started", { threadId, turnId, item: { ...agentItem, text: "" } });
            emit("item/completed", { threadId, turnId, item: agentItem });
            thread.items.push({ turnId, item: agentItem });
            emit("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
          });
          return { turn: { id: turnId } } as T;
        }
        default:
          throw new Error(`unexpected codex method ${method}`);
      }
    },
    respond(rawId, result) {
      responses.push({ rawId, result });
    },
    onNotification(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };

  return {
    port,
    threads,
    responses,
    handoffPrompts,
    faults,
    /** 等所有已排队的通知投递完毕。 */
    settle: async () => {
      for (let i = 0; i < 5; i += 1) await pending;
    },
    lastAgentReply: (threadId: string): string => {
      const items = threads.get(threadId)?.items ?? [];
      const last = [...items].reverse().find((entry) => entry.item.type === "agentMessage");
      return String(last?.item.text ?? "");
    },
  };
}

// ───────────────────────── Fake zcode Agent ─────────────────────────
function createFakeZCodeAgent() {
  const sessions = new Map<
    string,
    {
      rows: ConversationRow[];
      seeds: Map<string, string>;
      model: string | null;
      nextRowId: number;
      /** 与 CLI 一致：每条持久化消息（真实轮次与种子）都标注模型；task meta 同步取最新一条。 */
      messageModels: string[];
    }
  >();
  const faults = { createSession: false, resumeSession: false };
  const session = (id: string) => {
    const found = sessions.get(id);
    if (!found) throw new Error(`zcode session ${id} not found`);
    return found;
  };
  const modelContext = (id: string): string[] => {
    const s = session(id);
    return [
      ...s.seeds.values(),
      ...s.rows.map((row) =>
        row.kind === "userInput" || row.kind === "assistantText" ? row.text : "",
      ),
    ];
  };
  const agent: BackendMigrationAgentService = {
    async conversationRowsRangeV4(params) {
      const s = session(params.sessionId);
      const eligible = s.rows.filter(
        (row) => params.beforeRowId === undefined || row.rowId < params.beforeRowId,
      );
      const rows = eligible.slice(Math.max(0, eligible.length - params.limit));
      return {
        rows,
        atSeq: 0,
        atRevision: 0,
        atLogEpoch: "zcode-epoch",
        hasMore: eligible.length > rows.length,
      };
    },
    async resumeSession(params) {
      if (faults.resumeSession) throw new Error("zcode-cli could not load the session");
      session(params.sessionId);
      return {} as never;
    },
    async createSession(params) {
      if (faults.createSession) throw new Error("zcode-cli failed to create session");
      sessions.set(params.sessionId!, {
        rows: [],
        seeds: new Map(),
        model: null,
        nextRowId: 1,
        messageModels: [],
      });
      return {} as never;
    },
    async setModel(params) {
      session(params.sessionId).model = `${params.model.providerId}/${params.model.modelId}`;
      return {} as never;
    },
    async seedBackendHandoff(params) {
      // 与 CLI 一致：model-only，不产生任何可见行；种子消息按 host 给出的目标选择标注，
      // 缺省时才沿用会话当前模型（CLI backend-handoff-seed.ts）。
      const s = session(params.sessionId);
      s.seeds.set(params.seedId, params.text);
      const stamped = params.model ? `${params.model.providerId}/${params.model.modelId}` : s.model;
      if (stamped) s.messageModels.push(stamped);
      return { messageId: `seed-${params.seedId}` };
    },
    async removeBackendHandoffSeed(params) {
      return { removed: session(params.sessionId).seeds.delete(params.seedId) };
    },
    async generateWorkspaceText() {
      return { text: "summary", selection: { providerId: "zai", modelId: "glm" } } as never;
    },
  };
  return {
    agent,
    sessions,
    faults,
    create(id: string, model: string) {
      sessions.set(id, { rows: [], seeds: new Map(), model, nextRowId: 1, messageModels: [] });
    },
    /** zcodeTaskIndexSyncer 的模型口径：最新消息的模型优先，其次会话当前模型。 */
    snapshotModel(id: string): string | null {
      const s = session(id);
      return s.messageModels.at(-1) ?? s.model;
    },
    /** 一次真实 Agent 轮：用户行 + 由上下文（含种子）计算出的助手回复。 */
    userTurn(id: string, text: string): string {
      const s = session(id);
      const at = s.nextRowId;
      if (s.model) s.messageModels.push(s.model);
      s.rows.push({
        rowId: s.nextRowId++,
        turnId: `z-${at}`,
        kind: "userInput",
        text,
        origin: "realUser",
        createdAt: at,
        createdAtSeq: at,
      } as ConversationRow);
      const reply = answerFromContext(modelContext(id));
      s.rows.push({
        rowId: s.nextRowId++,
        turnId: `z-${at}`,
        kind: "assistantText",
        text: `[${s.model}] ${reply}`,
        state: "complete",
        createdAt: at + 1,
        createdAtSeq: at + 1,
      } as ConversationRow);
      return reply;
    },
  };
}

// ───────────────────────── Harness ─────────────────────────
async function withWorld(run: (world: Awaited<ReturnType<typeof createWorld>>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "acevra-migration-e2e-"));
  setDataBaseDir(dir);
  const world = await createWorld(join(dir, "tasks.sqlite"));
  try {
    await run(world);
  } finally {
    world.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

async function createWorld(dbPath: string) {
  const codexServer = createFakeCodexAppServer();
  const zcode = createFakeZCodeAgent();
  let generation = 0;
  let host = boot();
  function boot() {
    generation += 1;
    const repo = new TaskIndexRepo(dbPath);
    const codex = createCodexExecutionService({
      bridge: codexServer.port,
      taskIndex: repo,
      policy: DEFAULT_CODEX_EXECUTION_POLICY,
    });
    const migration = new BackendMigrationService({
      taskIndex: repo,
      codex: codex.migration,
      codexPolicy: DEFAULT_CODEX_EXECUTION_POLICY,
      hostInstanceId: `${process.pid}:boot-${generation}`,
      handoffTimeoutMs: 5_000,
    });
    const scoped: IBackendMigrationService = migration[backendMigrationConnectionScopeFactory](
      zcode.agent,
    );
    return { repo, codex, migration, scoped };
  }
  return {
    codexServer,
    zcode,
    get host() {
      return host;
    },
    /** 模拟应用重启：新的 repo 连接、新的 Codex 服务（内存 runtime 全丢）、新的迁移服务。 */
    restart() {
      host.codex.dispose();
      host.repo.close();
      host = boot();
    },
    meta: async (): Promise<ZCodeTaskMeta> =>
      (await host.repo.getTaskMeta({ workspacePath: WORKSPACE, taskId: TASK_ID }))!,
    /** Host 的 zcode 快照同步（resume/setModel/轮次事件都会触发）：task 行 model 取自快照。 */
    async syncMetaFromAgentSnapshot(): Promise<void> {
      const current = (await host.repo.getTaskMeta({ workspacePath: WORKSPACE, taskId: TASK_ID }))!;
      const model = zcode.snapshotModel(TASK_ID);
      await host.repo.syncTaskMeta({
        meta: { ...current, ...(model ? { model } : {}), updatedAt: current.updatedAt + 1 },
      });
    },
    async codexUserTurn(text: string): Promise<string> {
      await host.codex.service.sendTurn({ taskId: TASK_ID, content: text });
      await codexServer.settle();
      const meta = (await host.repo.getTaskMeta({ workspacePath: WORKSPACE, taskId: TASK_ID }))!;
      return codexServer.lastAgentReply(meta.codexThreadId!);
    },
    /** UI 读取路径：时间线视图 → 布局 → 组合器，段内容全部经服务按段下标读取。 */
    async renderTimeline(): Promise<ConversationRow[]> {
      const view = (await host.scoped.getTaskTimeline(TARGET))!;
      const layout = layoutFromTaskTimelineView(view);
      const reader: BackendTimelineSegmentReader = {
        async readBefore({ segment, beforeSourceRowId, limit }) {
          return host.scoped.readTimelineSegmentRows({
            ...TARGET,
            layoutVersion: view.layoutVersion,
            segmentIndex: segment.index,
            ...(beforeSourceRowId === undefined ? {} : { beforeSourceRowId }),
            limit,
          });
        },
      };
      return readFullComposedTimeline({ layout, reader, pageLimit: 3 });
    },
    dispose() {
      host.codex.dispose();
      host.repo.close();
    },
  };
}

async function seedTask(world: Awaited<ReturnType<typeof createWorld>>) {
  world.zcode.create(TASK_ID, "zai/glm-4.6");
  await world.host.repo.syncTaskMeta({
    meta: {
      taskId: TASK_ID,
      traceId: "trace-e2e",
      workspacePath: WORKSPACE,
      title: "Migration proof",
      mode: "build",
      createdAt: 1,
      updatedAt: 1,
      provider: "glm",
      model: "zai/glm-4.6",
      status: "completed",
    },
  });
}

function visibleTexts(rows: readonly ConversationRow[]): string[] {
  return rows.map((row) => {
    if (row.kind === "userInput") return `U:${row.text}`;
    if (row.kind === "assistantText") return `A:${row.text}`;
    if (row.kind === "timelineMarker" && row.marker.type === "backendTransition") {
      return `[${row.marker.fromBackend}->${row.marker.toBackend}]`;
    }
    return `(${row.kind})`;
  });
}

// ───────────────────────── Tests ─────────────────────────
test("full chain Z.ai → Command Code → Codex → Azure → Codex transfers real context, survives restart, renders one coherent timeline", async () => {
  await withWorld(async (world) => {
    await seedTask(world);
    // Z.ai 段
    world.zcode.userTurn(TASK_ID, "The internal migration codename is ORANGE-RAVEN-41.");
    // 已上线的 Agent 内 provider 切换（只换 model，不是迁移）
    world.zcode.sessions.get(TASK_ID)!.model = "command-code/cc-1";
    await world.host.repo.syncTaskMeta({
      meta: { ...(await world.meta()), model: "command-code/cc-1", updatedAt: 2 },
    });
    world.zcode.userTurn(TASK_ID, "The fixture port is 43127.");

    // → Codex
    const toCodex = await world.host.scoped.switchTaskBackend({ ...TARGET, to: "codex" });
    assert.equal(toCodex.outcome, "committed");
    const afterCodex = await world.meta();
    assert.equal(afterCodex.executionBackend, "codex");
    assert.equal(afterCodex.codexThreadId, "thread-1");
    assert.equal(afterCodex.pendingBackendTransition, undefined);
    // 真实交接：用户提示里不重复事实，Codex 的回答仍包含 Z.ai 与 Command Code 段的事实。
    const codexAnswer = await world.codexUserTurn(
      "Use both earlier facts. Also note the Codex-only marker is CEDAR-19.",
    );
    assert.match(codexAnswer, /ORANGE-RAVEN-41/);
    assert.match(codexAnswer, /43127/);

    // → Agent / Azure（Codex 段种子化进 zcode 会话，不需要模型调用）
    const toAzure = await world.host.scoped.switchTaskBackend({
      ...TARGET,
      to: "zcode",
      toModelSelection: "azure-openai/gpt-5",
    });
    assert.equal(toAzure.outcome, "committed");
    const afterAzure = await world.meta();
    assert.equal(afterAzure.executionBackend, "zcode");
    assert.equal(
      afterAzure.model,
      "azure-openai/gpt-5",
      "providerId/model follows the committed Agent provider",
    );
    assert.equal(afterAzure.codexThreadId, undefined);
    assert.equal(world.zcode.sessions.get(TASK_ID)!.model, "azure-openai/gpt-5");
    // 首个 Azure 回复知道只在 Codex 段出现过的事实 → 种子确实进入了模型上下文。
    const azureAnswer = world.zcode.userTurn(TASK_ID, "The final validation token is MAPLE-73.");
    assert.match(azureAnswer, /CEDAR-19/);
    const seeds = [...world.zcode.sessions.get(TASK_ID)!.seeds.values()];
    assert.equal(seeds.length, 1);
    assert.ok(
      !seeds[0]!.includes("HANDOFF"),
      "the Agent seed never carries the Codex handoff prompt",
    );
    assert.ok(
      !seeds[0]!.includes("The internal migration codename is ORANGE-RAVEN-41."),
      "the seed only adds segments the Agent has not seen (no duplicate of its own history)",
    );
    assert.ok(
      seeds[0]!.includes("Codex-only marker is CEDAR-19"),
      "the Codex segment is in the seed",
    );

    // → Codex 再一次；中间重启一次，验证持久化的归属与布局。
    world.restart();
    const toCodex2 = await world.host.scoped.switchTaskBackend({ ...TARGET, to: "codex" });
    assert.equal(toCodex2.outcome, "committed");
    const afterCodex2 = await world.meta();
    assert.equal(afterCodex2.codexThreadId, "thread-2");
    const finalAnswer = await world.codexUserTurn("List every fact you know.");
    for (const fact of ["ORANGE-RAVEN-41", "43127", "CEDAR-19", "MAPLE-73"]) {
      assert.match(finalAnswer, new RegExp(fact), `second Codex thread knows ${fact}`);
    }
    // 第二次 handoff 不嵌套第一次的 handoff prompt/ack。
    const [firstPrompt, secondPrompt] = world.codexServer.handoffPrompts;
    assert.ok(!secondPrompt!.includes(firstPrompt!));
    assert.ok(
      !secondPrompt!.split("--- Prior task context ---")[1]!.includes("ACEVRA_HANDOFF_READY"),
    );

    // 时间线：重启前后都一致；一条 task、三条 marker、无 handoff、无种子副本。
    const before = visibleTexts(await world.renderTimeline());
    world.restart();
    const after = visibleTexts(await world.renderTimeline());
    assert.deepEqual(after, before, "timeline is deterministic across restart");
    assert.deepEqual(
      after.filter((t) => t.startsWith("[")),
      ["[zcode->codex]", "[codex->zcode]", "[zcode->codex]"],
    );
    assert.ok(
      !after.some((t) => t.includes("CONTEXT-TRANSFER") || t.includes("ACEVRA_HANDOFF_READY")),
    );
    for (const message of [
      "U:The internal migration codename is ORANGE-RAVEN-41.",
      "U:The fixture port is 43127.",
      "U:Use both earlier facts. Also note the Codex-only marker is CEDAR-19.",
      "U:The final validation token is MAPLE-73.",
      "U:List every fact you know.",
    ]) {
      assert.equal(
        after.filter((t) => t === message).length,
        1,
        `exactly one visible copy of ${message}`,
      );
    }
    const order = [
      "U:The internal migration codename is ORANGE-RAVEN-41.",
      "U:The fixture port is 43127.",
      "[zcode->codex]",
      "U:Use both earlier facts. Also note the Codex-only marker is CEDAR-19.",
      "[codex->zcode]",
      "U:The final validation token is MAPLE-73.",
      "U:List every fact you know.",
    ].map((t) => after.indexOf(t));
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
      "chronological order",
    );

    const final = await world.meta();
    assert.equal(final.taskId, TASK_ID);
    assert.equal(final.workspacePath, WORKSPACE);
    assert.deepEqual(
      final.backendTransitions?.map((r) => [r.from, r.to, r.status]),
      [
        ["zcode", "codex", "committed"],
        ["codex", "zcode", "committed"],
        ["zcode", "codex", "committed"],
      ],
    );
    // 「Show handoff details」按 Codex turn id 取回真实的交接请求与回复。
    const details = await world.host.scoped.readHandoffDetails({ ...TARGET, transitionIndex: 2 });
    assert.ok(
      details!.rows.some(
        (row) => row.kind === "userInput" && row.text.includes("CONTEXT-TRANSFER"),
      ),
    );
    assert.ok(
      details!.rows.some(
        (row) => row.kind === "assistantText" && row.text.includes("ACEVRA_HANDOFF_READY"),
      ),
    );
  });
});

test("Agent/Command Code → Codex → Agent/Azure → Codex: the committed Azure selection is the next transition's source", async () => {
  // 线上缺陷复现（Amendment 5）：Codex → Azure 提交后，种子仍按迁移前的 Command Code 标注，
  // 快照同步（最新消息模型优先）把任务行冲回 Command Code，下一次迁移记下错误的来源 provider。
  const AZURE_SELECTION = "azure-openai/gpt-5-mini$low";
  await withWorld(async (world) => {
    world.zcode.create(TASK_ID, "command-code/gpt-5.6-sol");
    await world.host.repo.syncTaskMeta({
      meta: {
        taskId: TASK_ID,
        traceId: "trace-e2e",
        workspacePath: WORKSPACE,
        title: "Stale projection proof",
        mode: "build",
        createdAt: 1,
        updatedAt: 1,
        provider: "glm",
        model: "command-code/gpt-5.6-sol",
        status: "completed",
      },
    });
    world.zcode.userTurn(TASK_ID, "The internal migration codename is ORANGE-RAVEN-41.");

    const toCodex = await world.host.scoped.switchTaskBackend({ ...TARGET, to: "codex" });
    assert.equal(toCodex.outcome, "committed");
    assert.equal((await world.meta()).backendTransitions?.[0]?.fromProviderId, "command-code");
    await world.codexUserTurn("Also note the Codex-only marker is CEDAR-19.");

    const toAzure = await world.host.scoped.switchTaskBackend({
      ...TARGET,
      to: "zcode",
      toModelSelection: AZURE_SELECTION,
    });
    assert.equal(toAzure.outcome, "committed");
    assert.equal(
      toAzure.outcome === "committed" ? toAzure.transition.toModelSelection : undefined,
      AZURE_SELECTION,
    );
    const afterAzure = await world.meta();
    assert.equal(afterAzure.executionBackend, "zcode", "authoritative backend = Agent");
    assert.equal(afterAzure.model, AZURE_SELECTION, "task row carries the full Azure selection");
    assert.equal(afterAzure.backendTransitions?.[1]?.toProviderId, "azure-openai");
    assert.equal(afterAzure.backendTransitions?.[1]?.toModelSelection, AZURE_SELECTION);
    assert.equal(world.zcode.sessions.get(TASK_ID)!.model, "azure-openai/gpt-5-mini");

    // UI 读取的持久化视图：live Agent 段由这条提交打开，并带着完整目标选择（composer 的唯一来源）。
    const view = (await world.host.scoped.getTaskTimeline(TARGET))!;
    const live = view.segments.find((segment) => segment.live)!;
    assert.equal(live.backend, "zcode");
    assert.equal(
      view.transitions[live.openedByTransitionIndex!]?.toModelSelection,
      AZURE_SELECTION,
    );

    // 种子归属 Azure：Azure 首轮之前的快照同步也不会把任务行冲回 Command Code。
    await world.syncMetaFromAgentSnapshot();
    assert.equal((await world.meta()).model, "azure-openai/gpt-5-mini");
    const azureAnswer = world.zcode.userTurn(TASK_ID, "The final validation token is MAPLE-73.");
    assert.match(azureAnswer, /CEDAR-19/, "Azure answers from the transferred context");
    await world.syncMetaFromAgentSnapshot();

    // 重启：持久化的提交仍给出 Azure 选择，任务行仍是 Azure。
    world.restart();
    const restartedView = (await world.host.scoped.getTaskTimeline(TARGET))!;
    assert.equal(restartedView.transitions[1]?.toModelSelection, AZURE_SELECTION);
    assert.equal((await world.meta()).model, "azure-openai/gpt-5-mini");

    const toCodexAgain = await world.host.scoped.switchTaskBackend({ ...TARGET, to: "codex" });
    assert.equal(toCodexAgain.outcome, "committed");
    const record = (await world.meta()).backendTransitions?.[2];
    assert.equal(record?.from, "zcode");
    assert.equal(
      record?.fromProviderId,
      "azure-openai",
      "source provider is Azure, not Command Code",
    );
    const markers = (await world.renderTimeline()).flatMap((row) =>
      row.kind === "timelineMarker" && row.marker.type === "backendTransition" ? [row.marker] : [],
    );
    assert.deepEqual(
      markers.map((marker) => [marker.fromProviderId ?? null, marker.toBackend]),
      [
        ["command-code", "codex"],
        [null, "zcode"],
        ["azure-openai", "codex"],
      ],
    );
  });
});

test("Codex thread creation failure leaves the Agent task untouched and usable", async () => {
  await withWorld(async (world) => {
    await seedTask(world);
    world.zcode.userTurn(TASK_ID, "The internal migration codename is ORANGE-RAVEN-41.");
    world.codexServer.faults.threadStart = true;
    const result = await world.host.scoped.switchTaskBackend({ ...TARGET, to: "codex" });
    assert.equal(result.outcome, "failed");
    assert.equal(
      result.outcome === "failed" && result.transition.failureReason,
      "destination_create_failed",
    );
    const meta = await world.meta();
    assert.equal(meta.executionBackend ?? "zcode", "zcode");
    assert.equal(meta.pendingBackendTransition, undefined);
    assert.match(world.zcode.userTurn(TASK_ID, "Still there?"), /ORANGE-RAVEN-41/);
    assert.deepEqual(
      visibleTexts(await world.renderTimeline()).filter((t) => t.startsWith("[")),
      [],
    );
  });
});

test("Codex handoff turn failure and unexpected tool activity both fail cleanly; approvals are declined", async () => {
  await withWorld(async (world) => {
    await seedTask(world);
    world.zcode.userTurn(TASK_ID, "hello");
    world.codexServer.faults.handoffTurnStart = true;
    const failedTurn = await world.host.scoped.switchTaskBackend({ ...TARGET, to: "codex" });
    assert.equal(
      failedTurn.outcome === "failed" && failedTurn.transition.failureReason,
      "handoff_turn_error",
    );
    world.codexServer.faults.handoffTurnStart = false;

    world.codexServer.faults.handoffToolActivity = true;
    const toolRun = await world.host.scoped.switchTaskBackend({ ...TARGET, to: "codex" });
    assert.equal(
      toolRun.outcome === "failed" && toolRun.transition.failureReason,
      "unexpected_tool_activity_in_handoff",
    );
    assert.deepEqual(
      world.codexServer.responses.map((r) => r.result),
      [{ decision: "decline" }],
    );
    const meta = await world.meta();
    assert.equal(meta.executionBackend ?? "zcode", "zcode");
    assert.equal(meta.codexThreadId, undefined, "a failed destination thread is never referenced");
    assert.deepEqual(
      meta.backendTransitions?.map((r) => r.status),
      ["failed", "failed"],
    );
    // 失败的交接细节仍可检查（诊断），但不进入可见时间线。
    const details = await world.host.scoped.readHandoffDetails({ ...TARGET, transitionIndex: 1 });
    assert.ok(details!.rows.length > 0);
    assert.deepEqual(visibleTexts(await world.renderTimeline()), [
      "U:hello",
      `A:[zai/glm-4.6] I know no facts yet.`,
    ]);
  });
});

test("Agent destination creation failure leaves Codex authoritative and usable", async () => {
  await withWorld(async (world) => {
    await seedTask(world);
    world.zcode.userTurn(TASK_ID, "The internal migration codename is ORANGE-RAVEN-41.");
    assert.equal(
      (await world.host.scoped.switchTaskBackend({ ...TARGET, to: "codex" })).outcome,
      "committed",
    );
    // 目标端加载与创建都失败（例如 zcode-cli 起不来）；历史 Agent 段本身仍可读。
    world.zcode.faults.resumeSession = true;
    world.zcode.faults.createSession = true;
    const result = await world.host.scoped.switchTaskBackend({
      ...TARGET,
      to: "zcode",
      toModelSelection: "azure-openai/gpt-5",
    });
    assert.equal(
      result.outcome === "failed" && result.transition.failureReason,
      "destination_create_failed",
    );
    const meta = await world.meta();
    assert.equal(meta.executionBackend, "codex");
    assert.equal(meta.codexThreadId, "thread-1");
    assert.match(await world.codexUserTurn("What is the codename?"), /ORANGE-RAVEN-41/);
  });
});

test("while a switch is in flight: a second switch and normal sends on both backends are rejected", async () => {
  await withWorld(async (world) => {
    await seedTask(world);
    world.zcode.userTurn(TASK_ID, "hello");
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    world.codexServer.faults.holdHandoff = { release, released };
    const inFlight = world.host.scoped.switchTaskBackend({ ...TARGET, to: "codex" });
    // 等到持久化的 pending 出现（handoff 轮在途）。
    for (
      let i = 0;
      i < 50 && (await world.meta()).pendingBackendTransition?.phase !== "handoffRunning";
      i += 1
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal((await world.meta()).pendingBackendTransition?.phase, "handoffRunning");

    assert.deepEqual(await world.host.scoped.switchTaskBackend({ ...TARGET, to: "codex" }), {
      outcome: "rejected",
      reason: "concurrent_transition",
    });
    const envelope = {
      type: "sendText",
      commandId: "cmd-1",
      sessionId: TASK_ID,
      payload: { text: "hi" },
    } as unknown as CommandEnvelope;
    const zcodeAck = await rejectZCodeSendWithoutExecutionOwnership({
      envelope,
      workspacePath: WORKSPACE,
      getTaskMeta: (target) => world.host.repo.getTaskMeta(target),
    });
    assert.equal(zcodeAck?.reasonCode, "backendTransitionInProgress");
    const codexAck = await world.host.codex.service.sendConversationCommandV4({ envelope });
    assert.equal(codexAck.reasonCode, "backendTransitionInProgress");

    release();
    assert.equal((await inFlight).outcome, "committed");
    // 提交后：zcode 会话只是历史读源，不再接受新轮。
    const staleRoute = await rejectZCodeSendWithoutExecutionOwnership({
      envelope,
      workspacePath: WORKSPACE,
      getTaskMeta: (target) => world.host.repo.getTaskMeta(target),
    });
    assert.equal(staleRoute?.reasonCode, "backendNotExecutionOwner");
  });
});

test("a switch is refused while a turn is running", async () => {
  await withWorld(async (world) => {
    await seedTask(world);
    await world.host.repo.syncTaskMeta({
      meta: { ...(await world.meta()), status: "running", updatedAt: 5 },
    });
    assert.deepEqual(await world.host.scoped.switchTaskBackend({ ...TARGET, to: "codex" }), {
      outcome: "rejected",
      reason: "turn_in_progress",
    });
  });
});

test("an unreadable source history fails the switch with source_read_failed, not a silent empty handoff", async () => {
  await withWorld(async (world) => {
    await seedTask(world);
    world.zcode.userTurn(TASK_ID, "hello");
    world.zcode.sessions.delete(TASK_ID);
    const result = await world.host.scoped.switchTaskBackend({ ...TARGET, to: "codex" });
    assert.equal(
      result.outcome === "failed" && result.transition.failureReason,
      "source_read_failed",
    );
    assert.equal(
      world.codexServer.threads.size,
      0,
      "no destination is created without a transcript",
    );
  });
});
