/**
 * setModel 记下的 pending model_change 必须与真正开轮的提交对账（specs/model-change-divider.md，
 * 位于 apps/zcode-cli/packages/bootstrap/specs/）。修复前：setModel(Azure) 后提交 Command Code，
 * 持久化部件仍声称 Command Code → Azure，而那一轮实际跑在 Command Code。
 *
 * Run: mise exec -- node --import tsx --test apps/zcode-cli/packages/core/test/turn-model-pending-change.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelSelection, TraceContext } from "@zcode/contracts";
import { applySubmissionExecutionState } from "../src/runtime/methods/turn-model.js";
import { recordPendingModelChange } from "../src/runtime/methods/timeline-persistence.js";

const CC: ModelSelection = {
  providerId: "command-code",
  modelId: "gpt-5.6-sol",
  options: { reasoningLevel: "max" },
};
const AZURE: ModelSelection = {
  providerId: "azure-openai",
  modelId: "gpt-5-mini",
  options: { reasoningLevel: "low" },
};
const ZAI: ModelSelection = {
  providerId: "account:zai-individual-coding-plan",
  modelId: "GLM-5.3",
};
const TRACE = { traceId: "trace-pending" } as unknown as TraceContext;
const MODEL = {
  options: { reasoningLevel: undefined },
  optionSpecs: { reasoningLevel: { values: [] } },
} as never;

function runtimeAt(selection: ModelSelection) {
  const runtime = {
    selection,
    pendingModelChangeTimeline: undefined as
      | undefined
      | { fromModel?: ModelSelection; toModel: ModelSelection },
    emitted: [] as ModelSelection[],
    getSessionModelSelection() {
      return this.selection;
    },
    setSessionModelSelection(next: ModelSelection) {
      this.selection = next;
    },
    async emitModelSelected(options: { modelSelection: ModelSelection }) {
      this.emitted.push(options.modelSelection);
    },
    recordPendingModelChange,
  };
  return runtime;
}

/** session-facade.setModel 的同一组动作（非 transient）。 */
function setModel(runtime: ReturnType<typeof runtimeAt>, next: ModelSelection) {
  const previous = runtime.selection;
  runtime.setSessionModelSelection(next);
  runtime.recordPendingModelChange({
    fromModel: previous,
    fromModelLabel: `${previous.providerId}/${previous.modelId}`,
    toModel: next,
    toModelLabel: `${next.providerId}/${next.modelId}`,
  });
}

const submit = (runtime: ReturnType<typeof runtimeAt>, selection: ModelSelection) =>
  applySubmissionExecutionState(
    runtime as never,
    { modelSelection: selection } as never,
    TRACE,
    undefined,
    MODEL,
  );

test("a submission that returns to the previous model clears the pending model change", async () => {
  const runtime = runtimeAt(CC);
  setModel(runtime, AZURE);
  assert.deepEqual(runtime.pendingModelChangeTimeline?.toModel, AZURE);
  await submit(runtime, CC);
  assert.equal(
    runtime.pendingModelChangeTimeline,
    undefined,
    "no divider for a switch that never ran",
  );
  assert.deepEqual(runtime.selection, CC);
});

test("a submission to a third model rewrites the pending change to what actually runs", async () => {
  const runtime = runtimeAt(CC);
  setModel(runtime, AZURE);
  await submit(runtime, ZAI);
  assert.deepEqual(runtime.pendingModelChangeTimeline?.fromModel, CC);
  assert.deepEqual(runtime.pendingModelChangeTimeline?.toModel, ZAI);
});

test("a submission matching setModel keeps the pending change; no pending is invented otherwise", async () => {
  const migrated = runtimeAt(CC);
  setModel(migrated, AZURE);
  await submit(migrated, AZURE);
  assert.deepEqual(migrated.pendingModelChangeTimeline?.fromModel, CC);
  assert.deepEqual(migrated.pendingModelChangeTimeline?.toModel, AZURE);

  const composerOnly = runtimeAt(AZURE);
  await submit(composerOnly, ZAI);
  assert.equal(composerOnly.pendingModelChangeTimeline, undefined);
  assert.deepEqual(composerOnly.emitted, [ZAI], "the live projection still learns the switch");
});
