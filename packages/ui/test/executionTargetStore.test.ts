/**
 * Run-on selection and conversation ↔ task attachment (M2E).
 *
 * Pins the ownership rules from `acevra-execution-ux-m2e.md`:
 *  - selection is per execution scope and defaults to Automatic,
 *  - tasks attached to one conversation never leak into another,
 *  - the draft's choice is adopted once by the first session (only into an empty scope).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_TARGET,
  executionScopeKey,
  useExecutionTargetStore,
} from "../src/store/executionTargetStore.js";

const reset = () =>
  useExecutionTargetStore.setState({ selectionByScope: {}, tasksByScope: {}, activeScope: null });

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
  // A session that already has its own choice is never overwritten.
  state.select("draft:/w", "local");
  state.adoptDraft("draft:/w", "session:new");
  state = useExecutionTargetStore.getState();
  assert.equal(state.selectionOf("session:new"), "dev_node");
  assert.equal(state.selectionOf("draft:/w"), "local");
});

test("the active scope is only a pointer", () => {
  reset();
  useExecutionTargetStore.getState().noteActiveScope("session:a");
  assert.equal(useExecutionTargetStore.getState().activeScope, "session:a");
});
