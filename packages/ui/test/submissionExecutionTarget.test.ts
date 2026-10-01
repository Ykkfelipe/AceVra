/**
 * SessionPane send path (M2F): `executionTarget` rides only on user-input commands (`sendText`,
 * `createSession` with firstInput), only for local workspaces with a desktop account bridge.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { SubmissionExecutionTarget } from "@zcode/shared";
import { withSubmissionExecutionTarget } from "../src/account/submissionExecutionTarget.js";

const remote: SubmissionExecutionTarget = {
  kind: "target",
  targetId: "dev_node",
  displayName: "Dell",
};
const local = (resolve: () => SubmissionExecutionTarget = () => remote) => ({
  hasAccountBridge: true,
  resolve,
});

test("sendText carries the resolved executionTarget", () => {
  assert.deepEqual(withSubmissionExecutionTarget("sendText", { text: "hi" }, local()), {
    text: "hi",
    executionTarget: remote,
  });
});

test("createSession puts it on firstInput only when firstInput exists", () => {
  assert.deepEqual(
    withSubmissionExecutionTarget(
      "createSession",
      { workspaceId: "w", firstInput: { text: "hi" } },
      local(),
    ),
    { workspaceId: "w", firstInput: { text: "hi", executionTarget: remote } },
  );
  const bare = { workspaceId: "w" };
  assert.equal(withSubmissionExecutionTarget("createSession", bare, local()), bare);
});

test("other command types are never touched and do not resolve", () => {
  let resolved = 0;
  const context = local(() => {
    resolved += 1;
    return remote;
  });
  for (const type of ["sendGoalCommand", "createSelectionSideSession", "stopTurn", "editMessage"]) {
    const payload = { text: "hi", firstInput: { text: "hi" } };
    assert.equal(withSubmissionExecutionTarget(type, payload, context), payload);
  }
  assert.equal(resolved, 0);
});

test("remote workspaces and hosts without an account bridge send nothing", () => {
  const payload = { text: "hi" };
  assert.equal(
    withSubmissionExecutionTarget("sendText", payload, {
      ...local(),
      workspaceIdentity: "remote:host/w",
    }),
    payload,
  );
  assert.equal(
    withSubmissionExecutionTarget("sendText", payload, { ...local(), hasAccountBridge: false }),
    payload,
  );
  // Blank identity is a local workspace (same rule as the composer's showExecutionControls).
  assert.deepEqual(
    withSubmissionExecutionTarget("sendText", payload, { ...local(), workspaceIdentity: "  " }),
    { text: "hi", executionTarget: remote },
  );
});

test("a replayed payload keeps its original executionTarget", () => {
  const original = { text: "hi", executionTarget: { kind: "automatic" } };
  assert.equal(withSubmissionExecutionTarget("sendText", original, local()), original);
  const create = { firstInput: { text: "hi", executionTarget: { kind: "automatic" } } };
  assert.equal(withSubmissionExecutionTarget("createSession", create, local()), create);
});
