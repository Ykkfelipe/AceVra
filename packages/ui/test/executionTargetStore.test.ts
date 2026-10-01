/**
 * Run-on selection and conversation ↔ task attachment (M2E).
 *
 * Pins the ownership rules from `acevra-execution-ux-m2e.md`:
 *  - selection is per execution scope and defaults to Automatic,
 *  - tasks attached to one conversation never leak into another,
 *  - the draft's choice merges into the first session once (session's explicit choice wins,
 *    tasks are unioned — an agent task may be attached before adopt, M2F).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { submissionExecutionTargetSchema, type ExecutionTarget } from "@zcode/shared";
import {
  AUTO_TARGET,
  executionScopeKey,
  resolveSubmissionExecutionTarget,
  useExecutionTargetStore,
} from "../src/store/executionTargetStore.js";

const reset = () =>
  useExecutionTargetStore.setState({
    selectionByScope: {},
    tasksByScope: {},
    activeScope: null,
    knownTargets: {},
  });

const target = (over: Partial<ExecutionTarget> & { id: string }): ExecutionTarget =>
  ({ displayName: over.id, isThisDevice: false, ...over }) as ExecutionTarget;

test("scope keys separate draft and session and prefer workspace identity", () => {
  assert.equal(executionScopeKey({ workspacePath: "/w" }, null), "draft:/w");
  assert.equal(
    executionScopeKey({ workspacePath: "/w", workspaceIdentity: " remote:x " }, null),
    "draft:remote:x",
  );
  assert.equal(executionScopeKey({ workspacePath: "/w" }, "s1"), "session:s1");
});

test("selection defaults to Automatic and is isolated per scope", () => {
  reset();
  const store = useExecutionTargetStore.getState();
  assert.equal(store.selectionOf("session:a"), AUTO_TARGET);
  store.select("session:a", "dev_node");
  assert.equal(useExecutionTargetStore.getState().selectionOf("session:a"), "dev_node");
  assert.equal(useExecutionTargetStore.getState().selectionOf("session:b"), AUTO_TARGET);
});

test("attached tasks are fenced by scope and idempotent", () => {
  reset();
  const { attachTask } = useExecutionTargetStore.getState();
  attachTask("session:a", "t1");
  attachTask("session:a", "t1");
  attachTask("session:b", "t2");
  const state = useExecutionTargetStore.getState();
  assert.deepEqual(state.tasksByScope["session:a"], ["t1"]);
  assert.deepEqual(state.tasksByScope["session:b"], ["t2"]);
  state.dismissTask("session:a", "t1");
  assert.deepEqual(useExecutionTargetStore.getState().tasksByScope["session:a"], []);
  assert.deepEqual(useExecutionTargetStore.getState().tasksByScope["session:b"], ["t2"]);
});

test("first send adopts the draft choice once and resets the draft", () => {
  reset();
  const store = useExecutionTargetStore.getState();
  store.select("draft:/w", "dev_node");
  store.attachTask("draft:/w", "t1");
  store.adoptDraft("draft:/w", "session:new");
  let state = useExecutionTargetStore.getState();
  assert.equal(state.selectionOf("session:new"), "dev_node");
  assert.deepEqual(state.tasksByScope["session:new"], ["t1"]);
  assert.equal(state.selectionOf("draft:/w"), AUTO_TARGET);
  assert.deepEqual(state.tasksByScope["draft:/w"] ?? [], []);
  // A session that already has its own choice is never overwritten; the draft still resets.
  state.select("draft:/w", "local");
  state.adoptDraft("draft:/w", "session:new");
  state = useExecutionTargetStore.getState();
  assert.equal(state.selectionOf("session:new"), "dev_node");
  assert.equal(state.selectionOf("draft:/w"), AUTO_TARGET);
  // Idempotent: adopting an already-reset draft changes nothing.
  const before = useExecutionTargetStore.getState();
  before.adoptDraft("draft:/w", "session:new");
  assert.equal(useExecutionTargetStore.getState(), before);
});

test("adopt merges: an agent task attached to the session before adopt is kept", () => {
  reset();
  const store = useExecutionTargetStore.getState();
  store.select("draft:/w", "dev_node");
  store.attachTask("draft:/w", "t1");
  store.attachTask("draft:/w", "t2");
  // M2F: Main's AgentTaskStarted push can land on the session before the composer adopts.
  store.attachTask("session:new", "t-agent");
  store.attachTask("session:new", "t2");
  store.adoptDraft("draft:/w", "session:new");
  const state = useExecutionTargetStore.getState();
  assert.equal(state.selectionOf("session:new"), "dev_node");
  assert.deepEqual(state.tasksByScope["session:new"], ["t-agent", "t2", "t1"]);
  assert.equal(state.selectionOf("draft:/w"), AUTO_TARGET);
  assert.deepEqual(state.tasksByScope["draft:/w"] ?? [], []);
});

test("adopt merges: the session's explicit selection wins over the draft's", () => {
  reset();
  const store = useExecutionTargetStore.getState();
  store.select("session:new", AUTO_TARGET);
  store.select("draft:/w", "dev_node");
  store.adoptDraft("draft:/w", "session:new");
  const state = useExecutionTargetStore.getState();
  assert.equal(state.selectionOf("session:new"), AUTO_TARGET);
  assert.equal(state.selectionByScope["draft:/w"], undefined);
});

test("rememberTargets caches names and this-device flags by id", () => {
  reset();
  useExecutionTargetStore
    .getState()
    .rememberTargets([
      target({ id: "local", displayName: "This Mac", isThisDevice: true }),
      target({ id: "dev_node", displayName: "Dell" }),
    ]);
  useExecutionTargetStore
    .getState()
    .rememberTargets([target({ id: "dev_node", displayName: "Dell 2" })]);
  assert.deepEqual(useExecutionTargetStore.getState().knownTargets, {
    local: { displayName: "This Mac", isThisDevice: true },
    dev_node: { displayName: "Dell 2", isThisDevice: false },
  });
});

test("resolveSubmissionExecutionTarget maps the Run-on selection to the wire value", () => {
  const known = {
    local: { displayName: "This Mac", isThisDevice: true },
    dev_node: { displayName: "  Dell Runner  ", isThisDevice: false },
    blank: { displayName: "   ", isThisDevice: false },
    long: { displayName: "x".repeat(200), isThisDevice: false },
  };
  assert.deepEqual(resolveSubmissionExecutionTarget(AUTO_TARGET, known), { kind: "automatic" });
  assert.deepEqual(resolveSubmissionExecutionTarget("local", known), { kind: "automatic" });
  assert.deepEqual(resolveSubmissionExecutionTarget("dev_node", known), {
    kind: "target",
    targetId: "dev_node",
    displayName: "Dell Runner",
  });
  assert.deepEqual(resolveSubmissionExecutionTarget("blank", known), {
    kind: "target",
    targetId: "blank",
  });
  assert.deepEqual(resolveSubmissionExecutionTarget("long", known), {
    kind: "target",
    targetId: "long",
    displayName: "x".repeat(120),
  });
  // Unknown ids are still sent truthfully; CLI/Main refuse instead of a silent local run.
  assert.deepEqual(resolveSubmissionExecutionTarget("gone", known), {
    kind: "target",
    targetId: "gone",
  });
  // The wire value always passes the strict shared schema.
  for (const id of [AUTO_TARGET, "local", "dev_node", "blank", "long", "gone"]) {
    assert.equal(
      submissionExecutionTargetSchema.safeParse(resolveSubmissionExecutionTarget(id, known))
        .success,
      true,
    );
  }
});

test("the active scope is only a pointer", () => {
  reset();
  useExecutionTargetStore.getState().noteActiveScope("session:a");
  assert.equal(useExecutionTargetStore.getState().activeScope, "session:a");
});
