/**
 * 生产 handoff executor 单测：run 终态→返回状态映射表、run 产物提取、服务输入校验、
 * 执行端口（绑定 / 适配器拒绝 / 忙拒绝 / 成功与失败映射）与命令 handler 的拒绝语义。
 *
 * Run: mise exec -- node --import tsx --test apps/zcode-cli/packages/bootstrap/test/cross-mode-handoff.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandoffPacket } from "@zcode/shared/cross-mode";
import {
  buildMultitaskHandoffReturnFromRun,
  createCrossModeMultitaskHandoffService,
  readMultitaskRunTasks,
} from "../src/app/cross-mode-handoff-service.js";
import {
  MultitaskHandoffSessionBusyError,
  createMultitaskHandoffExecutionPort,
  formatMultitaskStartFailure,
} from "../src/app/cross-mode-handoff-executor.js";
import { crossModeHandoffHandlers } from "../src/zcode-protocol-v4/commands/handlers/cross-mode-handoff.js";

function packet(overrides: Record<string, unknown> = {}) {
  return createHandoffPacket({
    sourceMode: "coding",
    destinationMode: "multitask",
    objective: "Split the settings work",
    returnPolicy: "summary-and-artifacts",
    sourceRefs: [{ kind: "coding-session", id: "sess-1" }],
    linkedProject: { kind: "project", id: "acevra" },
    permissions: ["repo-read", "repo-write"],
    ...overrides,
  } as never);
}

const okPlan = {
  workers: [{ id: "w", role: "Worker", access: "write" as const }],
  tasks: [{ id: "t", worker: "w", prompt: "Do it", dependsOn: [] }],
};

const unusedHost = {
  scheduleTools: async (): Promise<never> => {
    throw new Error("unused");
  },
  executeTools: async (): Promise<never> => {
    throw new Error("unused");
  },
};

test("run outcome mapping: completed / partial / cancelled / failed / none", () => {
  const base = packet();
  const done = {
    a: { task: "a", outcome: "done" },
    b: { task: "b", outcome: "done" },
  };
  assert.equal(
    buildMultitaskHandoffReturnFromRun(base, { runId: "r1", runStatus: "completed", tasks: done })
      ?.status,
    "completed",
  );

  const mixed = {
    a: { task: "a", outcome: "done" },
    b: { task: "b", outcome: "blocked" },
  };
  const partial = buildMultitaskHandoffReturnFromRun(base, {
    runId: "r1",
    runStatus: "completed",
    tasks: mixed,
  });
  assert.equal(partial?.status, "partial");
  assert.deepEqual(
    partial?.unresolved.map((note) => note.text),
    ["b: blocked"],
  );
  assert.deepEqual(partial?.artifacts, [{ kind: "multitask-run", id: "r1" }]);

  assert.equal(
    buildMultitaskHandoffReturnFromRun(base, { runId: "r1", runStatus: "stopped", tasks: {} })
      ?.status,
    "cancelled",
  );
  assert.equal(
    buildMultitaskHandoffReturnFromRun(base, { runId: "r1", runStatus: "failed", tasks: {} })
      ?.status,
    "failed",
  );
  assert.equal(
    buildMultitaskHandoffReturnFromRun(packet({ returnPolicy: "none" }), {
      runId: "r1",
      runStatus: "completed",
      tasks: done,
    }),
    null,
  );
});

test("readMultitaskRunTasks extracts report entries and ignores junk", () => {
  assert.deepEqual(
    readMultitaskRunTasks({
      t1: { task: "a", outcome: "done", evidence: {} },
      t2: { nope: 1 },
      t3: "x",
      t4: null,
    }),
    { t1: { task: "a", outcome: "done" } },
  );
  assert.deepEqual(readMultitaskRunTasks(undefined), {});
});

test("service rejects invalid input before any submission (invalid_input)", async () => {
  const service = createCrossModeMultitaskHandoffService({ host: unusedHost });

  const badObjective = await service.start({ sessionId: "s1", objective: "", plan: okPlan });
  assert.equal(badObjective.ok, false);
  if (!badObjective.ok) {
    assert.equal(badObjective.reason, "invalid_input");
  }

  // coding → multitask 必须有 linkedProject：冻结准入校验在确认闸门前拒绝。
  const missingProject = await service.start({
    sessionId: "s1",
    objective: "Do the thing",
    plan: okPlan,
  });
  assert.equal(missingProject.ok, false);
  if (!missingProject.ok) {
    assert.match(missingProject.message, /linkedProject/);
  }
});

test("execution port: binding / adapter failure / busy / success mapping", async () => {
  // 绑定缺席（未经 initiation 直接执行）→ rejected。
  const missing = await createMultitaskHandoffExecutionPort({
    host: unusedHost,
    getBinding: () => undefined,
    releaseBinding: () => {},
  }).execute({ packet: packet(), confirmedAt: 1 });
  assert.deepEqual(missing, { status: "rejected", reason: "multitask_handoff_binding_missing" });

  // 适配器权限闸门拒绝：不触碰宿主执行器。
  let hostCalls = 0;
  const countingHost = {
    scheduleTools: async (): Promise<never> => {
      hostCalls += 1;
      throw new Error("unused");
    },
    executeTools: async (): Promise<never> => {
      hostCalls += 1;
      throw new Error("unused");
    },
  };
  const denied = await createMultitaskHandoffExecutionPort({
    host: countingHost,
    getBinding: () => ({ plan: okPlan }),
    releaseBinding: () => {},
  }).execute({ packet: packet({ permissions: ["repo-read"] }), confirmedAt: 1 });
  assert.deepEqual(denied, { status: "rejected", reason: "multitask_handoff_permission_denied" });
  assert.equal(hostCalls, 0);

  // 成功：externalRef = {kind:"multitask-run"}，绑定在成功后释放。
  let released = 0;
  const accepted = await createMultitaskHandoffExecutionPort({
    host: {
      scheduleTools: async (calls) =>
        ({
          items: [],
          parallelGroups: [calls.map((call) => call.id)],
          executionOrder: calls.map((call) => call.id),
        }) as never,
      executeTools: async () =>
        ({
          results: [
            { toolCallId: "handoff-x", success: true, output: { backgroundTaskId: "run-9" } },
          ],
          events: [],
        }) as never,
    },
    getBinding: () => ({ plan: okPlan }),
    releaseBinding: () => {
      released += 1;
    },
  }).execute({ packet: packet(), confirmedAt: 1 });
  assert.deepEqual(accepted, {
    status: "accepted",
    externalRef: { kind: "multitask-run", id: "run-9" },
    displayName: "Handoff: Split the settings work",
  });
  assert.equal(released, 1);

  // 失败：可展示短原因，绑定保留（可重试）。
  let releasedOnFailure = 0;
  const failed = await createMultitaskHandoffExecutionPort({
    host: {
      scheduleTools: async (calls) =>
        ({
          items: [],
          parallelGroups: [calls.map((call) => call.id)],
          executionOrder: calls.map((call) => call.id),
        }) as never,
      executeTools: async () =>
        ({
          results: [
            {
              toolCallId: "handoff-x",
              success: false,
              error: { code: "PERMISSION_DENIED", message: "Run this Multitask plan? denied" },
            },
          ],
          events: [],
        }) as never,
    },
    getBinding: () => ({ plan: okPlan }),
    releaseBinding: () => {
      releasedOnFailure += 1;
    },
  }).execute({ packet: packet(), confirmedAt: 1 });
  assert.deepEqual(failed, {
    status: "rejected",
    reason: "Multitask did not start: PERMISSION_DENIED: Run this Multitask plan? denied",
  });
  assert.equal(releasedOnFailure, 0);

  // 会话忙：宿主在提交处抛忙错 → 归一为 rejected 原因（schedule 与实际提交分开：忙检查在提交步）。
  const busy = await createMultitaskHandoffExecutionPort({
    host: {
      scheduleTools: async (calls) =>
        ({
          items: [],
          parallelGroups: [calls.map((call) => call.id)],
          executionOrder: calls.map((call) => call.id),
        }) as never,
      executeTools: async (): Promise<never> => {
        throw new MultitaskHandoffSessionBusyError();
      },
    },
    getBinding: () => ({ plan: okPlan }),
    releaseBinding: () => {},
  }).execute({ packet: packet(), confirmedAt: 1 });
  assert.equal(busy.status, "rejected");
  assert.match((busy as { reason: string }).reason, /^session_busy: /);
});

test("formatMultitaskStartFailure keeps a displayable bounded reason", () => {
  const reason = formatMultitaskStartFailure({ code: "TOOL_NOT_FOUND", message: "y".repeat(500) });
  assert.match(reason, /^Multitask did not start: TOOL_NOT_FOUND: /);
  assert.ok(reason.length <= 200);
});

test("command handler maps capability / rejection / accepted result", async () => {
  const envelope = {
    commandId: "c1",
    clientId: "t",
    sessionId: "s1",
    type: "startMultitaskHandoff",
    payload: { objective: "x", plan: okPlan },
    issuedAt: "2026-10-03T00:00:00.000Z",
  } as never;

  // 能力缺席：宿主 App 未接方法 → V4CapabilityUnsupportedError。
  await assert.rejects(
    crossModeHandoffHandlers.startMultitaskHandoff(
      { getRecord: () => ({ app: { sessionId: "s1" } }) } as never,
      envelope,
    ),
    (error: unknown) => error instanceof Error && error.name === "V4CapabilityUnsupportedError",
  );

  // 业务拒绝：invalid_input → fault reasonCode。
  await assert.rejects(
    crossModeHandoffHandlers.startMultitaskHandoff(
      {
        getRecord: () => ({
          app: {
            sessionId: "s1",
            startMultitaskHandoff: async () => ({
              ok: false,
              reason: "invalid_input",
              message: "bad objective",
            }),
          },
        }),
      } as never,
      envelope,
    ),
    (error: unknown) =>
      (error as { reasonCode?: string }).reasonCode ===
      "fault.command.multitaskHandoffStartRejected.invalid_input",
  );

  // 成功：结果原样映射（含 externalRef 回链）。
  const result = await crossModeHandoffHandlers.startMultitaskHandoff(
    {
      getRecord: () => ({
        app: {
          sessionId: "s1",
          startMultitaskHandoff: async () => ({
            ok: true,
            handoffId: "h1",
            status: "accepted",
            externalRef: { kind: "multitask-run", id: "run-1" },
            reason: null,
          }),
        },
      }),
    } as never,
    envelope,
  );
  assert.deepEqual(result, {
    type: "startMultitaskHandoff",
    handoffId: "h1",
    status: "accepted",
    externalRef: { kind: "multitask-run", id: "run-1" },
    reason: null,
  });
});
