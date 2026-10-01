/**
 * Conversation ↔ computer work attachment (acevra-agent-computer.md, M1).
 *
 *  - there is no per-conversation computer selection in the renderer (no Run-on control),
 *  - tasks attached to one conversation never leak into another,
 *  - the draft's tasks merge into the first session once (unioned — an agent task may be
 *    attached before adopt),
 *  - every user turn declares `automatic` on the wire (strict shared schema).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { submissionExecutionTargetSchema } from "@zcode/shared";
import {
  AUTOMATIC_SUBMISSION_TARGET,
  executionScopeKey,
  useExecutionTargetStore,
} from "../src/store/executionTargetStore.js";

const reset = () => useExecutionTargetStore.setState({ tasksByScope: {}, activeScope: null });

test("scope keys separate draft and session and prefer workspace identity", () => {
  assert.equal(executionScopeKey({ workspacePath: "/w" }, null), "draft:/w");
  assert.equal(
    executionScopeKey({ workspacePath: "/w", workspaceIdentity: " remote:x " }, null),
    "draft:remote:x",
  );
  assert.equal(executionScopeKey({ workspacePath: "/w" }, "s1"), "session:s1");
});

test("the store holds no computer selection", () => {
  reset();
  const state = useExecutionTargetStore.getState() as unknown as Record<string, unknown>;
  for (const removed of ["selectionByScope", "select", "selectionOf", "knownTargets"]) {
    assert.equal(removed in state, false, `${removed} must not exist`);
  }
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

test("first send adopts the draft's tasks once and clears the draft", () => {
  reset();
  const store = useExecutionTargetStore.getState();
  store.attachTask("draft:/w", "t1");
  store.adoptDraft("draft:/w", "session:new");
  const state = useExecutionTargetStore.getState();
  assert.deepEqual(state.tasksByScope["session:new"], ["t1"]);
  assert.deepEqual(state.tasksByScope["draft:/w"] ?? [], []);
  // Idempotent: adopting an already-cleared draft changes nothing.
  const before = useExecutionTargetStore.getState();
  before.adoptDraft("draft:/w", "session:new");
  assert.equal(useExecutionTargetStore.getState(), before);
});

test("adopt merges: an agent task attached to the session before adopt is kept", () => {
  reset();
  const store = useExecutionTargetStore.getState();
  store.attachTask("draft:/w", "t1");
  store.attachTask("draft:/w", "t2");
  // Main's AgentTaskStarted push can land on the session before the composer adopts.
  store.attachTask("session:new", "t-agent");
  store.attachTask("session:new", "t2");
  store.adoptDraft("draft:/w", "session:new");
  const state = useExecutionTargetStore.getState();
  assert.deepEqual(state.tasksByScope["session:new"], ["t-agent", "t2", "t1"]);
  assert.deepEqual(state.tasksByScope["draft:/w"] ?? [], []);
});

test("user turns always declare automatic and pass the strict shared schema", () => {
  assert.deepEqual(AUTOMATIC_SUBMISSION_TARGET, { kind: "automatic" });
  assert.equal(
    submissionExecutionTargetSchema.safeParse(AUTOMATIC_SUBMISSION_TARGET).success,
    true,
  );
});

test("the active scope is only a pointer", () => {
  reset();
  useExecutionTargetStore.getState().noteActiveScope("session:a");
  assert.equal(useExecutionTargetStore.getState().activeScope, "session:a");
});
