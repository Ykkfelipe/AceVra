/**
 * SessionPane send path: `executionTarget` rides only on user-input commands (`sendText`,
 * `createSession` with firstInput), only for local workspaces with a desktop account bridge, and
 * is always `automatic` (no Run-on selection; acevra-agent-computer.md M1).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { withSubmissionExecutionTarget } from "../src/account/submissionExecutionTarget.js";

const automatic = { kind: "automatic" };
const local = { hasAccountBridge: true };

test("sendText always declares automatic", () => {
  assert.deepEqual(withSubmissionExecutionTarget("sendText", { text: "hi" }, local), {
    text: "hi",
    executionTarget: automatic,
  });
});

test("createSession puts it on firstInput only when firstInput exists", () => {
  assert.deepEqual(
    withSubmissionExecutionTarget(
      "createSession",
      { workspaceId: "w", firstInput: { text: "hi" } },
      local,
    ),
    { workspaceId: "w", firstInput: { text: "hi", executionTarget: automatic } },
  );
  const bare = { workspaceId: "w" };
  assert.equal(withSubmissionExecutionTarget("createSession", bare, local), bare);
});

test("other command types are never touched", () => {
  for (const type of ["sendGoalCommand", "createSelectionSideSession", "stopTurn", "editMessage"]) {
    const payload = { text: "hi", firstInput: { text: "hi" } };
    assert.equal(withSubmissionExecutionTarget(type, payload, local), payload);
  }
});

test("remote workspaces and hosts without an account bridge send nothing", () => {
  const payload = { text: "hi" };
  assert.equal(
    withSubmissionExecutionTarget("sendText", payload, {
      ...local,
      workspaceIdentity: "remote:host/w",
    }),
    payload,
  );
  assert.equal(
    withSubmissionExecutionTarget("sendText", payload, { hasAccountBridge: false }),
    payload,
  );
  // Blank identity is a local workspace (same rule as the composer's showExecutionControls).
  assert.deepEqual(
    withSubmissionExecutionTarget("sendText", payload, { ...local, workspaceIdentity: "  " }),
    { text: "hi", executionTarget: automatic },
  );
});

test("a replayed payload keeps its original executionTarget", () => {
  const original = { text: "hi", executionTarget: { kind: "target", targetId: "dev_node" } };
  assert.equal(withSubmissionExecutionTarget("sendText", original, local), original);
  const create = { firstInput: { text: "hi", executionTarget: { kind: "automatic" } } };
  assert.equal(withSubmissionExecutionTarget("createSession", create, local), create);
});
