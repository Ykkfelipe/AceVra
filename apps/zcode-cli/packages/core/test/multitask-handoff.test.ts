/**
 * Cross-Mode 采纳/一致性测试（Multitask 侧）：
 * - 冻结契约快照守卫（版本/上限/流程矩阵/问题码，防止本地漂移）；
 * - HandoffPacket → Multitask M1 提交面映射（含 least-context 边界与项目关联）；
 * - 仓库权限 → worker access 的最小授予检查；
 * - Multitask → Coding 返回（completed / partial / returnPolicy 形态）。
 *
 * Run: mise exec -- node --import tsx --test apps/zcode-cli/packages/core/test/multitask-handoff.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MultitaskInputSchema } from "@zcode/contracts";
import {
  HANDOFF_CONTEXT_LIMITS,
  HANDOFF_FLOW_MATRIX,
  HANDOFF_ISSUE_CODES,
  HANDOFF_OBJECT_KINDS,
  HANDOFF_PACKET_CONTRACT_VERSION,
  HANDOFF_RETURN_CONTRACT_VERSION,
  createHandoffContextItem,
  createHandoffPacket,
  handoffReturnMatchesPacket,
  parseHandoffReturnSummary,
  serializeHandoffReturnSummary,
  validateHandoffPacketTransfer,
  type CreateHandoffPacketInput,
  type HandoffPacket,
} from "@zcode/shared/cross-mode";
import {
  MULTITASK_HANDOFF_ISSUE_CODES,
  buildMultitaskHandoffReturn,
  buildMultitaskHandoffSubmission,
  type MultitaskHandoffPlan,
} from "../src/cross-mode/index.js";

function handoffInput(overrides: Partial<CreateHandoffPacketInput> = {}): CreateHandoffPacketInput {
  return {
    sourceMode: "coding",
    destinationMode: "multitask",
    objective: "Split the remaining settings work across bounded workers",
    returnPolicy: "summary-and-artifacts",
    sourceRefs: [{ kind: "coding-session", id: "sess-1" }],
    linkedProject: { kind: "project", id: "acevra" },
    permissions: ["repo-read", "repo-write"],
    constraints: ["do not change the current auth flow"],
    context: [
      createHandoffContextItem({
        label: "Implementation state",
        content: "Settings shell lands; memory caps remain.",
        provenance: [{ kind: "decision", id: "d-1" }],
      }),
      createHandoffContextItem({
        label: "Unrelated personal note",
        content: "Do not carry me.",
        sensitivity: "personal",
      }),
    ],
    ...overrides,
  };
}

function packet(): HandoffPacket {
  return createHandoffPacket(handoffInput());
}

const explorer = { id: "explorer", role: "Explore the runtime", access: "read" as const };
const builder = { id: "builder", role: "Implement the remainder", access: "write" as const };

function plan(overrides: Partial<MultitaskHandoffPlan> = {}): MultitaskHandoffPlan {
  return {
    workers: [explorer, builder],
    tasks: [
      { id: "inspect", worker: "explorer", prompt: "Inspect the settings code paths", dependsOn: [] },
      {
        id: "implement",
        worker: "builder",
        prompt: "Implement the remaining settings work",
        dependsOn: ["inspect"],
      },
    ],
    ...overrides,
  };
}

test("contract snapshot guard: frozen cross-mode contract (b5b4ca1) is intact", () => {
  assert.equal(HANDOFF_PACKET_CONTRACT_VERSION, "handoff-packet/v1");
  assert.equal(HANDOFF_RETURN_CONTRACT_VERSION, "handoff-return/v1");
  assert.deepEqual(HANDOFF_CONTEXT_LIMITS, {
    maxItems: 32,
    maxIncludedItems: 16,
    maxItemBytes: 2048,
    maxIncludedTotalBytes: 8192,
    maxProvenanceRefsPerItem: 8,
    maxLabelChars: 120,
    maxContentChars: 6000,
  });
  assert.deepEqual(HANDOFF_FLOW_MATRIX, {
    bot: ["coding"],
    coding: ["multitask", "bot"],
    multitask: ["coding", "bot"],
  });
  assert.equal(HANDOFF_ISSUE_CODES.length, 18);
  for (const code of [
    "handoff_linked_project_required",
    "handoff_sensitive_auto_included",
    "handoff_repo_write_requires_read",
    "handoff_transition_not_allowed",
  ]) {
    assert.ok(HANDOFF_ISSUE_CODES.includes(code as (typeof HANDOFF_ISSUE_CODES)[number]));
  }
  for (const kind of ["multitask-run", "coding-session", "project"]) {
    assert.ok(HANDOFF_OBJECT_KINDS.includes(kind as (typeof HANDOFF_OBJECT_KINDS)[number]));
  }
  assert.equal(MULTITASK_HANDOFF_ISSUE_CODES.length, 4);
});

test("maps the packet into the Multitask submission surface without redefining it", () => {
  const p = packet();
  const built = buildMultitaskHandoffSubmission(p, plan());
  assert.equal(built.ok, true);
  if (!built.ok) {
    return;
  }
  const { input, handoffId, linkedProject, returnPolicy, sourceRefs } = built.submission;

  assert.equal(handoffId, p.handoffId);
  assert.deepEqual(linkedProject, { kind: "project", id: "acevra" });
  assert.equal(returnPolicy, "summary-and-artifacts");
  assert.deepEqual(sourceRefs, [{ kind: "coding-session", id: "sess-1" }]);

  assert.equal(input.objective, p.objective);
  assert.equal(input.name, `Handoff: ${p.objective}`);
  assert.equal(input.workers.length, 2);
  assert.equal(input.tasks.length, 2);

  const sharedContext = input.sharedContext ?? "";
  assert.ok(sharedContext.includes(`Cross-mode handoff ${p.handoffId} (coding → multitask)`));
  assert.ok(sharedContext.includes("Source refs: coding-session:sess-1"));
  assert.ok(sharedContext.includes("Linked project: project:acevra"));
  assert.ok(sharedContext.includes("Context to carry:"));
  assert.ok(sharedContext.includes("- Implementation state: Settings shell lands; memory caps remain."));
  assert.ok(sharedContext.includes("Constraints:"));
  assert.ok(sharedContext.includes("- do not change the current auth flow"));

  // least-context 边界：被排除的 personal 项绝不进入运行上下文
  assert.ok(!sharedContext.includes("Unrelated personal note"));
  assert.ok(!sharedContext.includes("Do not carry me."));

  // 合成输入必须原样通过 M1 提交面 schema
  const reparsed = MultitaskInputSchema.parse(input);
  assert.equal(reparsed.objective, p.objective);

  // 运行名可由计划显式覆盖
  const renamed = buildMultitaskHandoffSubmission(p, plan({ name: "Settings split" }));
  assert.equal(renamed.ok, true);
  if (renamed.ok) {
    assert.equal(renamed.submission.input.name, "Settings split");
  }
});

test("rejects packets that are not coding → multitask", () => {
  const botPacket = createHandoffPacket({
    sourceMode: "bot",
    destinationMode: "coding",
    objective: "Something else entirely",
    returnPolicy: "none",
    sourceRefs: [{ kind: "conversation", id: "c-1" }],
  });
  const built = buildMultitaskHandoffSubmission(botPacket, plan());
  assert.equal(built.ok, false);
  if (built.ok) {
    return;
  }
  assert.equal(built.issues[0].code, "multitask_handoff_wrong_flow");
});

test("required project linkage is enforced by the frozen contract", () => {
  const noProject = createHandoffPacket(handoffInput({ linkedProject: null }));
  const built = buildMultitaskHandoffSubmission(noProject, plan());
  assert.equal(built.ok, false);
  if (built.ok) {
    return;
  }
  const issue = built.issues[0];
  assert.equal(issue.code, "multitask_handoff_not_transferable");
  assert.ok(issue.packetIssues?.some((entry) => entry.code === "handoff_linked_project_required"));
  assert.ok(
    validateHandoffPacketTransfer(noProject).some(
      (entry) => entry.code === "handoff_linked_project_required",
    ),
  );
});

test("repo permissions gate worker access (least grant)", () => {
  const readOnlyPlan = plan({
    workers: [explorer],
    tasks: [{ id: "inspect", worker: "explorer", prompt: "Inspect", dependsOn: [] }],
  });

  // reader 没有 repo-read → 拒绝
  const noGrants = createHandoffPacket(handoffInput({ permissions: [] }));
  const deniedRead = buildMultitaskHandoffSubmission(noGrants, readOnlyPlan);
  assert.equal(deniedRead.ok, false);
  if (!deniedRead.ok) {
    assert.equal(deniedRead.issues[0].code, "multitask_handoff_permission_denied");
  }

  // reader + repo-read → 通过
  const readerGranted = createHandoffPacket(handoffInput({ permissions: ["repo-read"] }));
  const readerBuilt = buildMultitaskHandoffSubmission(readerGranted, readOnlyPlan);
  assert.equal(readerBuilt.ok, true);

  // writer 只有 repo-read（无 repo-write）→ 拒绝
  const writeDenied = buildMultitaskHandoffSubmission(readerGranted, plan());
  assert.equal(writeDenied.ok, false);
  if (!writeDenied.ok) {
    assert.equal(writeDenied.issues[0].code, "multitask_handoff_permission_denied");
    assert.equal(writeDenied.issues[0].path, "workers[1].access");
  }

  // writer + repo-read + repo-write → 通过
  const writeGranted = buildMultitaskHandoffSubmission(packet(), plan());
  assert.equal(writeGranted.ok, true);
});

test("builds a completed HandoffReturnSummary for Multitask → Coding", () => {
  const p = packet();
  const summary = buildMultitaskHandoffReturn(p, {
    status: "completed",
    summary: "Settings surface split completed and verified.",
    changes: [{ text: "Added the settings panel", refs: [{ kind: "multitask-run", id: "run-7" }] }],
    verification: [{ text: "core test suite", outcome: "passed" }],
    artifacts: [{ kind: "artifact", id: "a-1" }],
  });
  assert.ok(summary);
  assert.equal(summary.handoffId, p.handoffId);
  assert.equal(summary.status, "completed");
  assert.equal(summary.changes.length, 1);
  assert.equal(summary.verification.length, 1);
  assert.deepEqual(summary.artifacts, [{ kind: "artifact", id: "a-1" }]);

  const reparsed = parseHandoffReturnSummary(JSON.parse(serializeHandoffReturnSummary(summary)));
  assert.ok(handoffReturnMatchesPacket(reparsed, p));
});

test("carries partial status honestly (never upgraded to completed)", () => {
  const p = packet();
  const summary = buildMultitaskHandoffReturn(p, {
    status: "partial",
    summary: "Explorer pass finished; builder work remains unverified.",
    changes: [{ text: "Runtime inspection completed" }],
    unresolved: [{ text: "Implementation not finished: two tasks remain" }],
  });
  assert.ok(summary);
  assert.equal(summary.status, "partial");
  assert.equal(summary.unresolved.length, 1);
  const reparsed = parseHandoffReturnSummary(JSON.parse(serializeHandoffReturnSummary(summary)));
  assert.equal(reparsed.status, "partial");
  assert.ok(handoffReturnMatchesPacket(reparsed, p));
});

test("returnPolicy governs the return shape", () => {
  const summaryOnly = createHandoffPacket(handoffInput({ returnPolicy: "summary" }));
  const withArtifacts = buildMultitaskHandoffReturn(summaryOnly, {
    status: "completed",
    summary: "done",
    artifacts: [{ kind: "artifact", id: "a-9" }],
  });
  assert.ok(withArtifacts);
  assert.deepEqual(withArtifacts.artifacts, []);

  const nonePolicy = createHandoffPacket(handoffInput({ returnPolicy: "none" }));
  assert.equal(
    buildMultitaskHandoffReturn(nonePolicy, { status: "failed", summary: "no automatic return" }),
    null,
  );
});

test("executor smoke: admission pre-check → submission → run ref → return", () => {
  const p = packet();

  // 1) 执行器派发前的准入前置（冻结契约校验）
  assert.deepEqual(validateHandoffPacketTransfer(p), []);

  // 2) 映射为 Multitask 提交
  const built = buildMultitaskHandoffSubmission(p, plan());
  assert.equal(built.ok, true);
  if (!built.ok) {
    return;
  }

  // 3) 运行被接受 → 外部引用（multitask-run）是返回侧的稳定回链约定
  const externalRef = { kind: "multitask-run", id: "run-42" } as const;

  // 4) 完成/部分完成后构造返回摘要
  const returned = buildMultitaskHandoffReturn(p, {
    status: "completed",
    summary: "All planned tasks completed.",
    changes: [{ text: "Completed the planned split", refs: [externalRef] }],
  });
  assert.ok(returned);
  assert.ok(handoffReturnMatchesPacket(returned, p));
});
