/**
 * Cross-Mode 上下文选择 / 预览 / 编辑原语的单测：
 * 默认选择策略、UTF-8 字节预算、预览数据面、编辑操作的不可变性与错误码。
 *
 * Run: mise exec -- node --import tsx --test packages/shared/test/crossModeContextSelection.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  HandoffContractError,
  addHandoffContextItem,
  buildHandoffContextPreview,
  collectHandoffContextLimitViolations,
  createHandoffContextItem,
  createHandoffPacket,
  deserializeHandoffPacket,
  removeHandoffContextItem,
  resolveDefaultContextSelection,
  serializeHandoffPacket,
  setHandoffContextItemIncluded,
  updateHandoffContextItemContent,
  validateHandoffPacketTransfer,
  type HandoffContextItem,
  type HandoffPacket,
} from "../src/index.js";

function handoffError(code: string) {
  return (error: unknown): boolean => error instanceof HandoffContractError && error.code === code;
}

test("default selection keeps non-standard context out", () => {
  assert.deepEqual(resolveDefaultContextSelection("standard"), {
    included: true,
    inclusion: "auto",
  });
  assert.deepEqual(resolveDefaultContextSelection("personal"), {
    included: false,
    inclusion: "auto",
  });
  assert.deepEqual(resolveDefaultContextSelection("sensitive"), {
    included: false,
    inclusion: "auto",
  });
});

test("createHandoffContextItem applies privacy-aware defaults", () => {
  const standard = createHandoffContextItem({ label: "summary", content: "context text" });
  assert.equal(standard.included, true);
  assert.equal(standard.inclusion, "auto");
  assert.equal(standard.sensitivity, "standard");
  assert.deepEqual(standard.provenance, []);

  const personal = createHandoffContextItem({
    label: "note",
    content: "text",
    sensitivity: "personal",
  });
  assert.equal(personal.included, false);
  assert.equal(personal.inclusion, "auto");

  const explicit = createHandoffContextItem({
    label: "note",
    content: "text",
    sensitivity: "personal",
    included: true,
  });
  assert.equal(explicit.included, true);
  assert.equal(explicit.inclusion, "user");

  const declined = createHandoffContextItem({ label: "note", content: "text", included: false });
  assert.equal(declined.inclusion, "user");

  const first = createHandoffContextItem({ label: "a", content: "x" });
  const second = createHandoffContextItem({ label: "a", content: "x" });
  assert.notEqual(first.id, second.id);
});

test("invalid context items throw handoff_context_item_invalid", () => {
  assert.throws(
    () => createHandoffContextItem({ label: "", content: "x" }),
    handoffError("handoff_context_item_invalid"),
  );
  assert.throws(
    () => createHandoffContextItem({ label: "a", content: "" }),
    handoffError("handoff_context_item_invalid"),
  );
  assert.throws(
    () => createHandoffContextItem({ label: "a", content: "x".repeat(6001) }),
    handoffError("handoff_context_item_invalid"),
  );
});

test("preview lists items, formats provenance and counts UTF-8 bytes", () => {
  const items = [
    createHandoffContextItem({
      label: "Idea summary",
      content: "你好",
      provenance: [{ kind: "idea", id: "idea-1" }],
    }),
    createHandoffContextItem({
      label: "Memory note",
      content: "private",
      sensitivity: "personal",
    }),
    createHandoffContextItem({ label: "Constraint", content: "éé" }),
  ];
  const preview = buildHandoffContextPreview({ context: items });
  assert.equal(preview.items.length, 3);
  assert.equal(preview.includedCount, 2);
  assert.equal(preview.excludedCount, 1);
  assert.equal(preview.includedBytes, 6 + 4);
  assert.equal(preview.items[0].bytes, 6);
  assert.deepEqual(preview.items[0].provenance, ["idea:idea-1"]);
  assert.equal(preview.items[1].included, false);
  assert.equal(preview.withinLimits, true);
  assert.deepEqual(preview.violations, []);
  assert.equal(preview.limits.maxIncludedTotalBytes, 8192);
});

test("preview and limit collection report over-budget context without throwing", () => {
  const chunk = (index: number) =>
    createHandoffContextItem({ label: `chunk ${index}`, content: "a".repeat(2048) });
  const overBudget = [chunk(0), chunk(1), chunk(2), chunk(3), chunk(4)];
  const preview = buildHandoffContextPreview({ context: overBudget });
  assert.equal(preview.withinLimits, false);
  assert.deepEqual(
    preview.violations.map((issue) => issue.code),
    ["handoff_context_total_bytes_exceeded"],
  );

  const tooMany = Array.from({ length: 33 }, (_, index) =>
    createHandoffContextItem({ label: `n${index}`, content: "x", sensitivity: "personal" }),
  );
  const collected = collectHandoffContextLimitViolations(tooMany);
  assert.deepEqual(
    collected.map((issue) => issue.code),
    ["handoff_context_items_limit"],
  );
});

test("editing toggles inclusion without mutating the input", () => {
  const item = createHandoffContextItem({
    label: "note",
    content: "private",
    sensitivity: "personal",
  });
  const holder = { context: [item] };
  const snapshot = JSON.parse(JSON.stringify(holder));

  const toggled = setHandoffContextItemIncluded(holder, item.id, true);
  assert.notEqual(toggled, holder);
  assert.equal(toggled.context[0].included, true);
  assert.equal(toggled.context[0].inclusion, "user");
  assert.deepEqual(JSON.parse(JSON.stringify(holder)), snapshot);

  const untoggled = setHandoffContextItemIncluded(toggled, item.id, false, "auto");
  assert.equal(untoggled.context[0].included, false);
  assert.equal(untoggled.context[0].inclusion, "auto");

  assert.throws(
    () => setHandoffContextItemIncluded(holder, "missing", true),
    handoffError("handoff_context_item_not_found"),
  );
});

test("content edits validate; removal and lookup errors are typed", () => {
  const base = createHandoffPacket({
    sourceMode: "bot",
    destinationMode: "coding",
    objective: "objective",
    returnPolicy: "none",
    sourceRefs: [{ kind: "conversation", id: "bot-conv-1" }],
  });
  const withItem = addHandoffContextItem(base, { label: "note", content: "first draft" });
  const itemId = withItem.context[0].id;

  const edited = updateHandoffContextItemContent(withItem, itemId, "second draft");
  assert.equal(edited.context[0].content, "second draft");
  assert.equal(withItem.context[0].content, "first draft");

  assert.throws(
    () => updateHandoffContextItemContent(withItem, itemId, ""),
    handoffError("handoff_context_item_invalid"),
  );
  assert.throws(
    () => updateHandoffContextItemContent(withItem, "missing", "x"),
    handoffError("handoff_context_item_not_found"),
  );

  const removed = removeHandoffContextItem(withItem, itemId);
  assert.deepEqual(removed.context, []);
  assert.equal(withItem.context.length, 1);
  assert.throws(
    () => removeHandoffContextItem(withItem, "missing"),
    handoffError("handoff_context_item_not_found"),
  );
});

test("adding respects capacity, uniqueness and defaults", () => {
  let holder = { context: [] as HandoffContextItem[] };
  for (let index = 0; index < 32; index += 1) {
    holder = addHandoffContextItem(holder, {
      label: `n${index}`,
      content: "x",
      id: `n-${index}`,
    });
  }
  assert.equal(holder.context.length, 32);
  assert.throws(
    () => addHandoffContextItem(holder, { label: "overflow", content: "y" }),
    handoffError("handoff_context_items_limit"),
  );

  const personal = addHandoffContextItem(
    { context: [] as HandoffContextItem[] },
    { label: "note", content: "private", sensitivity: "personal" },
  );
  assert.equal(personal.context[0].included, false);

  const existing = createHandoffContextItem({ label: "orig", content: "x", id: "fixed-id" });
  assert.throws(
    () =>
      addHandoffContextItem(
        { context: [existing] },
        { label: "dup", content: "x", id: "fixed-id" },
      ),
    handoffError("handoff_context_item_invalid"),
  );
});

test("edited packets stay serializable and transferable end to end", () => {
  let packet: HandoffPacket = createHandoffPacket({
    sourceMode: "bot",
    destinationMode: "coding",
    objective: "Build the first Personal Bot settings surface",
    returnPolicy: "summary-and-artifacts",
    sourceRefs: [{ kind: "conversation", id: "bot-conv-1" }],
  });
  packet = addHandoffContextItem(packet, {
    label: "Idea detail",
    content: "Identity and memory caps are the first surfaces.",
    sensitivity: "personal",
    provenance: [{ kind: "idea", id: "idea-9" }],
  });
  const itemId = packet.context[0].id;
  assert.equal(packet.context[0].included, false);

  const beforeIncluded = buildHandoffContextPreview(packet);
  assert.equal(beforeIncluded.includedCount, 0);
  assert.equal(beforeIncluded.excludedCount, 1);

  packet = setHandoffContextItemIncluded(packet, itemId, true);
  const afterIncluded = buildHandoffContextPreview(packet);
  assert.equal(afterIncluded.includedCount, 1);
  assert.equal(afterIncluded.excludedCount, 0);

  const json = serializeHandoffPacket(packet);
  const back = deserializeHandoffPacket(json);
  assert.deepEqual(back, packet);
  assert.deepEqual(validateHandoffPacketTransfer(back), []);
});
