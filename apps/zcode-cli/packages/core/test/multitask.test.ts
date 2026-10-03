import assert from "node:assert/strict";
import { test } from "node:test";
import { MultitaskInputSchema } from "@zcode/contracts";
import { analyzeWorkflowScript } from "@zcode/dynamic-workflow";
import { buildMultitaskScript } from "../src/tool/handlers/multitask-graph.js";
import { createMultitaskToolEntry } from "../src/tool/handlers/multitask.js";
import { isDynamicWorkflowRunDispatchToolName } from "../src/tool/executor/background-task-registry.js";

const worker = (id: string, access: "read" | "write" = "read") => ({ id, role: id, access });
const task = (id: string, worker: string, dependsOn: string[] = []) => ({
  id,
  worker,
  prompt: id,
  dependsOn,
});
const graph = () => ({
  name: "Inspect architecture",
  objective: "Inspect runtime and UI",
  workers: [worker("runtime"), worker("ui")],
  tasks: [task("runtime", "runtime"), task("ui", "ui")],
});

test("bounds worker and task sets, validates references and cycles", () => {
  assert.throws(() =>
    MultitaskInputSchema.parse({
      ...graph(),
      workers: Array.from({ length: 5 }, (_, i) => worker(String(i))),
    }),
  );
  for (const tasks of [
    [task("x", "missing")],
    [task("x", "runtime", ["missing"])],
    [task("x", "runtime", ["y"]), task("y", "ui", ["x"])],
    [task("x", "runtime"), task("x", "ui")],
  ]) {
    assert.throws(() =>
      buildMultitaskScript(MultitaskInputSchema.parse({ ...graph(), tasks }), []),
    );
  }
});

test("lowers readers to concurrent asks, escapes text, compiles against Workflow", () => {
  const script = buildMultitaskScript(MultitaskInputSchema.parse(graph()), []);
  assert.match(script, /Promise\.all/);
  assert.equal(analyzeWorkflowScript(script).ok, true);
  const escaped = buildMultitaskScript(
    MultitaskInputSchema.parse({ ...graph(), objective: '` ${process.exit()} \n "test"' }),
    [],
  );
  assert.equal(analyzeWorkflowScript(escaped).ok, true);
});

test("writers form explicit exclusive barriers and dependents receive results", () => {
  const script = buildMultitaskScript(
    MultitaskInputSchema.parse({
      ...graph(),
      workers: [worker("read"), worker("write", "write")],
      tasks: [task("before", "read"), task("edit", "write", ["before"]), task("after", "read")],
    }),
    [],
  );
  assert.match(script, /await Promise\.all\(\[t0\]\)/);
  assert.match(script, /await Promise\.all\(\[t1, t0\]\)/);
  assert.match(script, /Dependency results/);
  assert.equal(analyzeWorkflowScript(script).ok, true);
});

test("freezes profiles and rejects unknown or unsupported policy", () => {
  const input = MultitaskInputSchema.parse({
    ...graph(),
    workers: [{ ...worker("runtime"), profile: "saved" }, worker("ui")],
  });
  const profile = {
    name: "saved",
    source: "user" as const,
    description: "Saved",
    systemPrompt: "Expert",
    modelSelection: { providerId: "p", modelId: "m", options: { reasoningLevel: "high" } },
    disallowedTools: ["WebFetch"],
    maxTurns: 7,
    permissionMode: "auto" as const,
  };
  const script = buildMultitaskScript(input, [profile]);
  assert.match(script, /Expert/);
  assert.match(script, /reasoningLevel/);
  assert.match(script, /"maxTurns":7/);
  assert.throws(() => buildMultitaskScript(input, []), /Unknown/);
  assert.throws(() => buildMultitaskScript(input, [{ ...profile, skills: ["skill"] }]), /M1/);
});

test("Multitask uses the Workflow display, approval and background lifecycle", async () => {
  const entry = createMultitaskToolEntry([]);
  const resolved = await entry.resolveInput!(graph(), { workingDirectory: "/tmp" });
  assert.equal(resolved.result, true);
  if (!resolved.result) return;
  const gate = await entry.prepareApproval!(resolved.input, {} as never);
  assert.equal(gate.gate, "ask");
  assert.equal(isDynamicWorkflowRunDispatchToolName("Multitask"), true);
  const requests: unknown[] = [];
  const output = (await entry.handler(resolved.input, {
    workingDirectory: "/tmp",
    sessionId: "parent",
    toolCallId: "call",
    dynamicWorkflowRunPort: {
      submit: async (request: unknown) => {
        requests.push(request);
        return { ok: true, runId: "run-1" };
      },
    },
  } as never)) as { backgroundTaskId: string; response: string };
  assert.equal(requests.length, 1);
  assert.equal(output.backgroundTaskId, "run-1");
  assert.match(output.response, /synthesize/i);
});

test("Multitask registry respects the availability gate and normal children cannot delegate", async () => {
  const { registerBuiltInTools } = await import("../src/tool/handlers/index.js");
  const { createToolRegistry } = await import("../src/tool/registry.js");
  const { resolveRuntimeDisallowedTools } =
    await import("../src/runtime/helpers/tool-allowlist.js");
  const registry = createToolRegistry();
  registerBuiltInTools(registry, { includeDynamicWorkflow: false });
  assert.equal(registry.has("Multitask"), false);
  registerBuiltInTools(registry, { includeDynamicWorkflow: true, silentDuplicateWarnings: true });
  assert.equal(registry.has("Multitask"), true);
  assert.ok(resolveRuntimeDisallowedTools({ taskType: "workflow_child" }).includes("Multitask"));
});

test("full executor admits raw graph, confirms generated graph and registers one background run", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createToolExecutor } = await import("../src/tool/executor/impl.js");
  const { createToolRegistry } = await import("../src/tool/registry.js");
  const { PermissionService, defaultPermissionConfig } =
    await import("../src/permission/service.js");
  const cwd = await mkdtemp(join(tmpdir(), "acevra-multitask-tool-test-"));
  try {
    const registry = createToolRegistry();
    registry.register(createMultitaskToolEntry());
    let confirmed = false;
    const executor = createToolExecutor({
      registry,
      permissionService: new PermissionService(defaultPermissionConfig),
      permissionBroker: {
        requestPermission: async (request) => {
          assert.match((request.input as { script: string }).script, /agent\(/);
          confirmed = true;
          return { decision: "allow" };
        },
      },
      emitEvent: async () => {},
      sessionId: "parent" as never,
      getWorkingDirectory: () => cwd,
      dynamicWorkflowRunPort: {
        submit: async () => ({ ok: true, runId: "m1-executor-run" }),
        getTask: async () => undefined,
      } as never,
    });
    const result = await executor.execute({ id: "m1-call", name: "Multitask", input: graph() });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(confirmed, true);
    assert.equal(
      (result.output as { backgroundTaskId: string }).backgroundTaskId,
      "m1-executor-run",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("worker model override wins over profile, preserves profile provenance, invalid models fail admission", async () => {
  const entry = createMultitaskToolEntry([
    {
      name: "saved",
      source: "user",
      description: "Saved",
      systemPrompt: "Expert",
      modelSelection: { providerId: "p", modelId: "base" },
    },
  ]);
  const input = {
    ...graph(),
    workers: [{ ...worker("runtime"), profile: "saved", model: "other$high" }, worker("ui")],
  };
  const modelCatalogPort = {
    listModels: () => [
      { providerId: "p", modelId: "base", reasoningLevels: [], current: true },
      {
        providerId: "p",
        modelId: "other",
        reasoningLevels: ["high"],
        defaultReasoningLevel: "high",
        current: false,
      },
    ],
  };
  const resolved = await entry.resolveInput!(input, { modelCatalogPort });
  assert.equal(resolved.result, true);
  if (resolved.result) {
    const script = (resolved.input as { script: string }).script;
    assert.match(script, /"profile":"saved"/);
    assert.match(script, /"modelId":"other"/);
    assert.match(script, /"reasoningLevel":"high"/);
  }
  const invalid = await entry.resolveInput!(
    { ...input, workers: [{ ...worker("runtime"), model: "missing" }, worker("ui")] },
    { modelCatalogPort },
  );
  assert.equal(invalid.result, false);
});
