/**
 * M2F：执行工具路由到 Run-on 目标（packages/desktop/specs/acevra-agent-execution-m2f.md）。
 *
 * Run: mise exec -- node --import tsx --test apps/zcode-cli/packages/core/test/execution-target-tools.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExecutionTargetPort,
  ExecutionTaskEventRecord,
  ExecutionTaskSnapshot,
  SelectedExecutionTarget,
} from "@zcode/contracts";
import {
  assertBashRunsOnThisMac,
  executionTargetsToolEntry,
  runOnTargetToolEntry,
  targetTaskToolEntry,
} from "../src/tool/handlers/execution-target.js";
import { formatExecutionTargetUserInput } from "../src/runtime/helpers/execution-target-context.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";

const DELL: SelectedExecutionTarget = { targetId: "node-1", displayName: "Dell" };

function snapshot(
  state: ExecutionTaskSnapshot["state"],
  extra: Partial<ExecutionTaskSnapshot> = {},
) {
  return {
    id: "task-1",
    targetId: "node-1",
    state,
    result: null,
    lastSequence: 0,
    ...extra,
  } satisfies ExecutionTaskSnapshot;
}

function outputEvent(sequence: number, text: string): ExecutionTaskEventRecord {
  return {
    sequence,
    type: "process.output",
    payload: { stream: "stdout", text, bytes: text.length },
  } as unknown as ExecutionTaskEventRecord;
}

type FakeOptions = {
  selected?: SelectedExecutionTarget;
  startResult?: Awaited<ReturnType<ExecutionTargetPort["startProcess"]>>;
  reads?: Array<{
    state: ExecutionTaskSnapshot["state"];
    events?: ExecutionTaskEventRecord[];
    result?: object;
  }>;
};

function fakePort(options: FakeOptions = {}) {
  const calls = { start: [] as unknown[], cancel: [] as string[], read: 0 };
  let readIndex = 0;
  const port: ExecutionTargetPort = {
    selectedTarget: () => options.selected,
    listTargets: async () =>
      ({
        ok: true,
        targets: [
          {
            id: "local-mac",
            displayName: "This Mac",
            type: "local",
            isThisDevice: true,
            online: true,
            available: true,
            capabilities: ["shell"],
          },
          {
            id: "node-1",
            displayName: "Dell",
            type: "node",
            isThisDevice: false,
            online: true,
            available: true,
            capabilities: ["shell"],
          },
        ],
      }) as never,
    startProcess: async (input) => {
      calls.start.push(input);
      return options.startResult ?? ({ ok: true, taskId: "task-1", targetId: "node-1" } as never);
    },
    readTask: async () => {
      calls.read += 1;
      const reads = options.reads ?? [{ state: "completed" }];
      const step = reads[Math.min(readIndex, reads.length - 1)]!;
      readIndex += 1;
      return {
        ok: true,
        task: snapshot(step.state, step.result ? ({ result: step.result } as never) : {}),
        events: step.events ?? [],
      } as never;
    },
    cancelTask: async ({ taskId }) => {
      calls.cancel.push(taskId);
      return { ok: true, task: snapshot("cancelling") } as never;
    },
  };
  return { port, calls };
}

function context(port: ExecutionTargetPort | undefined, signal = new AbortController().signal) {
  return {
    toolCallId: "call-1",
    turnId: "turn-1",
    abortSignal: signal,
    executionTargetPort: port,
  } as never;
}

test("RunOnTarget 完成：返回退出码与输出尾部，cwd/参数原样交给端口", async () => {
  const { port, calls } = fakePort({
    reads: [
      {
        state: "completed",
        events: [outputEvent(1, "hello from dell\n")],
        result: { exitCode: 0 },
      },
    ],
  });
  const result = (await runOnTargetToolEntry.handler(
    { targetId: "node-1", executable: "uname", args: ["-a"], cwd: "/home/me/work" },
    context(port),
  )) as { finished: boolean; output: string; exitCode?: number; state: string };
  assert.equal(result.finished, true);
  assert.equal(result.state, "completed");
  assert.match(result.output, /hello from dell/);
  assert.deepEqual(calls.start[0], {
    targetId: "node-1",
    process: { executable: "uname", args: ["-a"], cwd: "/home/me/work" },
  });
});

test("RunOnTarget 等待用尽：返回仍在运行的句柄，不取消", async () => {
  const { port, calls } = fakePort({ reads: [{ state: "running" }] });
  const result = (await runOnTargetToolEntry.handler(
    { targetId: "node-1", executable: "sleep", args: ["600"], cwd: "/tmp", waitSeconds: 0 },
    context(port),
  )) as { finished: boolean; taskId: string; state: string };
  assert.equal(result.finished, false);
  assert.equal(result.taskId, "task-1");
  assert.equal(result.state, "running");
  assert.deepEqual(calls.cancel, []);
});

test("agent 中止：取消节点任务一次并抛出", async () => {
  const controller = new AbortController();
  const { port, calls } = fakePort({ reads: [{ state: "running" }] });
  const pending = runOnTargetToolEntry.handler(
    { targetId: "node-1", executable: "sleep", args: ["600"], cwd: "/tmp", waitSeconds: 30 },
    context(port, controller.signal),
  );
  setTimeout(() => controller.abort(new Error("turn aborted")), 50);
  await assert.rejects(pending, /turn aborted/);
  assert.deepEqual(calls.cancel, ["task-1"]);
});

test("离线目标如实失败，且说明没有在本机执行", async () => {
  const { port } = fakePort({
    startResult: { ok: false, reason: "target_unavailable", detail: "target_offline" } as never,
  });
  await assert.rejects(
    runOnTargetToolEntry.handler(
      { targetId: "node-1", executable: "ls", cwd: "/tmp" },
      context(port),
    ),
    /Nothing was run on this Mac/,
  );
});

test("本机不是合法远程目标（target_is_local）", async () => {
  const { port } = fakePort({ startResult: { ok: false, reason: "target_is_local" } as never });
  await assert.rejects(
    runOnTargetToolEntry.handler(
      { targetId: "local-mac", executable: "ls", cwd: "/tmp" },
      context(port),
    ),
    /Bash/,
  );
});

test("节点断线：running_unknown 如实返回，不当作完成", async () => {
  const { port } = fakePort({ reads: [{ state: "running_unknown" }] });
  const result = (await targetTaskToolEntry.handler(
    { taskId: "task-1", action: "wait", waitSeconds: 0 },
    context(port),
  )) as { finished: boolean; state: string; message: string };
  assert.equal(result.finished, false);
  assert.equal(result.state, "running_unknown");
  assert.match(result.message, /connection|reconnect/i);
});

test("TargetTask stop：发出取消并等待终态", async () => {
  const { port, calls } = fakePort({ reads: [{ state: "cancelled" }] });
  const result = (await targetTaskToolEntry.handler(
    { taskId: "task-1", action: "stop" },
    context(port),
  )) as { state: string; finished: boolean };
  assert.deepEqual(calls.cancel, ["task-1"]);
  assert.equal(result.state, "cancelled");
  assert.equal(result.finished, true);
});

test("ExecutionTargets 列出 id/名称/状态/能力并标记当前选择", async () => {
  const { port } = fakePort({ selected: DELL });
  const result = (await executionTargetsToolEntry.handler({}, context(port))) as {
    selectedTargetId: string | null;
    targets: Array<{ id: string; displayName: string; selected: boolean; kind: string }>;
  };
  assert.equal(result.selectedTargetId, "node-1");
  const dell = result.targets.find((t) => t.displayName === "Dell");
  assert.equal(dell?.selected, true);
  assert.equal(result.targets.find((t) => t.kind === "thisDevice")?.selected, false);
});

test("Bash：选中远程节点时拒绝；Automatic/无端口时照常", () => {
  assert.throws(
    () => assertBashRunsOnThisMac(context(fakePort({ selected: DELL }).port)),
    /Bash is disabled.*Nothing was run on this Mac/s,
  );
  assert.doesNotThrow(() => assertBashRunsOnThisMac(context(fakePort().port)));
  assert.doesNotThrow(() => assertBashRunsOnThisMac(context(undefined)));
});

test("工具注册：仅在 includeExecutionTargets 时出现", () => {
  const names = (opts: { includeExecutionTargets?: boolean } = {}) => {
    const registered: string[] = [];
    registerBuiltInTools({ register: (entry) => registered.push(entry.metadata.name) }, opts);
    return registered;
  };
  assert.equal(names().includes("RunOnTarget"), false);
  const included = names({ includeExecutionTargets: true });
  for (const name of ["ExecutionTargets", "RunOnTarget", "TargetTask"]) {
    assert.ok(included.includes(name), name);
  }
});

test("上下文块：选中节点时前置说明，未选中时原样", () => {
  assert.equal(formatExecutionTargetUserInput("hi", "hi", undefined), "hi");
  const text = formatExecutionTargetUserInput("hi", "hi", DELL);
  assert.match(text, /<execution-target-context source="run-on-selection">/);
  assert.match(text, /"Dell" \(id node-1\)/);
  assert.match(text, /## My request for ZCode:\nhi$/);
});
