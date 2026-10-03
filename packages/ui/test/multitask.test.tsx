import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getZCodeToolFamilyForName } from "@zcode/shared";
import { isCreateWorkflowToolCall, isMultitaskToolCall } from "../src/lib/workflowToolNames.js";

register("./uiAssetStubLoader.mjs", import.meta.url);
const { ZCodeIntlProvider } = await import("../src/i18n/IntlProvider.js");
const enUS = (await import("../src/i18n/locales/en-US.js")).default;
const { WorkflowToolSummary } = await import("../src/v4/WorkflowToolSummary.js");

test("Multitask uses Workflow identity and joins while preserving its product name", () => {
  assert.equal(getZCodeToolFamilyForName("Multitask"), "workflow");
  assert.equal(isMultitaskToolCall({ toolName: "Multitask" }), true);
  assert.equal(isCreateWorkflowToolCall({ toolName: "Multitask" }), true);
  assert.equal(isMultitaskToolCall({ toolName: "CreateWorkflow" }), false);
  const summary = { runId: "run-m1", status: "running", agents: 2 } as Parameters<
    typeof WorkflowToolSummary
  >[0]["summary"];
  const markup = renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="en-US" messages={enUS}>
      <WorkflowToolSummary toolCallId="call-m1" summary={summary} multitask onOpen={() => {}} />
    </ZCodeIntlProvider>,
  );
  assert.match(markup, /Multitask/);
  assert.match(markup, /data-workflow-run-id="run-m1"/);
  assert.match(markup, /2/);
  assert.match(markup, /button/);
});

const { buildMultitaskBoard, isMultitaskRun } = await import(
  "../src/components/workflow-timeline/multitask-board-model.js"
);
const { MultitaskWorkerBoard } = await import(
  "../src/components/workflow-timeline/MultitaskWorkerBoard.js"
);

type RunState = Parameters<typeof buildMultitaskBoard>[0];

const evidence = (world: number, mutating = 0, files: string[] = []) => ({
  toolCalls: world + 1,
  worldToolCalls: world,
  mutatingToolCalls: mutating,
  commandCalls: 0,
  filesChanged: files,
  filesChangedTotal: files.length,
});

function report(worker: string, task: string, outcome: string, ev?: object, result = `r-${task}`) {
  return {
    siteId: "report#1",
    ordinal: 1,
    preview: JSON.stringify({ multitaskTask: task, worker, outcome, result, ...(ev ? { evidence: ev } : {}) }),
  };
}

function multitaskRun(overrides: Partial<RunState>): RunState {
  return {
    runId: "run-m2",
    status: "completed",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [
      { siteId: "agent#1", ordinal: 1, name: "explore: Explorer", access: "read", status: "completed" },
      { siteId: "agent#2", ordinal: 1, name: "build: Builder", access: "write", status: "completed" },
    ],
    nodes: [],
    ...overrides,
  } as RunState;
}

test("normal Workflow runs are not Multitask runs", () => {
  assert.equal(isMultitaskRun(multitaskRun({ actors: [{ siteId: "a", ordinal: 1, status: "completed" }] })), false);
  assert.equal(isMultitaskRun(multitaskRun({})), true);
});

test("worker rows use reported outcomes and objective evidence, never turn completion", () => {
  const board = buildMultitaskBoard(
    multitaskRun({
      nodes: [
        { siteId: "ask#1", ordinal: 1, kind: "ask", phase: "settled", outcome: "ok", actorSiteId: "agent#1", actorOrdinal: 1, toolCalls: 3 },
        { siteId: "ask#2", ordinal: 1, kind: "ask", phase: "settled", outcome: "ok", actorSiteId: "agent#2", actorOrdinal: 1, toolCalls: 1 },
      ],
      reports: [
        report("explore", "inspect", "done", evidence(2)),
        // 写 worker 的 turn 正常结束（节点 ok），但证据显示零动作：必须显示为未验证。
        report("build", "edit", "unverified", evidence(0)),
      ],
    }),
  );
  assert.deepEqual(
    board.map((worker) => [worker.workerId, worker.role, worker.access, worker.state]),
    [
      ["explore", "Explorer", "read", "done"],
      ["build", "Builder", "write", "unverified"],
    ],
  );
});

test("live state shows the current action, and stopped runs keep finished work distinct", () => {
  const running = buildMultitaskBoard(
    multitaskRun({
      status: "running",
      nodes: [
        { siteId: "ask#1", ordinal: 1, kind: "ask", phase: "settled", outcome: "ok", actorSiteId: "agent#1", actorOrdinal: 1, cached: true },
        { siteId: "ask#2", ordinal: 1, kind: "ask", phase: "executing", actorSiteId: "agent#2", actorOrdinal: 1, toolCalls: 4, lastTool: { name: "Edit", target: "cart.mjs" } },
      ],
      reports: [report("explore", "inspect", "done", evidence(2))],
    }),
  );
  assert.equal(running[0]!.state, "done");
  assert.equal(running[0]!.reused, true);
  assert.equal(running[1]!.state, "working");
  assert.deepEqual(running[1]!.action, { name: "Edit", target: "cart.mjs" });
  assert.equal(running[1]!.toolCalls, 4);

  const stopped = buildMultitaskBoard(
    multitaskRun({
      status: "stopped",
      stopReason: "user",
      nodes: [
        { siteId: "ask#1", ordinal: 1, kind: "ask", phase: "settled", outcome: "ok", actorSiteId: "agent#1", actorOrdinal: 1 },
        { siteId: "ask#2", ordinal: 1, kind: "ask", phase: "settled", outcome: "cancelled", actorSiteId: "agent#2", actorOrdinal: 1 },
      ],
      reports: [report("explore", "inspect", "done", evidence(2))],
    }),
  );
  assert.deepEqual(stopped.map((worker) => worker.state), ["done", "stopped"]);
});

test("board renders roles, access, outcomes and evidence", () => {
  const markup = renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="en-US" messages={enUS}>
      <MultitaskWorkerBoard
        run={multitaskRun({
          reports: [
            report("explore", "inspect", "done", evidence(2)),
            report("build", "edit", "done", { ...evidence(3, 2, ["/w/cart.mjs"]), commandCalls: 1 }),
          ],
        })}
        onOpenWorker={() => {}}
      />
    </ZCodeIntlProvider>,
  );
  assert.match(markup, /data-testid="multitask-board"/);
  assert.match(markup, /Explorer/);
  assert.match(markup, /Read-only/);
  assert.match(markup, /Writes/);
  assert.match(markup, /data-multitask-state="done"/);
  assert.match(markup, /1 file changed · 1 command run · 4 tool calls/);
  const unverified = renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="en-US" messages={enUS}>
      <MultitaskWorkerBoard run={multitaskRun({ reports: [report("build", "edit", "unverified", evidence(0))] })} />
    </ZCodeIntlProvider>,
  );
  assert.match(unverified, /Unverified/);
  assert.match(unverified, /Claimed done, but no tool use was observed/);
});

test("run read model exposes frozen worker access from the bounded actor persona", async () => {
  const { reduceWorkflowRunsState, workflowRunSchema } = await import(
    "@zcode/shared/zcode-protocol-v4"
  );
  let state = reduceWorkflowRunsState(undefined, {
    runId: "run-access",
    eventType: "actor-created",
    payload: {
      actor: { siteId: "agent#1", ordinal: 1 },
      name: "build: Builder",
      persona: { system: "…", worker: { profile: "general-purpose", access: "write" } },
    },
  });
  state = reduceWorkflowRunsState(state!, {
    runId: "run-access",
    eventType: "actor-created",
    payload: { actor: { siteId: "agent#2", ordinal: 1 }, name: "plain", persona: { system: "x" } },
  });
  const run = state!.runs[0]!;
  assert.equal(run.actors[0]!.access, "write");
  assert.equal("access" in run.actors[1]!, false, "normal Workflow actors carry no access");
  assert.equal(workflowRunSchema.safeParse(run).success, true);
});

test("work carried across Stop/resume is shown as such, not as new or cached work", () => {
  const carried = { ...evidence(12), toolCalls: 13, priorAttempts: { toolCalls: 12, worldToolCalls: 12, mutatingToolCalls: 0, commandCalls: 0 } };
  const board = buildMultitaskBoard(multitaskRun({ reports: [report("explore", "inspect", "done", carried)] }));
  assert.equal(board[0]!.state, "done");
  assert.equal(board[0]!.reused, false, "re-dispatched work is not the cached Reused badge");
  const markup = renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="en-US" messages={enUS}>
      <MultitaskWorkerBoard run={multitaskRun({ reports: [report("explore", "inspect", "done", carried)] })} />
    </ZCodeIntlProvider>,
  );
  assert.match(markup, /13 tool calls \(12 before stop\)/);
});
