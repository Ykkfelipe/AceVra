/**
 * Agent task attach bridge (M2F). Main's `AgentTaskStarted` push attaches the agent-started task
 * to `session:<sessionId>`; one shared subscription per renderer; malformed notices are dropped.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { IAccountPlatform } from "@zcode/shared";
import { installAgentTaskAttachBridge } from "../src/account/agentTaskAttachBridge.js";
import { useExecutionTargetStore } from "../src/store/executionTargetStore.js";

type Listener = (notice: unknown) => void;

function fakeAccount() {
  const listeners = new Set<Listener>();
  let subscribeCalls = 0;
  const account = {
    onAgentTaskStarted: (callback: Listener) => {
      subscribeCalls += 1;
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  } as unknown as IAccountPlatform;
  return {
    account,
    emit: (notice: unknown) => listeners.forEach((listener) => listener(notice)),
    get listeners() {
      return listeners.size;
    },
    get subscribeCalls() {
      return subscribeCalls;
    },
  };
}

const reset = () =>
  useExecutionTargetStore.setState({
    selectionByScope: {},
    tasksByScope: {},
    activeScope: null,
    knownTargets: {},
  });

test("a notice attaches the task to its session scope, idempotently", () => {
  reset();
  const fake = fakeAccount();
  const dispose = installAgentTaskAttachBridge(fake.account);
  fake.emit({ sessionId: "s1", taskId: "t1", targetId: "dev_node" });
  fake.emit({ sessionId: "s1", taskId: "t1", targetId: "dev_node" });
  fake.emit({ sessionId: "s2", taskId: "t2", targetId: "dev_node" });
  const { tasksByScope } = useExecutionTargetStore.getState();
  assert.deepEqual(tasksByScope["session:s1"], ["t1"]);
  assert.deepEqual(tasksByScope["session:s2"], ["t2"]);
  dispose();
  assert.equal(fake.listeners, 0);
});

test("installing twice keeps a single subscription until the last dispose", () => {
  reset();
  const fake = fakeAccount();
  const first = installAgentTaskAttachBridge(fake.account);
  const second = installAgentTaskAttachBridge(fake.account);
  assert.equal(fake.subscribeCalls, 1);
  assert.equal(fake.listeners, 1);
  first();
  first();
  assert.equal(fake.listeners, 1);
  fake.emit({ sessionId: "s1", taskId: "t1", targetId: "n" });
  assert.deepEqual(useExecutionTargetStore.getState().tasksByScope["session:s1"], ["t1"]);
  second();
  assert.equal(fake.listeners, 0);
});

test("malformed notices are ignored", () => {
  reset();
  const fake = fakeAccount();
  const dispose = installAgentTaskAttachBridge(fake.account);
  for (const notice of [
    null,
    "s1",
    { sessionId: "s1", taskId: "t1" },
    { sessionId: "", taskId: "t1", targetId: "n" },
    { sessionId: "s1", taskId: 7, targetId: "n" },
    { sessionId: "s1", taskId: "t".repeat(129), targetId: "n" },
  ]) {
    fake.emit(notice);
  }
  assert.deepEqual(useExecutionTargetStore.getState().tasksByScope, {});
  dispose();
});

test("no account bridge installs nothing", () => {
  const dispose = installAgentTaskAttachBridge(undefined);
  assert.equal(typeof dispose, "function");
  dispose();
});
