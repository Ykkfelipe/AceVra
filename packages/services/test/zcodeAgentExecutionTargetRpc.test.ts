import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionTargetExecutor, ZCodeExecutionTargetParams } from "@zcode/shared";
import { handleExecutionTargetRequest } from "../src/zcode-agent/zcodeAgentExecutionTargetRpc.js";

function harness() {
  const responses: unknown[] = [];
  const errors: Array<{ code: number }> = [];
  let resolveNext: (() => void) | undefined;
  const settled = () => new Promise<void>((resolve) => (resolveNext = resolve));
  const client = {
    respond: async (_id: unknown, result: unknown) => {
      responses.push(result);
      resolveNext?.();
    },
    respondError: async (_id: unknown, error: { code: number }) => {
      errors.push(error);
      resolveNext?.();
    },
  };
  return { client, responses, errors, settled };
}

const LIST: ZCodeExecutionTargetParams = {
  op: "list",
  requestId: "r1",
  sessionId: "s1",
  workspacePath: "/work/app",
};

test("forwards a valid request for the agent's local workspace to the executor", async () => {
  const seen: ZCodeExecutionTargetParams[] = [];
  const executor: ExecutionTargetExecutor = {
    execute: async (request) => (seen.push(request), { op: "list", ok: true, targets: [] }),
  };
  const h = harness();
  const done = h.settled();
  handleExecutionTargetRequest({
    client: h.client,
    executor,
    requestId: 1,
    params: LIST,
    workspace: { workspacePath: "/work/app" },
  });
  await done;
  assert.deepEqual(seen, [LIST]);
  assert.deepEqual(h.responses, [{ op: "list", ok: true, targets: [] }]);
});

test("no executor, a remote workspace or a foreign workspace path never reach the executor", async () => {
  let calls = 0;
  const executor: ExecutionTargetExecutor = {
    execute: async () => (calls++, { op: "list", ok: true, targets: [] }),
  };
  for (const [exec, workspace, expected] of [
    [undefined, { workspacePath: "/work/app" }, "unavailable"],
    [executor, { workspacePath: "/work/app", workspaceIdentity: "remote:ssh:h:/x" }, "unavailable"],
    [executor, { workspacePath: "/other" }, "invalid_request"],
  ] as const) {
    const h = harness();
    const done = h.settled();
    handleExecutionTargetRequest({
      client: h.client,
      executor: exec,
      requestId: 1,
      params: LIST,
      workspace,
    });
    await done;
    assert.equal((h.responses[0] as { reason: string }).reason, expected);
  }
  assert.equal(calls, 0);
});

test("invalid params are a -32602 error and executor throws become a structured internal result", async () => {
  const bad = harness();
  const badDone = bad.settled();
  handleExecutionTargetRequest({
    client: bad.client,
    executor: undefined,
    requestId: 1,
    params: { ...LIST, op: "start", targetId: "n1", process: { executable: "", cwd: "/" } },
    workspace: { workspacePath: "/work/app" },
  });
  await badDone;
  assert.equal(bad.errors[0]?.code, -32602);

  const h = harness();
  const done = h.settled();
  handleExecutionTargetRequest({
    client: h.client,
    executor: {
      execute: () => {
        throw new Error("sync boom");
      },
    },
    requestId: 2,
    params: LIST,
    workspace: { workspacePath: "/work/app" },
  });
  await done;
  assert.deepEqual(h.responses, [{ op: "list", ok: false, reason: "internal" }]);
});
