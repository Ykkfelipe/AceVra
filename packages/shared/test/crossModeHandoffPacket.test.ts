/**
 * Cross-Mode 契约单测：模式/对象引用、转移矩阵、HandoffPacket 构造与 schema、
 * 规范序列化、transfer 语义准入校验（覆盖全部准入错误码与确定性排序）。
 *
 * Run: mise exec -- node --import tsx --test packages/shared/test/crossModeHandoffPacket.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ACEVRA_MODES,
  HANDOFF_FLOW_MATRIX,
  HandoffContractError,
  assertHandoffPacketTransferable,
  createHandoffContextItem,
  createHandoffPacket,
  deserializeHandoffPacket,
  handoffDirection,
  handoffIssuesSorted,
  handoffObjectRefKey,
  isAceVraMode,
  isHandoffObjectKind,
  isHandoffPacketTransferable,
  isHandoffTransitionAllowed,
  parseHandoffObjectRef,
  parseHandoffPacket,
  safeParseHandoffPacket,
  serializeHandoffPacket,
  sameHandoffObjectRef,
  validateHandoffPacketTransfer,
  type CreateHandoffPacketInput,
  type HandoffPacket,
} from "../src/index.js";

function handoffError(code: string) {
  return (error: unknown): boolean => error instanceof HandoffContractError && error.code === code;
}

function baseHandoffInput(): CreateHandoffPacketInput {
  return {
    sourceMode: "bot",
    destinationMode: "coding",
    objective: "Build the first Personal Bot settings surface",
    returnPolicy: "summary-and-artifacts",
    sourceRefs: [{ kind: "conversation", id: "bot-conv-1" }],
  };
}

function validBotToCodingPacket(): HandoffPacket {
  return createHandoffPacket({
    ...baseHandoffInput(),
    permissions: ["repo-read", "repo-write"],
    linkedProject: { kind: "project", id: "acevra" },
  });
}

test("mode and object-kind guards accept the closed vocabulary", () => {
  assert.deepEqual([...ACEVRA_MODES], ["bot", "coding", "multitask"]);
  assert.equal(isAceVraMode("bot"), true);
  assert.equal(isAceVraMode("coding"), true);
  assert.equal(isAceVraMode("multitask"), true);
  assert.equal(isAceVraMode("work"), false);
  assert.equal(isAceVraMode(42), false);
  assert.equal(isAceVraMode(null), false);

  assert.equal(isHandoffObjectKind("idea"), true);
  assert.equal(isHandoffObjectKind("coding-session"), true);
  assert.equal(isHandoffObjectKind("multitask-run"), true);
  assert.equal(isHandoffObjectKind("message"), false);
  assert.equal(isHandoffObjectKind(undefined), false);
});

test("object refs round-trip through kind:id keys", () => {
  assert.equal(
    handoffObjectRefKey({ kind: "coding-session", id: "sess-1" }),
    "coding-session:sess-1",
  );
  assert.deepEqual(parseHandoffObjectRef("idea:abc"), { kind: "idea", id: "abc" });
  assert.deepEqual(parseHandoffObjectRef("coding-session:sess:1"), {
    kind: "coding-session",
    id: "sess:1",
  });
  const compoundKey = "idea:personal-bot:design";
  const parsed = parseHandoffObjectRef(compoundKey);
  assert.notEqual(parsed, null);
  assert.equal(handoffObjectRefKey(parsed), compoundKey);

  assert.equal(parseHandoffObjectRef("work:abc"), null);
  assert.equal(parseHandoffObjectRef("idea:"), null);
  assert.equal(parseHandoffObjectRef(":abc"), null);
  assert.equal(parseHandoffObjectRef("idea:has space"), null);
  assert.equal(parseHandoffObjectRef(`idea:${"a".repeat(201)}`), null);
  assert.equal(parseHandoffObjectRef("justtext"), null);

  assert.equal(sameHandoffObjectRef({ kind: "idea", id: "x" }, { kind: "idea", id: "x" }), true);
  assert.equal(sameHandoffObjectRef({ kind: "idea", id: "x" }, { kind: "goal", id: "x" }), false);
  assert.equal(sameHandoffObjectRef({ kind: "idea", id: "x" }, { kind: "idea", id: "y" }), false);
});

test("flow matrix exposes the five v1 transitions with directions", () => {
  assert.deepEqual(HANDOFF_FLOW_MATRIX, {
    bot: ["coding"],
    coding: ["multitask", "bot"],
    multitask: ["coding", "bot"],
  });

  assert.equal(isHandoffTransitionAllowed("bot", "coding"), true);
  assert.equal(isHandoffTransitionAllowed("coding", "multitask"), true);
  assert.equal(isHandoffTransitionAllowed("coding", "bot"), true);
  assert.equal(isHandoffTransitionAllowed("multitask", "coding"), true);
  assert.equal(isHandoffTransitionAllowed("multitask", "bot"), true);
  assert.equal(isHandoffTransitionAllowed("bot", "multitask"), false);
  assert.equal(isHandoffTransitionAllowed("bot", "bot"), false);
  assert.equal(isHandoffTransitionAllowed("coding", "coding"), false);
  assert.equal(isHandoffTransitionAllowed("multitask", "multitask"), false);

  assert.equal(handoffDirection("bot", "coding"), "transfer");
  assert.equal(handoffDirection("coding", "multitask"), "transfer");
  assert.equal(handoffDirection("multitask", "coding"), "return");
  assert.equal(handoffDirection("coding", "bot"), "return");
  assert.equal(handoffDirection("multitask", "bot"), "return");
  assert.equal(handoffDirection("coding", "coding"), null);
  assert.equal(handoffDirection("bot", "multitask"), null);
});

test("createHandoffPacket fills version, id, timestamp and defaults", () => {
  const packet = validBotToCodingPacket();
  assert.equal(packet.version, "handoff-packet/v1");
  assert.match(
    packet.handoffId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.equal(typeof packet.createdAt, "number");
  assert.ok(packet.createdAt > 0);
  assert.deepEqual(packet.context, []);
  assert.deepEqual(packet.constraints, []);

  const minimal = createHandoffPacket({
    sourceMode: "bot",
    destinationMode: "coding",
    objective: "x",
    returnPolicy: "none",
  });
  assert.deepEqual(minimal.sourceRefs, []);
  assert.deepEqual(minimal.permissions, []);
  assert.equal(minimal.linkedProject, null);

  const other = createHandoffPacket(baseHandoffInput());
  assert.notEqual(minimal.handoffId, other.handoffId);
});

test("packet schema is strict and bounds its fields", () => {
  const packet = validBotToCodingPacket();
  assert.throws(
    () => parseHandoffPacket({ ...packet, extra: true }),
    handoffError("handoff_schema_invalid"),
  );
  assert.throws(
    () => createHandoffPacket({ ...baseHandoffInput(), objective: "" }),
    handoffError("handoff_schema_invalid"),
  );
  assert.throws(
    () => createHandoffPacket({ ...baseHandoffInput(), objective: "a".repeat(501) }),
    handoffError("handoff_schema_invalid"),
  );
  assert.throws(
    () => parseHandoffPacket({ ...packet, permissions: ["repo-admin"] }),
    handoffError("handoff_schema_invalid"),
  );
  assert.throws(
    () => parseHandoffPacket({ ...packet, returnPolicy: "everything" }),
    handoffError("handoff_schema_invalid"),
  );
});

function richPacket(): HandoffPacket {
  return createHandoffPacket({
    ...baseHandoffInput(),
    constraints: ["do not change the current auth flow"],
    permissions: ["repo-read", "repo-write"],
    linkedProject: { kind: "project", id: "acevra" },
    context: [
      createHandoffContextItem({
        label: "Idea summary",
        content: "Personal Bot needs a settings surface for identity and memory caps.",
        sensitivity: "standard",
        provenance: [{ kind: "idea", id: "idea:personal-bot" }],
      }),
      createHandoffContextItem({
        label: "Excluded: unrelated personal memory",
        content: "Grocery list for the weekend.",
        sensitivity: "personal",
      }),
    ],
  });
}

test("serialization is canonical, stable and round-trips", () => {
  const packet = richPacket();
  const serialized = serializeHandoffPacket(packet);
  const reparsed = parseHandoffPacket(JSON.parse(serialized));
  assert.deepEqual(reparsed, packet);
  assert.equal(serializeHandoffPacket(reparsed), serialized);
  assert.ok(serialized.startsWith('{"version":"handoff-packet/v1"'));

  const orderedKeys = [
    '"version"',
    '"handoffId"',
    '"createdAt"',
    '"sourceMode"',
    '"destinationMode"',
    '"objective"',
    '"context"',
    '"sourceRefs"',
    '"constraints"',
    '"permissions"',
    '"linkedProject"',
    '"returnPolicy"',
  ];
  let previousIndex = -1;
  for (const key of orderedKeys) {
    const index = serialized.indexOf(key);
    assert.ok(index > previousIndex, `expected key ${key} after position ${previousIndex}`);
    previousIndex = index;
  }
  assert.ok(
    serialized.includes('"provenance":[{"kind":"idea","id":"idea:personal-bot"}]'),
    "context provenance serializes as ref objects",
  );
});

test("deserialize maps JSON and version failures to stable codes", () => {
  assert.throws(() => deserializeHandoffPacket("{not json"), handoffError("handoff_json_invalid"));
  assert.throws(
    () => parseHandoffPacket({ version: "handoff-packet/v2" }),
    handoffError("handoff_version_unsupported"),
  );
  assert.throws(
    () => deserializeHandoffPacket(JSON.stringify({ version: "handoff-return/v1" })),
    handoffError("handoff_version_unsupported"),
  );
});

test("safeParseHandoffPacket returns sorted issues instead of throwing", () => {
  const failure = safeParseHandoffPacket({});
  assert.equal(failure.ok, false);
  if (!failure.ok) {
    assert.ok(failure.issues.length > 0);
    const codes = failure.issues.map((issue) => issue.code);
    assert.deepEqual(codes, [...codes].sort());
    assert.ok(failure.issues.every((issue) => issue.severity === "error"));
    assert.deepEqual(failure.issues, handoffIssuesSorted(failure.issues));
  }
  const success = safeParseHandoffPacket(validBotToCodingPacket());
  assert.equal(success.ok, true);
});

test("transfer validation accepts the canonical bot→coding packet", () => {
  const packet = validBotToCodingPacket();
  assert.deepEqual(validateHandoffPacketTransfer(packet), []);
  assert.equal(isHandoffPacketTransferable(packet), true);
  assert.doesNotThrow(() => assertHandoffPacketTransferable(packet));
});

test("transfer validation rejects same-mode and out-of-matrix transitions", () => {
  const sameMode = validateHandoffPacketTransfer({
    ...validBotToCodingPacket(),
    destinationMode: "bot",
  });
  assert.deepEqual(
    sameMode.map((issue) => issue.code),
    ["handoff_same_mode"],
  );
  assert.equal(sameMode[0].severity, "error");

  const notAllowed = validateHandoffPacketTransfer({
    ...validBotToCodingPacket(),
    destinationMode: "multitask",
  });
  assert.deepEqual(
    notAllowed.map((issue) => issue.code),
    ["handoff_transition_not_allowed"],
  );
});

test("repo-write without repo-read is rejected", () => {
  const issues = validateHandoffPacketTransfer({
    ...validBotToCodingPacket(),
    permissions: ["repo-write"],
  });
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["handoff_repo_write_requires_read"],
  );
});

test("non-standard context requires explicit user inclusion", () => {
  const personal = createHandoffContextItem({
    label: "Personal note",
    content: "private planning note",
    sensitivity: "personal",
    included: true,
  });
  assert.equal(personal.inclusion, "user");
  const clean = createHandoffPacket({ ...baseHandoffInput(), context: [personal] });
  assert.deepEqual(validateHandoffPacketTransfer(clean), []);

  const autoIncluded = { ...personal, inclusion: "auto" as const };
  const unsafe = createHandoffPacket({ ...baseHandoffInput(), context: [autoIncluded] });
  const codes = validateHandoffPacketTransfer(unsafe).map((issue) => issue.code);
  assert.deepEqual(codes, ["handoff_sensitive_auto_included"]);

  const excluded = createHandoffContextItem({
    label: "Personal note (not carried)",
    content: "private planning note",
    sensitivity: "sensitive",
  });
  assert.equal(excluded.included, false);
  assert.deepEqual(
    validateHandoffPacketTransfer(
      createHandoffPacket({ ...baseHandoffInput(), context: [excluded] }),
    ),
    [],
  );
});

test("duplicate context item ids are rejected", () => {
  const first = createHandoffContextItem({ label: "a", content: "x", id: "dup-id" });
  const second = { ...first };
  const packet = createHandoffPacket({ ...baseHandoffInput(), context: [first, second] });
  const codes = validateHandoffPacketTransfer(packet).map((issue) => issue.code);
  assert.deepEqual(codes, ["handoff_context_item_ids_duplicated"]);
});

test("context byte and count limits are enforced on included items", () => {
  // 单条 included 超过 maxItemBytes（多字节字符，证明按 UTF-8 字节计）
  const tooLarge = createHandoffContextItem({ label: "big", content: "你".repeat(683) });
  const tooLargeCodes = validateHandoffPacketTransfer(
    createHandoffPacket({ ...baseHandoffInput(), context: [tooLarge] }),
  ).map((issue) => issue.code);
  assert.deepEqual(tooLargeCodes, ["handoff_context_item_too_large"]);

  // 恰好 2046 字节（682 × 3）不触发单条超限
  const justRight = createHandoffContextItem({ label: "ok", content: "你".repeat(682) });
  assert.deepEqual(
    validateHandoffPacketTransfer(
      createHandoffPacket({ ...baseHandoffInput(), context: [justRight] }),
    ),
    [],
  );

  // included 总量超过 8192 字节（5 × 2048 = 10240），且单条都不超限
  const chunks = Array.from({ length: 5 }, (_, index) =>
    createHandoffContextItem({ label: `chunk ${index}`, content: "a".repeat(2048) }),
  );
  const totalCodes = validateHandoffPacketTransfer(
    createHandoffPacket({ ...baseHandoffInput(), context: chunks }),
  ).map((issue) => issue.code);
  assert.deepEqual(totalCodes, ["handoff_context_total_bytes_exceeded"]);

  // included 条数超过 16
  const many = Array.from({ length: 17 }, (_, index) =>
    createHandoffContextItem({ label: `note ${index}`, content: "x" }),
  );
  const manyCodes = validateHandoffPacketTransfer(
    createHandoffPacket({ ...baseHandoffInput(), context: many }),
  ).map((issue) => issue.code);
  assert.deepEqual(manyCodes, ["handoff_context_included_limit"]);
});

test("provenance source refs are mandatory for a transfer", () => {
  const issues = validateHandoffPacketTransfer({
    ...validBotToCodingPacket(),
    sourceRefs: [],
  });
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["handoff_source_refs_required"],
  );
});

test("linked project rules follow the flow", () => {
  const wrongKind = validateHandoffPacketTransfer({
    ...validBotToCodingPacket(),
    linkedProject: { kind: "idea", id: "idea-1" },
  });
  assert.deepEqual(
    wrongKind.map((issue) => issue.code),
    ["handoff_linked_project_kind_invalid"],
  );

  const codingToMultitaskInput = {
    sourceMode: "coding",
    destinationMode: "multitask",
    objective: "Split the remaining work across bounded workers",
    returnPolicy: "summary",
    sourceRefs: [{ kind: "coding-session", id: "sess-1" }],
    permissions: ["repo-read"],
  } as const;
  const missing = createHandoffPacket(codingToMultitaskInput);
  assert.deepEqual(
    validateHandoffPacketTransfer(missing).map((issue) => issue.code),
    ["handoff_linked_project_required"],
  );

  const linked = createHandoffPacket({
    ...codingToMultitaskInput,
    linkedProject: { kind: "project", id: "acevra" },
  });
  assert.deepEqual(validateHandoffPacketTransfer(linked), []);

  // bot→coding 允许不带 linkedProject（对应「新建项目」场景）
  const noProject = createHandoffPacket(baseHandoffInput());
  assert.deepEqual(validateHandoffPacketTransfer(noProject), []);
});

test("duplicate constraints warn but do not block", () => {
  const packet: HandoffPacket = {
    ...validBotToCodingPacket(),
    constraints: ["do not change the current auth flow", "do not change the current auth flow"],
  };
  const issues = validateHandoffPacketTransfer(packet);
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["handoff_constraint_duplicated"],
  );
  assert.equal(issues[0].severity, "warning");
  assert.equal(isHandoffPacketTransferable(packet), true);
  assert.doesNotThrow(() => assertHandoffPacketTransferable(packet));
});

test("assertHandoffPacketTransferable throws the assembled errors", () => {
  const bad: HandoffPacket = { ...validBotToCodingPacket(), destinationMode: "multitask" };
  assert.throws(
    () => assertHandoffPacketTransferable(bad),
    (error: unknown) => {
      if (!(error instanceof HandoffContractError)) {
        return false;
      }
      return (
        error.code === "handoff_transition_not_allowed" &&
        error.issues.length > 0 &&
        error.issues.every((issue) => issue.severity === "error")
      );
    },
  );
});

test("issue ordering is deterministic and sorted", () => {
  const messy: HandoffPacket = {
    ...validBotToCodingPacket(),
    destinationMode: "bot",
    sourceRefs: [],
    permissions: ["repo-write"],
    constraints: ["c", "c"],
  };
  const first = validateHandoffPacketTransfer(messy);
  const second = validateHandoffPacketTransfer(messy);
  assert.deepEqual(first, second);
  assert.deepEqual(first, handoffIssuesSorted(first));
  const codes = first.map((issue) => issue.code);
  assert.deepEqual([...codes], [...codes].sort());
  assert.deepEqual(
    [...new Set(codes)].sort(),
    [
      "handoff_constraint_duplicated",
      "handoff_repo_write_requires_read",
      "handoff_same_mode",
      "handoff_source_refs_required",
    ].sort(),
  );
});
