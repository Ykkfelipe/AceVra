/**
 * "Model switched X → Y" 分隔线（specs/model-change-divider.md）。
 *
 * 全部走真实代码：冷路径 = transcript-hydration 合成事件 → ProductProjection；
 * 活路径 = 同一份历史水合 + runtime 种子，再叠加真实的 ModelSelected / TurnStarted 事件。
 * 同一份持久化历史在两条路径上必须产出完全相同的分隔线。
 *
 * Run: mise exec -- node --import tsx --test apps/zcode-cli/packages/bootstrap/test/model-change-divider.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSessionEvent,
  SessionEventType,
  type MessageWithParts,
  type ModelSelection,
  type SessionId,
  type TraceContext,
  type TurnId,
} from "@zcode/contracts";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { synthesizeEventsFromMessages } from "../src/zcode-protocol-v4/transcript-hydration.js";
import { applySessionModelSelection } from "../src/zcode-protocol-v4/model-config-mutation.js";

const SESSION_ID = "sess-divider";
const ZAI: ModelSelection = {
  providerId: "account:zai-individual-coding-plan",
  modelId: "GLM-5.3",
  options: { reasoningLevel: "max" },
};
const CC: ModelSelection = {
  providerId: "command-code",
  modelId: "gpt-5.6-sol",
  options: { reasoningLevel: "max" },
};
const AZURE: ModelSelection = {
  providerId: "azure-openai",
  modelId: "gpt-5-mini",
  options: { reasoningLevel: "low" },
};

/** before = 分隔线下方第一条用户输入：位置也是语义的一部分，不能只比较集合。 */
const ZAI_ID = `${ZAI.providerId}/${ZAI.modelId}`;
const CC_ID = "command-code/gpt-5.6-sol";
const AZURE_ID = "azure-openai/gpt-5-mini";

type Divider = { from: string | null; to: string; thought: string; before: string | null };

let clock = 1_000;
let ids = 0;
const nextId = (prefix: string) => `${prefix}_${(ids += 1)}`;

/** 一轮真实用户输入 + 助手回复；用户消息记录本轮实际使用的模型。 */
function turn(text: string, model: ModelSelection): MessageWithParts[] {
  const userId = nextId("msg_user");
  const assistantId = nextId("msg_assistant");
  const created = (clock += 10);
  return [
    {
      info: {
        id: userId,
        sessionID: SESSION_ID,
        role: "user",
        time: { created },
        modelSelection: model,
        semantics: {
          origin: "real_user",
          kind: "user_prompt",
          uiVisibility: "visible",
          providerVisibility: "visible",
          transcriptVisibility: "visible",
        },
      },
      parts: [{ id: nextId("prt"), sessionID: SESSION_ID, messageID: userId, type: "text", text }],
    },
    {
      info: {
        id: assistantId,
        sessionID: SESSION_ID,
        role: "assistant",
        parentID: userId,
        time: { created: created + 1, completed: created + 2 },
        providerId: model.providerId,
        modelId: model.modelId,
        semantics: {
          origin: "agent_runtime",
          kind: "assistant_response",
          uiVisibility: "visible",
          providerVisibility: "visible",
          transcriptVisibility: "visible",
        },
      },
      parts: [
        {
          id: nextId("prt"),
          sessionID: SESSION_ID,
          messageID: assistantId,
          type: "text",
          text: `reply from ${model.providerId}`,
        },
      ],
    },
  ] as unknown as MessageWithParts[];
}

/** runtime 在 TurnStarted 前持久化的 model_change 宿主消息（与 timeline-persistence 同形）。 */
function modelChangePart(from: ModelSelection | undefined, to: ModelSelection): MessageWithParts {
  const id = nextId("msg_timeline");
  const created = (clock += 10);
  return {
    info: {
      id,
      sessionID: SESSION_ID,
      role: "assistant",
      time: { created, completed: created },
      providerId: to.providerId,
      modelId: to.modelId,
      semantics: {
        origin: "system",
        kind: "timeline_event",
        uiVisibility: "visible",
        providerVisibility: "hidden",
        transcriptVisibility: "visible",
      },
    },
    parts: [
      {
        id: nextId("prt"),
        sessionID: SESSION_ID,
        messageID: id,
        type: "timeline",
        timelineType: "model_change",
        display: "separator",
        status: "completed",
        ...(from ? { fromModel: { ...from, label: `${from.providerId}/${from.modelId}` } } : {}),
        toModel: { ...to, label: `${to.providerId}/${to.modelId}` },
        time: { start: created, end: created },
      },
    ],
  } as unknown as MessageWithParts;
}

/** 后端迁移（Codex → Agent）写入的 model-only 上下文种子（backend-handoff-seed.ts 同形）。 */
function seed(model: ModelSelection): MessageWithParts {
  const id = nextId("msg_seed");
  const created = (clock += 10);
  return {
    info: {
      id,
      sessionID: SESSION_ID,
      role: "user",
      time: { created },
      agent: "zcode-agent",
      modelSelection: model,
      synthetic: true,
      source: "backend_handoff",
      visibility: "model-only",
      semantics: {
        origin: "import",
        kind: "backend_handoff",
        source: "backend_migration",
        uiVisibility: "hidden",
        providerVisibility: "visible",
        transcriptVisibility: "hidden",
      },
    },
    parts: [
      {
        id: nextId("prt"),
        sessionID: SESSION_ID,
        messageID: id,
        type: "text",
        text: "Prior task context transferred from Codex.",
        synthetic: true,
      },
    ],
  } as unknown as MessageWithParts;
}

function dividers(projection: ProductProjection): Divider[] {
  const rows = projection.getSnapshot().rows.window;
  return rows.flatMap((row, index) => {
    if (row.kind !== "timelineMarker" || row.marker.type !== "modelChange") return [];
    const next = rows.slice(index + 1).find((candidate) => candidate.kind === "userInput");
    return [
      {
        from:
          row.marker.fromProvider === undefined
            ? null
            : `${row.marker.fromProvider}/${row.marker.fromModel}`,
        to: `${row.marker.toProvider}/${row.marker.toModel}`,
        thought: row.marker.toThought,
        before: next?.kind === "userInput" ? next.text : null,
      },
    ];
  });
}

/** 冷水合：与 gateway hydratePublisher 相同——合成事件逐条进投影，再以 runtime 真值做种子。 */
function hydrate(
  messages: readonly MessageWithParts[],
  runtimeSelection: ModelSelection,
): ProductProjection {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  for (const event of synthesizeEventsFromMessages(messages, { sessionId: SESSION_ID })) {
    projection.applyEvent(event);
  }
  projection.seedConfig({
    modelSelection: runtimeSelection,
    provider: runtimeSelection.providerId,
    model: runtimeSelection.modelId,
    thought: runtimeSelection.options?.reasoningLevel ?? "",
  });
  return projection;
}

const TRACE = { traceId: "trace-divider" } as unknown as TraceContext;

/** 最小 ZCodeApp：runtime 选择 + 真实 ModelSelected 事件直接进活投影。 */
function fakeApp(projection: ProductProjection, initial: ModelSelection) {
  let selection = initial;
  return {
    setModel: async (next: ModelSelection) => {
      selection = next;
      return {};
    },
    getThoughtLevel: () => selection.options?.reasoningLevel,
    listThoughtLevels: () => ["low", "max"],
    runtime: {
      getSessionModelSelection: () => selection,
      emitModelSelected: async (options: {
        modelSelection: ModelSelection;
        effectiveReasoningLevel?: string;
        previousModelSelection?: ModelSelection | null;
        supportedThoughtLevels?: readonly string[];
      }) => {
        projection.applyEvent(
          createSessionEvent(SessionEventType.ModelSelected, SESSION_ID as SessionId, {
            modelSelection: options.modelSelection,
            ...(options.effectiveReasoningLevel
              ? { effectiveReasoningLevel: options.effectiveReasoningLevel }
              : {}),
            ...(options.previousModelSelection !== undefined
              ? { previousModelSelection: options.previousModelSelection }
              : {}),
            ...(options.supportedThoughtLevels
              ? { supportedThoughtLevels: [...options.supportedThoughtLevels] }
              : {}),
          }),
        );
      },
    },
  } as never;
}

/** 活路径的一轮：runtime 发出的 TurnStarted（携带本轮 admitted selection 的 intent）。 */
function liveTurnStarted(
  projection: ProductProjection,
  model: ModelSelection,
  turnNumber: number,
  input: string,
) {
  projection.applyEvent(
    createSessionEvent(
      SessionEventType.TurnStarted,
      SESSION_ID as SessionId,
      {
        turnNumber,
        input,
        messageId: nextId("msg_live"),
        intent: { modelSelection: model, mode: "build", planEnabled: false },
      },
      { turnId: `turn_live_${turnNumber}` as TurnId },
    ),
  );
}

test("A/B: Z.ai → Command Code → Azure renders each divider in its real direction", () => {
  const history = [
    ...turn("first", ZAI),
    modelChangePart(ZAI, CC),
    ...turn("second", CC),
    modelChangePart(CC, AZURE),
    ...turn("third", AZURE),
  ];
  assert.deepEqual(dividers(hydrate(history, AZURE)), [
    { from: ZAI_ID, to: CC_ID, thought: "max", before: "second" },
    { from: CC_ID, to: AZURE_ID, thought: "low", before: "third" },
  ]);
});

test("E: a reasoning-bearing destination keeps provider, model and thought", () => {
  const history = [...turn("first", CC), modelChangePart(CC, AZURE), ...turn("second", AZURE)];
  const [divider] = dividers(hydrate(history, AZURE));
  assert.deepEqual(divider, { from: CC_ID, to: AZURE_ID, thought: "low", before: "second" });
});

test("D/F: migration seed + legacy setModel renders the same divider live and after restart", async () => {
  // Agent(Command Code) 历史 → Codex 段（不在本会话）→ 迁回 Agent(Azure)：种子 + setModel。
  const history = [...turn("first", ZAI), modelChangePart(ZAI, CC), ...turn("second", CC)];
  const seeded = [...history, seed(AZURE)];

  // 活路径：迁移时会话被恢复（runtime 仍是 Command Code），随后 legacy setModel(Azure)，再跑一轮。
  const live = hydrate(seeded, CC);
  const app = fakeApp(live, CC);
  await applySessionModelSelection(app, AZURE, TRACE);
  liveTurnStarted(live, AZURE, 3, "third");

  // 冷路径：同一轮在持久层留下的是 setModel 的 model_change 部件 + 记录 Azure 的用户消息。
  const persisted = [...seeded, modelChangePart(CC, AZURE), ...turn("third", AZURE)];
  const cold = hydrate(persisted, AZURE);

  const expected: Divider[] = [
    { from: ZAI_ID, to: CC_ID, thought: "max", before: "second" },
    { from: CC_ID, to: AZURE_ID, thought: "low", before: "third" },
  ];
  assert.deepEqual(dividers(live), expected, "live");
  assert.deepEqual(dividers(cold), expected, "cold rebuild renders the same dividers");
});

test("F: the seed alone never creates or moves a divider", () => {
  const history = [...turn("first", CC), seed(AZURE), ...turn("second", CC)];
  assert.deepEqual(dividers(hydrate(history, CC)), []);
});

test("C: Azure → Z.ai through a submission renders Azure → Z.ai live and cold", async () => {
  const history = [...turn("first", AZURE)];
  const live = hydrate(history, AZURE);
  // composer 提交直接携带新选择：runtime 在 TurnStarted 前应用并发布 ModelSelected。
  const app = fakeApp(live, AZURE);
  await app.runtime.emitModelSelected({ modelSelection: ZAI, previousModelSelection: AZURE });
  liveTurnStarted(live, ZAI, 2, "second");
  // 纯提交驱动的切换不落 model_change 部件；冷路径只凭用户消息。
  const cold = hydrate([...history, ...turn("second", ZAI)], ZAI);
  const expected: Divider[] = [{ from: AZURE_ID, to: ZAI_ID, thought: "max", before: "second" }];
  assert.deepEqual(dividers(live), expected, "live");
  assert.deepEqual(dividers(cold), expected, "cold");
});

test("historical contradicting parts render from each turn's recorded selection", () => {
  // 修复前真实会话的持久形态：setModel 记下的部件与随后实际提交的模型矛盾（Z.ai→Azure 但
  // 第一轮跑在 Z.ai；Command Code→Azure 但那一轮跑在 Command Code）。部件不改写。
  const history = [
    modelChangePart(ZAI, AZURE),
    ...turn("first", ZAI),
    ...turn("second", CC),
    seed(CC),
    modelChangePart(CC, AZURE),
    ...turn("third", CC),
    seed(AZURE),
    modelChangePart(CC, AZURE),
    ...turn("fourth", AZURE),
  ];
  assert.deepEqual(dividers(hydrate(history, AZURE)), [
    { from: ZAI_ID, to: CC_ID, thought: "max", before: "second" },
    { from: CC_ID, to: AZURE_ID, thought: "low", before: "fourth" },
  ]);
});

test("the observed live regression: bad history + migration setModel + Azure turn", async () => {
  // 修复前活路径画出「Azure → Command Code」于一轮实际跑在 Azure 的输入之上。
  const prefix = [
    modelChangePart(ZAI, AZURE),
    ...turn("first", ZAI),
    ...turn("second", CC),
    seed(CC),
    modelChangePart(CC, AZURE),
    ...turn("third", CC),
    seed(AZURE),
  ];
  const live = hydrate(prefix, CC);
  await applySessionModelSelection(fakeApp(live, CC), AZURE, TRACE);
  liveTurnStarted(live, AZURE, 4, "fourth");
  const cold = hydrate([...prefix, modelChangePart(CC, AZURE), ...turn("fourth", AZURE)], AZURE);
  const expected: Divider[] = [
    { from: ZAI_ID, to: CC_ID, thought: "max", before: "second" },
    { from: CC_ID, to: AZURE_ID, thought: "low", before: "fourth" },
  ];
  assert.deepEqual(dividers(live), expected, "live");
  assert.deepEqual(dividers(cold), expected, "cold");
});
