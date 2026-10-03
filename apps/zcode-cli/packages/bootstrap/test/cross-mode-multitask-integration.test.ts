/**
 * Cross-Mode × Multitask 集成场景（真实接缝 harness）。
 *
 * 两个冻结特性都没有 `HandoffExecutionPort` 的生产实现（Cross-Mode M2 §8 把执行方的宿主留作开放问题），
 * 所以这里的执行方是**仅测试**的集成胶水：它只调用两侧已冻结的公开面，不新增产品代码。
 * 除模型以外全部是真实实现：
 *   Cross-Mode 预览 / 确认 / 准入服务（@zcode/shared/cross-mode）
 *   → Multitask 采纳适配器（core/src/cross-mode）
 *   → 真实 ToolExecutor + PermissionService + 权限 broker（运行确认闸门）
 *   → 真实 Multitask 工具（画像冻结、脚本降级）
 *   → DynamicWorkflowRunPort.submit 落到真实 Workflow 引擎（runWorkflowScript，真实 journal / 取消 / 冷重放）
 *   → 真实 driver 证据盖章（multitaskSubmission）
 *   → 返回摘要（采纳适配器）→ Cross-Mode recordReturn。
 * 只有「模型」是假的：fake driver 按任务 id 扮演 worker 提交结果。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  beginHandoffPreview,
  confirmHandoffPreview,
  createHandoffAdmissionService,
  createHandoffContextItem,
  createHandoffPacket,
  type CreateHandoffPacketInput,
  type HandoffConfirmation,
  type HandoffExecutionPort,
  type HandoffPacket,
} from "@zcode/shared/cross-mode";
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
import {
  buildMultitaskHandoffReturn,
  buildMultitaskHandoffSubmission,
  type MultitaskHandoffPlan,
} from "../../core/src/cross-mode/index.js";
import { createToolExecutor } from "../../core/src/tool/executor/impl.js";
import { createToolRegistry } from "../../core/src/tool/registry.js";
import { createMultitaskToolEntry } from "../../core/src/tool/handlers/multitask.js";
import { PermissionService, defaultPermissionConfig } from "../../core/src/permission/service.js";
import { multitaskSubmission } from "../src/app/multitask-worker-evidence.js";
import type { ActorToolCounts } from "../src/app/workflow-driver-tool-activity.js";

// ———————————————————————————— handoff 来源（Coding 会话侧） ————————————————————————————

function handoffInput(overrides: Partial<CreateHandoffPacketInput> = {}): CreateHandoffPacketInput {
  return {
    sourceMode: "coding",
    destinationMode: "multitask",
    objective: "Implement discountTotal and verify it",
    returnPolicy: "summary-and-artifacts",
    sourceRefs: [{ kind: "coding-session", id: "sess-coding-1" }],
    linkedProject: { kind: "project", id: "acevra" },
    permissions: ["repo-read", "repo-write"],
    constraints: ["only edit m2a/"],
    context: [
      createHandoffContextItem({
        label: "Contract",
        content: "discountTotal(items, percent) reduces the subtotal by percent.",
        provenance: [{ kind: "decision", id: "d-1" }],
      }),
      createHandoffContextItem({
        label: "Private note",
        content: "SECRET-PERSONAL-NOTE",
        sensitivity: "personal",
      }),
    ],
    ...overrides,
  };
}

/** 用户在预览里确认：只有确认产生冻结快照，编辑不派发任何东西。 */
function confirm(packet: HandoffPacket): HandoffConfirmation {
  const confirmed = confirmHandoffPreview(beginHandoffPreview(packet, 1), 2);
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  if (!confirmed.ok) throw new Error("unreachable");
  return confirmed.session.confirmation!;
}

const plan: MultitaskHandoffPlan = {
  workers: [
    { id: "reader", role: "Reader", access: "read" },
    { id: "builder", role: "Builder", access: "write" },
  ],
  tasks: [
    { id: "a", worker: "reader", prompt: "Read the contract", dependsOn: [] },
    { id: "b", worker: "builder", prompt: "Implement it", dependsOn: ["a"] },
  ],
};

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

// ———————————————————————————— 仅测试的集成胶水：HandoffExecutionPort ————————————————————————————

interface ExecutorHarness {
  execution: HandoffExecutionPort;
  confirmations: string[];
}

/**
 * Coding → Multitask 执行方。职责只有一条：把冻结 packet 交给 Multitask **既有的**提交路径，
 * 返回 accepted(externalRef) / rejected(reason)。它不碰 handoff 记录（Cross-Mode 独占），
 * 也不碰 run 生命周期（Workflow/Multitask 独占）。
 */
function createHarnessExecutor(input: {
  cwd: string;
  host: ReturnType<typeof createRunHost>;
  multitaskAvailable: boolean;
  userDecision: "allow" | "deny";
}): ExecutorHarness {
  const confirmations: string[] = [];
  const registry = createToolRegistry();
  // 目标会话没有 Multitask（动态 Workflow 灰度关闭 / 无 run 端口）时工具根本不注册——与生产一致。
  if (input.multitaskAvailable) registry.register(createMultitaskToolEntry());
  const executor = createToolExecutor({
    registry,
    permissionService: new PermissionService(defaultPermissionConfig),
    permissionBroker: {
      requestPermission: async (request) => {
        confirmations.push(String((request.input as { name?: string }).name));
        return { decision: input.userDecision };
      },
    },
    emitEvent: async () => {},
    sessionId: "target-coding-session" as never,
    getWorkingDirectory: () => input.cwd,
    dynamicWorkflowRunPort: input.host.port as never,
  });
  return {
    confirmations,
    execution: {
      async execute({ packet }) {
        const built = buildMultitaskHandoffSubmission(packet, plan);
        if (!built.ok)
          return { status: "rejected", reason: built.issues.map((issue) => issue.code).join(", ") };
        const result = await executor.execute({
          id: `handoff-${packet.handoffId}`,
          name: "Multitask",
          input: built.submission.input,
        });
        if (!result.success)
          return {
            status: "rejected",
            // 理由必须是可展示的短文本（ports.ts 契约）：取执行器结构化错误的 code / message。
            reason: `Multitask did not start: ${result.error?.code ?? "error"}: ${result.error?.message ?? "unknown"}`.slice(0, 200),
          };
        const runId = (result.output as { backgroundTaskId: string }).backgroundTaskId;
        return {
          status: "accepted",
          externalRef: { kind: "multitask-run", id: runId },
          displayName: built.submission.input.name,
        };
      },
    },
  };
}

/** M2 任务结局 → 冻结返回状态：只有全部 done 才是 completed，partial 绝不升级（采纳层的规则）。 */
function returnFromRun(packet: HandoffPacket, runId: string, artifact: unknown, status: string) {
  const outcomes = Object.values(artifact as Record<string, { task: string; outcome: string }>);
  const unfinished = outcomes.filter((entry) => entry.outcome !== "done");
  return buildMultitaskHandoffReturn(packet, {
    status:
      status !== "completed" ? "cancelled" : unfinished.length === 0 ? "completed" : "partial",
    summary: `${outcomes.length - unfinished.length}/${outcomes.length} tasks done`,
    unresolved: unfinished.map((entry) => ({ text: `${entry.task}: ${entry.outcome}` })),
    artifacts: [{ kind: "multitask-run", id: runId }],
  });
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
    const host = createRunHost(cwd);
    host.setBehaviors({ a: submitDone(counts(2)), b: submitDone(counts(3, 1)) });
    const harness = createHarnessExecutor({ cwd, host, multitaskAvailable: true, userDecision: "allow" });
    const admission = createHandoffAdmissionService({ execution: harness.execution });
    const packet = createHandoffPacket(handoffInput());

    const record = await admission.admit(confirm(packet));
    // Multitask 的运行确认没有被交接绕过：确认窗恰好出现一次，展示的是交接派生的运行名。
    assert.deepEqual(harness.confirmations, [`Handoff: ${packet.objective}`]);
    assert.equal(record.status, "accepted");
    assert.deepEqual(record.externalRef, { kind: "multitask-run", id: "run-handoff-1" });

    const run = host.runs.get("run-handoff-1")!;
    const settled = await run.settled;
    assert.equal(settled.status, "completed");
    const artifact = settled.status === "completed" ? settled.artifact : undefined;
    // M2 完成语义与证据保持不变：证据来自运行时盖章，模型伪造的 evidence 被覆盖。
    assert.deepEqual(
      Object.fromEntries(Object.entries(artifact as Record<string, { outcome: string }>).map(([k, v]) => [k, v.outcome])),
      { a: "done", b: "done" },
    );
    assert.equal((artifact as { b: { evidence: ActorToolCounts } }).b.evidence.mutatingToolCalls, 1);
    assert.equal("forged" in (artifact as { a: { evidence: object } }).a.evidence, false);

    // run 生命周期不回写 handoff 记录：直到显式 recordReturn 之前记录一直是 accepted。
    assert.equal((await admission.get(packet.handoffId))?.status, "accepted");
    const summary = returnFromRun(packet, "run-handoff-1", artifact, settled.status);
    const returned = await admission.recordReturn(summary!);
    assert.equal(returned.status, "returned");
    assert.equal(returned.returnSummary?.status, "completed");
    assert.deepEqual(returned.returnSummary?.artifacts, [{ kind: "multitask-run", id: "run-handoff-1" }]);
    await assert.rejects(admission.recordReturn(summary!), /already/);
  }));

test("user declining the Multitask run confirmation rejects the handoff without starting a run", () =>
  withCwd(async (cwd) => {
    const host = createRunHost(cwd);
    const harness = createHarnessExecutor({ cwd, host, multitaskAvailable: true, userDecision: "deny" });
    const admission = createHandoffAdmissionService({ execution: harness.execution });
    const packet = createHandoffPacket(handoffInput());
    const record = await admission.admit(confirm(packet));
    assert.equal(harness.confirmations.length, 1);
    assert.equal(record.status, "rejected");
    assert.equal(host.runs.size, 0, "no run without the user's run confirmation");
  }));

test("unavailable target session rejects the handoff with a reason and stays retryable", () =>
  withCwd(async (cwd) => {
    const host = createRunHost(cwd);
    const down = createHarnessExecutor({ cwd, host, multitaskAvailable: false, userDecision: "allow" });
    let execution: HandoffExecutionPort = down.execution;
    const admission = createHandoffAdmissionService({
      execution: { execute: (request) => execution.execute(request) },
    });
    const packet = createHandoffPacket(handoffInput());
    const confirmation = confirm(packet);

    const rejected = await admission.admit(confirmation);
    assert.equal(rejected.status, "rejected");
    assert.match(rejected.rejectionReason ?? "", /^Multitask did not start: \S+: .*Multitask/);
    assert.doesNotMatch(rejected.rejectionReason ?? "", /object Object/);
    assert.equal(rejected.attempts, 1);
    assert.equal(host.runs.size, 0);

    // 目标恢复可用后，Cross-Mode 自己的重试语义（attempts 递增）照常工作。
    host.setBehaviors({ a: submitDone(counts(1)), b: submitDone(counts(1, 1)) });
    execution = createHarnessExecutor({ cwd, host, multitaskAvailable: true, userDecision: "allow" }).execution;
    const retried = await admission.admit(confirmation);
    assert.equal(retried.status, "accepted");
    assert.equal(retried.attempts, 2);
    await host.runs.get("run-handoff-1")!.settled;
  }));

test("wrong-flow or under-permitted packets are rejected by the adapter, never submitted", () =>
  withCwd(async (cwd) => {
    const host = createRunHost(cwd);
    const harness = createHarnessExecutor({ cwd, host, multitaskAvailable: true, userDecision: "allow" });
    const admission = createHandoffAdmissionService({ execution: harness.execution });
    const readOnly = createHandoffPacket(handoffInput({ permissions: ["repo-read"] }));
    const record = await admission.admit(confirm(readOnly));
    assert.equal(record.status, "rejected");
    assert.equal(record.rejectionReason, "multitask_handoff_permission_denied");
    assert.equal(harness.confirmations.length, 0);
    assert.equal(host.runs.size, 0);
  }));

test("cancel after handoff, then resume: completed worker is reused, the rest reruns, return is completed", () =>
  withCwd(async (cwd) => {
    const host = createRunHost(cwd);
    let releaseBuilder!: () => void;
    const builderStarted = new Promise<void>((resolve) => {
      releaseBuilder = resolve;
    });
    // 第一世：reader 完成，builder 开工后被用户停下。
    host.setBehaviors({ a: submitDone(counts(2)), b: () => releaseBuilder() });
    const harness = createHarnessExecutor({ cwd, host, multitaskAvailable: true, userDecision: "allow" });
    const admission = createHandoffAdmissionService({ execution: harness.execution });
    const packet = createHandoffPacket(handoffInput());
    const record = await admission.admit(confirm(packet));
    const runId = record.externalRef!.id;

    await builderStarted;
    await host.port.cancel(runId);
    const stopped = await host.runs.get(runId)!.settled;
    assert.equal(stopped.status, "stopped");
    // run 停下不改 handoff 记录：取消 / 恢复归 Workflow 所有，Cross-Mode 只持回链。
    assert.equal((await admission.get(packet.handoffId))?.status, "accepted");

    // 第二世：冷重放恢复同一个 run。
    host.setBehaviors({ a: submitDone(counts(2)), b: submitDone(counts(2, 1)) });
    const resumed = host.resume(runId);
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
    const returned = await admission.recordReturn(returnFromRun(packet, runId, artifact, settled.status)!);
    assert.equal(returned.returnSummary?.status, "completed");
    assert.equal(returned.externalRef?.id, runId, "the backlink survives cancel and resume");
  }));

test("an unfinished task makes the return honestly partial, and returnPolicy none returns nothing", () =>
  withCwd(async (cwd) => {
    const host = createRunHost(cwd);
    host.setBehaviors({
      a: (instance, sink) =>
        sink.askSubmitAttempted(instance, multitaskSubmission(
          { multitaskWorker: true, modelActivity: { toolCounts: () => counts(1) } as never },
          { status: "blocked", result: "contract missing" },
        )),
    });
    const harness = createHarnessExecutor({ cwd, host, multitaskAvailable: true, userDecision: "allow" });
    const admission = createHandoffAdmissionService({ execution: harness.execution });
    const packet = createHandoffPacket(handoffInput());
    const record = await admission.admit(confirm(packet));
    const settled = await host.runs.get(record.externalRef!.id)!.settled;
    const artifact = settled.status === "completed" ? settled.artifact : undefined;
    const summary = returnFromRun(packet, record.externalRef!.id, artifact, settled.status)!;
    assert.equal(summary.status, "partial");
    assert.deepEqual(summary.unresolved.map((note) => note.text), ["a: blocked", "b: skipped"]);

    const silent = createHandoffPacket(handoffInput({ returnPolicy: "none" }));
    assert.equal(returnFromRun(silent, "run-x", artifact, "completed"), null);
  }));
