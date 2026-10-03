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
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "@zcode/dynamic-workflow-runtime";
import { buildMultitaskScript } from "../../core/src/tool/handlers/multitask-graph.js";
import { multitaskActorPolicy } from "../src/app/multitask-actor-policy.js";

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
    const askSpecs = buildAskSpecs(collectSites(createWorkflowProgram(scriptText)), {});
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
            if (id === "verify") assert.match(message.instructions, /"edit":"result-edit"/);
            started.push(id);
            active.add(id);
            releases.set(id, () => {
              active.delete(id);
              sink.askTurnEnded(instance, `result-${id}`);
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
      a: "result-a",
      b: "result-b",
      edit: "result-edit",
      verify: "result-verify",
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
  assert.deepEqual(
    multitaskActorPolicy({ worker: { profile: "p", access: "read", tools: ["Read", "Grep"] } })
      .toolAllowlist,
    ["Read", "Grep"],
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
  assert.deepEqual(policy.toolAllowlist, ["Read"]);
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
    const askSpecs = buildAskSpecs(collectSites(createWorkflowProgram(scriptText)), {});
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
            sink.askTurnEnded(instance, `result-${id}`);
          } else if (id === "a") sink.askTurnEnded(instance, "result-a");
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
    assert.deepEqual(resumed.status === "completed" ? resumed.artifact : undefined, {
      a: "result-a",
      b: "result-b",
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
