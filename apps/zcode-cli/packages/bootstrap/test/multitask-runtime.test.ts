import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultitaskInputSchema } from "@zcode/contracts";
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
import { buildMultitaskScript } from "../../core/src/tool/handlers/multitask-graph.js";
import { multitaskActorPolicy } from "../src/app/multitask-actor-policy.js";

/** 与生产 submit 同一条路径造 askSpecs：Multitask 任务是 typed ask，schema 必须由脚本类型合成。 */
function multitaskAskSpecs(scriptText: string) {
  const program = createWorkflowProgram(scriptText);
  const table = collectSites(program);
  const { diagnostics, schemas } = synthesizeAskSchemas(program, table);
  assert.deepEqual(diagnostics, []);
  return buildAskSpecs(table, schemas);
}

/** 运行时盖章后的证据形状（driver 侧真实写入的就是这五个键）。 */
const evidence = (world: number, mutating = 0) => ({
  toolCalls: world,
  worldToolCalls: world,
  mutatingToolCalls: mutating,
  commandCalls: 0,
  filesChanged: mutating > 0 ? ["cart.mjs"] : [],
});

/** worker 声明完成，并带上有真实动作的证据。 */
function submitDone(sink: WorkflowReportSink, instance: InstanceRef, id: string, mutating = 0) {
  sink.askSubmitAttempted(instance, {
    status: "done",
    result: `result-${id}`,
    evidence: evidence(1, mutating),
  });
}

const done = (task: string, worker: string, mutating = 0) => ({
  task,
  worker,
  outcome: "done",
  result: `result-${task}`,
  evidence: evidence(1, mutating),
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("real Workflow harness runs readers concurrently, excludes writers, passes results and journals persona", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "acevra-multitask-test-"));
  try {
    const input = MultitaskInputSchema.parse({
      name: "M1",
      objective: "Inspect then edit then verify",
      workers: [
        { id: "a", role: "Runtime", access: "read" },
        { id: "b", role: "UI", access: "read" },
        { id: "editor", role: "Builder", access: "write" },
      ],
      tasks: [
        { id: "a", worker: "a", prompt: "A" },
        { id: "edit", worker: "editor", prompt: "edit", dependsOn: ["a", "b"] },
        { id: "b", worker: "b", prompt: "B" },
        { id: "verify", worker: "a", prompt: "verify", dependsOn: ["edit"] },
      ],
    });
    const scriptText = buildMultitaskScript(input, []);
    const askSpecs = multitaskAskSpecs(scriptText);
    const journal = new InMemoryJournalStore();
    const started: string[] = [];
    const active = new Set<string>();
    const releases = new Map<string, () => void>();
    const signals = new Map(input.tasks.map((task) => [task.id, deferred()]));
    let sink!: WorkflowReportSink;
    const running = runWorkflowScript({
      scriptText,
      cwd,
      runId: "m1-run",
      caps: { maxConcurrency: 3 },
      askSpecs,
      validate: () => [],
      timeoutMs: 10000,
      makeDriver: (report) => {
        sink = report;
        return {
          journal,
          emit: () => {},
          createActorSession: async (actor, persona) => {
            assert.ok(persona.worker);
            assert.ok(multitaskActorPolicy(persona).toolDisallowlist?.includes("Multitask"));
            return { id: actor.siteId };
          },
          startAsk: (_session, instance, message) => {
            const id = /^Task (\w+):/.exec(message.instructions)![1];
            if (id === "edit") assert.equal(active.size, 0);
            else assert.equal(active.has("edit"), false);
            assert.equal(message.typed, true);
            if (id === "verify") assert.match(message.instructions, /"edit":\{"task":"edit".*"outcome":"done"\}/);
            started.push(id);
            active.add(id);
            releases.set(id, () => {
              active.delete(id);
              submitDone(sink, instance, id, id === "edit" ? 1 : 0);
            });
            signals.get(id)!.resolve();
          },
          respondToSubmit: () => {},
          cancelAsk: () => {},
          executeWorldRead: async () => null,
        };
      },
    });
    await Promise.all([signals.get("a")!.promise, signals.get("b")!.promise]);
    assert.equal(active.size, 2);
    assert.equal(started.includes("edit"), false);
    releases.get("a")!();
    releases.get("b")!();
    await signals.get("edit")!.promise;
    assert.deepEqual([...active], ["edit"]);
    releases.get("edit")!();
    await signals.get("verify")!.promise;
    releases.get("verify")!();
    const result = await running;
    assert.equal(result.status, "completed");
    assert.deepEqual(result.status === "completed" ? result.artifact : undefined, {
      a: done("a", "a"),
      b: done("b", "b"),
      edit: done("edit", "editor", 1),
      verify: done("verify", "a"),
    });
    assert.equal(journal.listActors("m1-run").length, 3);
    // profile 未声明 permissionMode 时 persona 必须留空，由既有继承规则决定 worker 模式。
    assert.equal(journal.listActors("m1-run")[0].persona.worker?.permissionMode, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("actor profile applies model, permission, tool deny and turn limit without changing Workflow defaults", () => {
  assert.deepEqual(multitaskActorPolicy({ system: "normal Workflow" }), {});
  // 回归：worker 未声明 permissionMode 时不能兜底成 mode "auto"（runtime 尚未实现，权限层会全拒）。
  assert.equal(
    multitaskActorPolicy({ worker: { profile: "p", access: "read", tools: ["Read"] } }).mode,
    undefined,
  );
  // 回归：通配 "*" 进入 toolAllowlist 会按精确名求交集，把 worker 工具面清空。
  assert.equal(
    multitaskActorPolicy({ worker: { profile: "p", access: "write", tools: ["*"] } }).toolAllowlist,
    undefined,
  );
  // 回归（M2 live）：白名单收窄能力，但 Workflow 协议工具必须恒在，否则 typed 任务交不了结果。
  assert.deepEqual(
    multitaskActorPolicy({ worker: { profile: "p", access: "read", tools: ["Read", "Grep"] } })
      .toolAllowlist,
    ["Read", "Grep", "submit_result", "escalate"],
  );
  const policy = multitaskActorPolicy({
    worker: {
      profile: "saved",
      access: "read",
      tools: ["Read"],
      disallowedTools: ["WebFetch"],
      modelSelection: { providerId: "p", modelId: "m", options: { reasoningLevel: "high" } },
      permissionMode: "plan",
      maxTurns: 5,
    },
  });
  assert.equal(policy.mode, "plan");
  assert.equal(policy.maxTurns, 5);
  assert.equal(policy.modelSelection?.options?.reasoningLevel, "high");
  assert.ok(policy.toolDisallowlist?.includes("WebFetch"));
  assert.ok(policy.toolDisallowlist?.includes("Agent"));
  assert.deepEqual(policy.toolAllowlist, ["Read", "submit_result", "escalate"]);
});

test("cancel then cold replay reuses completed reader output and frozen worker policies", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "acevra-multitask-resume-test-"));
  try {
    const scriptText = buildMultitaskScript(
      MultitaskInputSchema.parse({
        name: "Replay",
        objective: "Two reads",
        workers: [{ id: "reader", role: "Reader", access: "read" }],
        tasks: [
          { id: "a", worker: "reader", prompt: "A" },
          { id: "b", worker: "reader", prompt: "B", dependsOn: ["a"] },
        ],
      }),
      [],
    );
    const askSpecs = multitaskAskSpecs(scriptText);
    const journal = new InMemoryJournalStore();
    const started = deferred();
    const controller = new AbortController();
    let replay = false;
    const resumedAsks: string[] = [];
    const options = {
      scriptText,
      cwd,
      runId: "resume-run",
      caps: { maxConcurrency: 1 },
      askSpecs,
      validate: () => [],
      timeoutMs: 10000,
      makeDriver: (sink: WorkflowReportSink) => ({
        journal,
        emit: () => {},
        createActorSession: async (
          actor: { siteId: string },
          persona: { worker?: { profile: string } },
        ) => {
          assert.equal(persona.worker?.profile, "general-purpose");
          return { id: actor.siteId };
        },
        startAsk: (
          _session: unknown,
          instance: Parameters<WorkflowReportSink["askTurnEnded"]>[0],
          message: { instructions: string },
        ) => {
          const id = /^Task (\w+):/.exec(message.instructions)![1];
          if (replay) {
            resumedAsks.push(id);
            submitDone(sink, instance, id);
          } else if (id === "a") submitDone(sink, instance, "a");
          else started.resolve();
        },
        respondToSubmit: () => {},
        cancelAsk: () => {},
        executeWorldRead: async () => null,
      }),
    };
    const initial = runWorkflowScript({ ...options, signal: controller.signal });
    await started.promise;
    controller.abort("user");
    assert.equal((await initial).status, "stopped");
    replay = true;
    const resumed = await runWorkflowScript(options);
    assert.equal(resumed.status, "completed");
    assert.deepEqual(resumedAsks, ["b"]);
    // 已完成的 a 在 resume 时按 journal 重放（连同运行时证据），不重新派发。
    assert.deepEqual(resumed.status === "completed" ? resumed.artifact : undefined, {
      a: done("a", "reader"),
      b: done("b", "reader"),
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

type Behavior = (sink: WorkflowReportSink, instance: InstanceRef, attempt: number) => void;

/** 按任务 id 驱动一次真实 harness 运行；每个 ask（含 nudge 轮）调用一次该任务的行为。 */
async function runMultitask(raw: unknown, behaviors: Record<string, Behavior>) {
  const cwd = await mkdtemp(join(tmpdir(), "acevra-multitask-m2-test-"));
  try {
    const scriptText = buildMultitaskScript(MultitaskInputSchema.parse(raw), []);
    const journal = new InMemoryJournalStore();
    const events: RunEvent[] = [];
    const dispatched: string[] = [];
    const attempts = new Map<string, number>();
    const byInstance = new Map<string, string>();
    let sink!: WorkflowReportSink;
    const drive = (instance: InstanceRef) => {
      const id = byInstance.get(`${instance.siteId}@${instance.ordinal}`)!;
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      behaviors[id]!(sink, instance, attempt);
    };
    const result = await runWorkflowScript({
      scriptText,
      cwd,
      runId: "m2-run",
      caps: { maxConcurrency: 2 },
      askSpecs: multitaskAskSpecs(scriptText),
      validate: () => [],
      timeoutMs: 10000,
      makeDriver: (report) => {
        sink = report;
        return {
          journal,
          emit: (event) => events.push(event),
          createActorSession: async (actor) => ({ id: actor.siteId }),
          startAsk: (_session, instance, message) => {
            const id = /^Task (\w+):/.exec(message.instructions)![1];
            dispatched.push(id);
            byInstance.set(`${instance.siteId}@${instance.ordinal}`, id);
            queueMicrotask(() => drive(instance));
          },
          // nudge：引擎在同一个 ask 上再起一轮，行为按第 2 次尝试再跑一次。
          respondToSubmit: (instance, verdict) => {
            if (verdict.kind === "nudge") queueMicrotask(() => drive(instance));
          },
          cancelAsk: () => {},
          executeWorldRead: async () => null,
        };
      },
    });
    const reports = events
      .filter((event) => event.type === "report")
      .map((event) => (event as { item?: unknown }).item);
    return { result, dispatched, reports, attempts };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const twoStep = (firstAccess: "read" | "write" = "read") => ({
  name: "M2",
  objective: "Do then check",
  workers: [
    { id: "first", role: "First", access: firstAccess },
    { id: "second", role: "Second", access: "read" },
  ],
  tasks: [
    { id: "a", worker: "first", prompt: "A" },
    { id: "b", worker: "second", prompt: "B", dependsOn: ["a"] },
  ],
});

const outcomes = (artifact: unknown) =>
  Object.fromEntries(
    Object.entries(artifact as Record<string, { outcome: string }>).map(([id, value]) => [
      id,
      value.outcome,
    ]),
  );

test("a worker that ends its turn without submitting is nudged, then fails; dependents are skipped", async () => {
  const run = await runMultitask(twoStep(), {
    // 回归 M1：没有工具的 worker 只说一句话就结束 turn，曾被当作完成。
    a: (sink, instance) => sink.askTurnEnded(instance, "Reading the files first."),
    b: (sink, instance) => submitDone(sink, instance, "b"),
  });
  assert.equal(run.result.status, "completed");
  assert.equal(run.attempts.get("a"), 2, "one nudge before failing");
  assert.deepEqual(run.dispatched, ["a"], "dependent never dispatched");
  const artifact = run.result.status === "completed" ? run.result.artifact : undefined;
  assert.deepEqual(outcomes(artifact), { a: "failed", b: "skipped" });
  assert.match((artifact as { a: { result: string } }).a.result, /^ResultNotSubmitted/);
  assert.deepEqual(
    run.reports.map((item) => (item as { outcome: string }).outcome),
    ["failed", "skipped"],
  );
});

test("a blocked declaration is honest failure and skips dependents", async () => {
  const run = await runMultitask(twoStep(), {
    a: (sink, instance) =>
      sink.askSubmitAttempted(instance, {
        status: "blocked",
        result: "inventory.json is missing",
        evidence: evidence(2),
      }),
    b: (sink, instance) => submitDone(sink, instance, "b"),
  });
  const artifact = run.result.status === "completed" ? run.result.artifact : undefined;
  assert.deepEqual(outcomes(artifact), { a: "blocked", b: "skipped" });
  assert.deepEqual(run.dispatched, ["a"]);
});

test("claims without matching evidence are unverified or no-changes, never done", async () => {
  const reader = await runMultitask(twoStep(), {
    a: (sink, instance) =>
      sink.askSubmitAttempted(instance, { status: "done", result: "all good", evidence: evidence(0) }),
    b: (sink, instance) => submitDone(sink, instance, "b"),
  });
  const readerArtifact = reader.result.status === "completed" ? reader.result.artifact : undefined;
  // unverified 不阻断下游：后面的 verifier 正是用来裁定它的。
  assert.deepEqual(outcomes(readerArtifact), { a: "unverified", b: "done" });

  const missing = await runMultitask(twoStep(), {
    a: (sink, instance) => sink.askSubmitAttempted(instance, { status: "done", result: "ok" }),
    b: (sink, instance) => submitDone(sink, instance, "b"),
  });
  const missingArtifact =
    missing.result.status === "completed" ? missing.result.artifact : undefined;
  assert.equal(outcomes(missingArtifact).a, "unverified");

  const writer = await runMultitask(twoStep("write"), {
    a: (sink, instance) => submitDone(sink, instance, "a", 0),
    b: (sink, instance) => submitDone(sink, instance, "b"),
  });
  const writerArtifact = writer.result.status === "completed" ? writer.result.artifact : undefined;
  assert.deepEqual(outcomes(writerArtifact), { a: "done_no_changes", b: "done" });
});

test("cancellation still stops the run instead of becoming a task outcome", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "acevra-multitask-m2-cancel-"));
  try {
    const scriptText = buildMultitaskScript(MultitaskInputSchema.parse(twoStep()), []);
    const controller = new AbortController();
    const started = deferred();
    const result = runWorkflowScript({
      scriptText,
      cwd,
      runId: "m2-cancel",
      caps: { maxConcurrency: 1 },
      askSpecs: multitaskAskSpecs(scriptText),
      validate: () => [],
      timeoutMs: 10000,
      signal: controller.signal,
      makeDriver: () => ({
        journal: new InMemoryJournalStore(),
        emit: () => {},
        createActorSession: async (actor) => ({ id: actor.siteId }),
        startAsk: () => started.resolve(),
        respondToSubmit: () => {},
        cancelAsk: () => {},
        executeWorldRead: async () => null,
      }),
    });
    await started.promise;
    controller.abort("user");
    const settled = await result;
    assert.equal(settled.status, "stopped");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
