/**
 * Cross-Mode × Multitask 集成场景（生产执行方版本）。
 *
 * 里程碑：production handoff executor。原 harness 的「仅测试执行方（createHarnessExecutor）」
 * 已被产品代码取代——本文件现在驱动：
 *   Cross-Mode handoff 服务（bootstrap/src/app/cross-mode-handoff-service）
 *   → 生产 HandoffExecutionPort（cross-mode-handoff-executor）
 *   → Multitask 采纳适配器（core/src/cross-mode）
 *   → 目标会话工具执行器（真实 ToolExecutor + PermissionService + 权限 broker = 运行确认闸门）
 *   → 真实 Multitask 工具（画像冻结、脚本降级）
 *   → 真实 Workflow 引擎（runWorkflowScript，真实 journal / 取消 / 冷重放）
 *   → 真实 driver 证据盖章（multitaskSubmission）
 *   → 返回摘要（handoff 服务）→ recordReturn。
 *
 * 除模型以外全部是真实实现；runtime 的两个提交方法（scheduleTools / executeTools）由宿主替身
 * 提供（AgentRuntime 的结构子集；生产接线见 create-app.ts 的 crossModeHandoffService）。
 * 只有「模型」是假的：fake driver 按任务 id 扮演 worker 提交结果。
 *
 * Run: mise exec -- node --import tsx --test apps/zcode-cli/packages/bootstrap/test/cross-mode-multitask-integration.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ToolScheduler } from "@zcode/core";
import {
  buildAskSpecs,
  collectSites,
  createWorkflowProgram,
  InMemoryJournalStore,
  synthesizeAskSchemas,
  type InstanceRef,
  type RunEvent,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "@zcode/dynamic-workflow-runtime";
import { createToolExecutor } from "../../core/src/tool/executor/impl.js";
import { createToolRegistry } from "../../core/src/tool/registry.js";
import { createMultitaskToolEntry } from "../../core/src/tool/handlers/multitask.js";
import { PermissionService, defaultPermissionConfig } from "../../core/src/permission/service.js";
import { multitaskSubmission } from "../src/app/multitask-worker-evidence.js";
import type { ActorToolCounts } from "../src/app/workflow-driver-tool-activity.js";
import {
  createCrossModeMultitaskHandoffService,
  readMultitaskRunTasks,
  type MultitaskHandoffStartRequest,
} from "../src/app/cross-mode-handoff-service.js";
import type { CrossModeHandoffSubmissionHost } from "../src/app/cross-mode-handoff-executor.js";

// ———————————————————————————— handoff 来源（Coding 会话侧） ————————————————————————————

const plan = {
  workers: [
    { id: "reader", role: "Reader", access: "read" as const },
    { id: "builder", role: "Builder", access: "write" as const },
  ],
  tasks: [
    { id: "a", worker: "reader", prompt: "Read the contract", dependsOn: [] },
    { id: "b", worker: "builder", prompt: "Implement it", dependsOn: ["a"] },
  ],
};

function handoffRequest(
  overrides: Partial<MultitaskHandoffStartRequest> = {},
): MultitaskHandoffStartRequest {
  return {
    sessionId: "sess-coding-1",
    objective: "Implement discountTotal and verify it",
    returnPolicy: "summary-and-artifacts",
    linkedProject: { kind: "project", id: "acevra" },
    permissions: ["repo-read", "repo-write"],
    constraints: ["only edit m2a/"],
    context: [
      {
        label: "Contract",
        content: "discountTotal(items, percent) reduces the subtotal by percent.",
        provenance: [{ kind: "decision", id: "d-1" }],
      },
      { label: "Private note", content: "SECRET-PERSONAL-NOTE", sensitivity: "personal" },
    ],
    plan,
    ...overrides,
  };
}

// ———————————————————————————— 假模型：按任务 id 扮演 worker ————————————————————————————

type Behavior = (instance: InstanceRef, sink: WorkflowReportSink) => void;

const counts = (world: number, mutating = 0): ActorToolCounts => ({
  toolCalls: world + 1,
  worldToolCalls: world,
  mutatingToolCalls: mutating,
  commandCalls: 0,
  filesChanged: mutating > 0 ? ["m2a/pricing.mjs"] : [],
});

/** worker 提交 done；证据走真实 driver 的盖章函数（模型自填的 evidence 会被覆盖）。 */
const submitDone =
  (observed: ActorToolCounts): Behavior =>
  (instance, sink) =>
    sink.askSubmitAttempted(
      instance,
      multitaskSubmission(
        { multitaskWorker: true, modelActivity: { toolCounts: () => observed } as never },
        { status: "done", result: "ok", evidence: { forged: true } },
      ),
    );

// ———————————————————————————— 真实 Workflow 引擎上的 run 端口 ————————————————————————————

interface HarnessRun {
  scriptText: string;
  journal: InMemoryJournalStore;
  events: RunEvent[];
  dispatched: string[];
  controller: AbortController;
  settled: Promise<Awaited<ReturnType<typeof runWorkflowScript>>>;
}

function createRunHost(cwd: string) {
  const runs = new Map<string, HarnessRun>();
  let behaviors: Record<string, Behavior> = {};
  let seq = 0;
  const start = (runId: string, scriptText: string, journal: InMemoryJournalStore) => {
    const program = createWorkflowProgram(scriptText);
    const table = collectSites(program);
    const { schemas } = synthesizeAskSchemas(program, table);
    const controller = new AbortController();
    const run: HarnessRun = {
      scriptText,
      journal,
      events: runs.get(runId)?.events ?? [],
      dispatched: runs.get(runId)?.dispatched ?? [],
      controller,
      settled: undefined as never,
    };
    run.settled = runWorkflowScript({
      scriptText,
      cwd,
      runId,
      caps: { maxConcurrency: 2 },
      askSpecs: buildAskSpecs(table, schemas),
      validate: () => [],
      timeoutMs: 10000,
      signal: controller.signal,
      makeDriver: (sink) => ({
        journal,
        emit: (event) => run.events.push(event),
        createActorSession: async (actor, persona) => {
          // 交接上下文只经 Multitask 的 sharedContext 进入 worker persona；被排除的私人项绝不进入。
          assert.match(persona.system ?? "", /Cross-mode handoff/);
          assert.doesNotMatch(persona.system ?? "", /SECRET-PERSONAL-NOTE/);
          return { id: actor.siteId };
        },
        startAsk: (_session, instance, message) => {
          const id = /^Task (\w+):/.exec(message.instructions)![1]!;
          run.dispatched.push(id);
          queueMicrotask(() => behaviors[id]?.(instance, sink));
        },
        respondToSubmit: () => {},
        cancelAsk: () => {},
        executeWorldRead: async () => null,
      }),
    });
    runs.set(runId, run);
    return run;
  };
  return {
    runs,
    setBehaviors: (next: Record<string, Behavior>) => {
      behaviors = next;
    },
    port: {
      submit: async (request: { scriptText: string }) => {
        const runId = `run-handoff-${++seq}`;
        start(runId, request.scriptText, new InMemoryJournalStore());
        return { ok: true as const, runId };
      },
      cancel: async (runId: string) => {
        runs.get(runId)?.controller.abort("user");
        return runs.has(runId);
      },
      getTask: async () => undefined,
      waitForTask: async () => undefined,
      listEvents: async () => [],
    },
    /** 冷重放 resume：同一个 journal、同一份脚本，与真实 run service 的恢复路径同构。 */
    resume: (runId: string) => {
      const previous = runs.get(runId)!;
      return start(runId, previous.scriptText, previous.journal);
    },
  };
}

// ———————————————————————————— 宿主替身：目标会话工具执行器 ————————————————————————————

interface HarnessHostState {
  /** false 模拟目标会话没有 Multitask 工具（动态 Workflow 灰度关闭 / 无 run 端口）的 TOOL_NOT_FOUND。 */
  multitaskAvailable: boolean;
  /** 用户对运行确认的裁决（broker）。 */
  userDecision: "allow" | "deny";
}

function createHarnessHost(cwd: string, runHost: ReturnType<typeof createRunHost>) {
  const confirmations: string[] = [];
  const state: HarnessHostState = { multitaskAvailable: true, userDecision: "allow" };
  const registry = createToolRegistry();
  registry.register(createMultitaskToolEntry());
  const executor = createToolExecutor({
    registry,
    permissionService: new PermissionService(defaultPermissionConfig),
    permissionBroker: {
      requestPermission: async (request) => {
        confirmations.push(String((request.input as { name?: string }).name));
        return { decision: state.userDecision };
      },
    },
    emitEvent: async () => {},
    sessionId: "target-coding-session" as never,
    getWorkingDirectory: () => cwd,
    dynamicWorkflowRunPort: runHost.port as never,
  });
  const scheduler = new ToolScheduler();
  const host: CrossModeHandoffSubmissionHost = {
    async scheduleTools(toolCalls) {
      return scheduler.schedule(
        toolCalls.map((toolCall) => ({
          toolCallId: toolCall.id as never,
          toolName: toolCall.name,
          dependsOn: [],
        })),
      );
    },
    async executeTools(toolCalls, schedule, options) {
      if (!state.multitaskAvailable) {
        return {
          results: toolCalls.map((toolCall) => ({
            toolCallId: toolCall.id as never,
            success: false as const,
            error: { code: "TOOL_NOT_FOUND", message: `Tool not found: ${toolCall.name}` },
          })),
          events: [],
        };
      }
      const generator = executor.executeSchedule(
        toolCalls.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
        })),
        schedule,
        options?.traceContext === undefined ? {} : { traceContext: options.traceContext },
      );
      let results: never[] = [];
      for (;;) {
        const next = await generator.next();
        if (next.done) {
          results = next.value as never;
          break;
        }
      }
      return { results: results as never, events: [] };
    },
  };
  return { host, confirmations, state };
}

async function withCwd<T>(body: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "acevra-cm-mt-"));
  try {
    return await body(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

// ———————————————————————————— 场景 ————————————————————————————

test("handoff → Multitask goes through the run confirmation, runs with M2 semantics and returns once", () =>
  withCwd(async (cwd) => {
    const runHost = createRunHost(cwd);
    runHost.setBehaviors({ a: submitDone(counts(2)), b: submitDone(counts(3, 1)) });
    const harness = createHarnessHost(cwd, runHost);
    const service = createCrossModeMultitaskHandoffService({ host: harness.host });

    const outcome = await service.start(handoffRequest());
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const record = outcome.record;

    // Multitask 的运行确认没有被交接绕过：确认窗恰好出现一次，展示的是交接派生的运行名。
    assert.deepEqual(harness.confirmations, ["Handoff: Implement discountTotal and verify it"]);
    assert.equal(record.status, "accepted");
    assert.deepEqual(record.externalRef, { kind: "multitask-run", id: "run-handoff-1" });

    const run = runHost.runs.get("run-handoff-1")!;
    const settled = await run.settled;
    assert.equal(settled.status, "completed");
    const artifact = settled.status === "completed" ? settled.artifact : undefined;
    // M2 完成语义与证据保持不变：证据来自运行时盖章，模型伪造的 evidence 被覆盖。
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(artifact as Record<string, { outcome: string }>).map(([k, v]) => [
          k,
          v.outcome,
        ]),
      ),
      { a: "done", b: "done" },
    );
    assert.equal((artifact as { b: { evidence: ActorToolCounts } }).b.evidence.mutatingToolCalls, 1);
    assert.equal("forged" in (artifact as { a: { evidence: object } }).a.evidence, false);

    // run 生命周期不回写 handoff 记录：直到显式返回之前记录一直是 accepted。
    assert.equal((await service.get(record.handoffId))?.status, "accepted");
    const returned = await service.completeFromRun(record.handoffId, {
      runId: "run-handoff-1",
      runStatus: settled.status,
      tasks: readMultitaskRunTasks(artifact),
    });
    assert.equal(returned?.status, "returned");
    assert.equal(returned?.returnSummary?.status, "completed");
    assert.deepEqual(returned?.returnSummary?.artifacts, [
      { kind: "multitask-run", id: "run-handoff-1" },
    ]);
    await assert.rejects(
      service.completeFromRun(record.handoffId, {
        runId: "run-handoff-1",
        runStatus: settled.status,
        tasks: readMultitaskRunTasks(artifact),
      }),
      /already/,
    );
  }));

test("user declining the Multitask run confirmation rejects the handoff without starting a run", () =>
  withCwd(async (cwd) => {
    const runHost = createRunHost(cwd);
    const harness = createHarnessHost(cwd, runHost);
    harness.state.userDecision = "deny";
    const service = createCrossModeMultitaskHandoffService({ host: harness.host });

    const outcome = await service.start(handoffRequest());
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(harness.confirmations.length, 1);
    assert.equal(outcome.record.status, "rejected");
    assert.ok(outcome.record.rejectionReason);
    assert.equal(runHost.runs.size, 0, "no run without the user's run confirmation");
  }));

test("unavailable target session rejects the handoff with a reason and stays retryable", () =>
  withCwd(async (cwd) => {
    const runHost = createRunHost(cwd);
    const harness = createHarnessHost(cwd, runHost);
    harness.state.multitaskAvailable = false;
    const service = createCrossModeMultitaskHandoffService({ host: harness.host });

    const outcome = await service.start(handoffRequest());
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const record = outcome.record;
    assert.equal(record.status, "rejected");
    assert.match(record.rejectionReason ?? "", /^Multitask did not start: \S+: .*Multitask/);
    assert.doesNotMatch(record.rejectionReason ?? "", /object Object/);
    assert.equal(record.attempts, 1);
    assert.equal(runHost.runs.size, 0);

    // 目标恢复可用后，Cross-Mode 自己的重试语义（attempts 递增）照常工作。
    harness.state.multitaskAvailable = true;
    runHost.setBehaviors({ a: submitDone(counts(1)), b: submitDone(counts(1, 1)) });
    const retried = await service.retry(record.handoffId);
    assert.equal(retried.status, "accepted");
    assert.equal(retried.attempts, 2);
    await runHost.runs.get(retried.externalRef!.id)!.settled;
  }));

test("wrong-flow or under-permitted packets are rejected by the adapter, never submitted", () =>
  withCwd(async (cwd) => {
    const runHost = createRunHost(cwd);
    const harness = createHarnessHost(cwd, runHost);
    const service = createCrossModeMultitaskHandoffService({ host: harness.host });

    const outcome = await service.start(handoffRequest({ permissions: ["repo-read"] }));
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.record.status, "rejected");
    assert.equal(outcome.record.rejectionReason, "multitask_handoff_permission_denied");
    assert.equal(harness.confirmations.length, 0);
    assert.equal(runHost.runs.size, 0);
  }));

test("cancel after handoff, then resume: completed worker is reused, the rest reruns, return is completed", () =>
  withCwd(async (cwd) => {
    const runHost = createRunHost(cwd);
    let releaseBuilder!: () => void;
    const builderStarted = new Promise<void>((resolve) => {
      releaseBuilder = resolve;
    });
    // 第一世：reader 完成，builder 开工后被用户停下。
    runHost.setBehaviors({ a: submitDone(counts(2)), b: () => releaseBuilder() });
    const harness = createHarnessHost(cwd, runHost);
    const service = createCrossModeMultitaskHandoffService({ host: harness.host });

    const outcome = await service.start(handoffRequest());
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const record = outcome.record;
    const runId = record.externalRef!.id;

    await builderStarted;
    await runHost.port.cancel(runId);
    const stopped = await runHost.runs.get(runId)!.settled;
    assert.equal(stopped.status, "stopped");
    // run 停下不改 handoff 记录：取消 / 恢复归 Workflow 所有，Cross-Mode 只持回链。
    assert.equal((await service.get(record.handoffId))?.status, "accepted");

    // 第二世：冷重放恢复同一个 run。
    runHost.setBehaviors({ a: submitDone(counts(2)), b: submitDone(counts(2, 1)) });
    const resumed = runHost.resume(runId);
    const settled = await resumed.settled;
    assert.equal(settled.status, "completed");
    assert.deepEqual(resumed.dispatched, ["a", "b", "b"], "a dispatched once (first life), b twice");
    const cached = resumed.events.filter(
      (event) => event.type === "node-settled" && (event as { cached?: boolean }).cached === true,
    );
    assert.equal(cached.length, 1, "the completed reader settled from the journal, not a new ask");
    const reports = resumed.events.filter((event) => event.type === "report");
    assert.equal(reports.length, 2, "one report per task across both lives (no duplicate for a)");

    const artifact = settled.status === "completed" ? settled.artifact : undefined;
    const returned = await service.completeFromRun(record.handoffId, {
      runId,
      runStatus: settled.status,
      tasks: readMultitaskRunTasks(artifact),
    });
    assert.equal(returned?.returnSummary?.status, "completed");
    assert.equal(returned?.externalRef?.id, runId, "the backlink survives cancel and resume");
  }));

test("an unfinished task makes the return honestly partial, and returnPolicy none returns nothing", () =>
  withCwd(async (cwd) => {
    const runHost = createRunHost(cwd);
    runHost.setBehaviors({
      a: (instance, sink) =>
        sink.askSubmitAttempted(
          instance,
          multitaskSubmission(
            { multitaskWorker: true, modelActivity: { toolCounts: () => counts(1) } as never },
            { status: "blocked", result: "contract missing" },
          ),
        ),
    });
    const harness = createHarnessHost(cwd, runHost);
    const service = createCrossModeMultitaskHandoffService({ host: harness.host });

    const outcome = await service.start(handoffRequest());
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const record = outcome.record;
    const settled = await runHost.runs.get(record.externalRef!.id)!.settled;
    const artifact = settled.status === "completed" ? settled.artifact : undefined;
    const summary = await service.returnFromRun(record.handoffId, {
      runId: record.externalRef!.id,
      runStatus: settled.status,
      tasks: readMultitaskRunTasks(artifact),
    });
    assert.equal(summary?.status, "partial");
    assert.deepEqual(summary?.unresolved.map((note) => note.text), ["a: blocked", "b: skipped"]);

    const silent = await service.start(handoffRequest({ returnPolicy: "none" }));
    assert.equal(silent.ok, true);
    if (!silent.ok) return;
    const silentReturn = await service.completeFromRun(silent.record.handoffId, {
      runId: "run-silent",
      runStatus: "completed",
      tasks: {},
    });
    assert.equal(silentReturn, null);
    assert.equal((await service.get(silent.record.handoffId))?.status, "accepted");
  }));
