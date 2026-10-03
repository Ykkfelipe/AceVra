/**
 * M2 预览会话单测：草稿编辑（经 M1 原语）、准入门控（blocked / confirm）、
 * 确认冻结（规范快照 + warning 记录）与 UI 视图模型。
 *
 * Run: mise exec -- node --import tsx --test packages/shared/test/crossModePreviewSession.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  HandoffFlowError,
  addHandoffContextItem,
  beginHandoffPreview,
  buildHandoffPreviewViewModel,
  canConfirmHandoffPreview,
  confirmHandoffPreview,
  createHandoffContextItem,
  createHandoffPacket,
  editHandoffPreviewDraft,
  parseHandoffPacket,
  setHandoffContextItemIncluded,
  validateHandoffPreview,
  type CreateHandoffPacketInput,
  type HandoffPreviewSession,
} from "../src/index.js";

function baseInput(): CreateHandoffPacketInput {
  return {
    sourceMode: "bot",
    destinationMode: "coding",
    objective: "Build the first Personal Bot settings surface",
    returnPolicy: "summary-and-artifacts",
    sourceRefs: [{ kind: "conversation", id: "bot-conv-1" }],
  };
}

function flowError(code: string) {
  return (error: unknown): boolean => error instanceof HandoffFlowError && error.code === code;
}

function confirmedSession(now = 2500): HandoffPreviewSession {
  const draft = createHandoffPacket(baseInput());
  const result = confirmHandoffPreview(beginHandoffPreview(draft, 1000), now);
  if (!result.ok) {
    throw new Error("fixture packet should be confirmable");
  }
  return result.session;
}

test("beginHandoffPreview starts an unconfirmed draft", () => {
  const draft = createHandoffPacket(baseInput());
  const session = beginHandoffPreview(draft, 1000);
  assert.equal(session.createdAt, 1000);
  assert.equal(session.updatedAt, 1000);
  assert.equal(session.confirmation, null);
  assert.equal(session.draft, draft);
});

test("view model exposes objective, modes, context counts and blockers", () => {
  const draft = createHandoffPacket({
    ...baseInput(),
    context: [
      createHandoffContextItem({
        label: "Idea summary",
        content: "settings surface",
        provenance: [{ kind: "idea", id: "i-1" }],
      }),
      createHandoffContextItem({
        label: "Memory note",
        content: "private",
        sensitivity: "personal",
      }),
    ],
  });
  const viewModel = buildHandoffPreviewViewModel(beginHandoffPreview(draft, 1000));
  assert.equal(viewModel.handoffId, draft.handoffId);
  assert.equal(viewModel.objective, "Build the first Personal Bot settings surface");
  assert.equal(viewModel.sourceMode, "bot");
  assert.equal(viewModel.destinationMode, "coding");
  assert.equal(viewModel.returnPolicy, "summary-and-artifacts");
  assert.equal(viewModel.context.includedCount, 1);
  assert.equal(viewModel.context.excludedCount, 1);
  assert.equal(viewModel.blocked, false);
  assert.deepEqual(viewModel.issues, []);
  assert.equal(viewModel.confirmedAt, null);

  const blockedDraft = createHandoffPacket({
    sourceMode: "bot",
    destinationMode: "coding",
    objective: "blocked objective",
    returnPolicy: "none",
  });
  const blockedViewModel = buildHandoffPreviewViewModel(beginHandoffPreview(blockedDraft, 1000));
  assert.equal(blockedViewModel.blocked, true);
  assert.ok(blockedViewModel.issues.some((issue) => issue.code === "handoff_source_refs_required"));
});

test("edits go through M1 ops and update the session without mutating it", () => {
  const item = createHandoffContextItem({
    label: "note",
    content: "private",
    sensitivity: "personal",
  });
  const session = beginHandoffPreview(
    createHandoffPacket({ ...baseInput(), context: [item] }),
    1000,
  );

  const toggled = editHandoffPreviewDraft(
    session,
    (draft) => setHandoffContextItemIncluded(draft, item.id, true),
    2000,
  );
  assert.equal(toggled.updatedAt, 2000);
  assert.equal(toggled.draft.context[0].included, true);
  assert.equal(toggled.draft.context[0].inclusion, "user");
  assert.equal(session.draft.context[0].included, false);
  assert.equal(session.updatedAt, 1000);

  const added = editHandoffPreviewDraft(
    toggled,
    (draft) => addHandoffContextItem(draft, { label: "extra", content: "more context" }),
    3000,
  );
  assert.equal(added.draft.context.length, 2);
  assert.equal(added.updatedAt, 3000);
});

test("confirm is blocked while the draft fails admission, and reports the issues", () => {
  const blockedDraft = createHandoffPacket({
    sourceMode: "bot",
    destinationMode: "coding",
    objective: "blocked objective",
    returnPolicy: "none",
  });
  const session = beginHandoffPreview(blockedDraft, 1000);
  assert.equal(canConfirmHandoffPreview(session), false);
  assert.ok(
    validateHandoffPreview(session).some((issue) => issue.code === "handoff_source_refs_required"),
  );

  const result = confirmHandoffPreview(session, 2000);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((issue) => issue.code === "handoff_source_refs_required"));
  }
  assert.equal(session.confirmation, null);
});

test("confirm freezes a canonical snapshot and captures warnings", () => {
  const draft = createHandoffPacket({
    ...baseInput(),
    constraints: ["keep scope small", "keep scope small"],
    context: [createHandoffContextItem({ label: "summary", content: "hello" })],
  });
  const session = beginHandoffPreview(draft, 1000);
  assert.equal(canConfirmHandoffPreview(session), true);

  const result = confirmHandoffPreview(session, 2500);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  const confirmation = result.session.confirmation;
  assert.ok(confirmation);
  assert.equal(confirmation.handoffId, draft.handoffId);
  assert.equal(confirmation.confirmedAt, 2500);
  assert.deepEqual(
    confirmation.warnings.map((issue) => issue.code),
    ["handoff_constraint_duplicated"],
  );
  assert.equal(result.session.updatedAt, 2500);

  const parsed = parseHandoffPacket(JSON.parse(confirmation.packetJson));
  assert.deepEqual(parsed, draft);
});

test("confirmed sessions reject further edits and re-confirmation", () => {
  const session = confirmedSession();
  assert.throws(
    () => editHandoffPreviewDraft(session, (draft) => draft, 3000),
    flowError("handoff_flow_preview_confirmed"),
  );
  assert.throws(
    () => confirmHandoffPreview(session, 3000),
    flowError("handoff_flow_preview_confirmed"),
  );
  assert.ok(session.confirmation);
});
