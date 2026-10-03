/**
 * Cross-Mode 入站交接（Bot → Coding，docs/specs/cross-mode-bot-to-coding.md）：
 * - intake：冻结准入 → 物化会话 → 写 origin（顺序）→ accepted；坏快照 / 错误目的 / 持久化失败的拒绝语义；
 * - 渲染：首条输入只含 objective、已勾选上下文与约束；
 * - createSession handler：建 record 前的预检、拒绝时回收空会话、成功时 origin 进 ACK 且首条输入来自 packet。
 *
 * Run: mise exec -- node --import tsx --test apps/zcode-cli/packages/bootstrap/test/cross-mode-coding-handoff.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  beginHandoffPreview,
  confirmHandoffPreview,
  createHandoffContextItem,
  createHandoffPacket,
  type CreateHandoffPacketInput,
  type HandoffConfirmation,
} from "@zcode/shared/cross-mode";
import {
  CROSS_MODE_ORIGIN_SESSION_ENTRY_TYPE,
  type CommandEnvelope,
  type CrossModeOriginState,
} from "@zcode/shared/zcode-protocol-v4";
import {
  acceptCrossModeCodingHandoff,
  preflightCrossModeCodingHandoff,
  renderCrossModeHandoffFirstInput,
  type CrossModeCodingIntakeDeps,
} from "../src/app/cross-mode-coding-handoff.js";
import { loadPersistedConversationMaterialization } from "../src/zcode-protocol-v4/cold-event-merge.js";
import { NATIVE_HANDLERS } from "../src/zcode-protocol-v4/commands/handlers/index.js";
import type { V4CommandCoreHost } from "../src/zcode-protocol-v4/commands/types.js";

function confirm(overrides: Partial<CreateHandoffPacketInput> = {}): HandoffConfirmation {
  const packet = createHandoffPacket({
    sourceMode: "bot",
    destinationMode: "coding",
    objective: "Add a reminders settings page",
    returnPolicy: "summary",
    sourceRefs: [{ kind: "conversation", id: "sess_bot_1" }],
    context: [
      createHandoffContextItem({ label: "Notes", content: "Reuse the existing form controls." }),
      createHandoffContextItem({
        label: "You: aside",
        content: "UNSELECTED-ASIDE",
        included: false,
      }),
    ],
    constraints: ["Do not touch billing"],
    ...overrides,
  });
  const confirmed = confirmHandoffPreview(beginHandoffPreview(packet, 1), 2);
  if (!confirmed.ok || !confirmed.session.confirmation) throw new Error("fixture not confirmable");
  return confirmed.session.confirmation;
}

function intakeDeps(calls: string[], overrides: Partial<CrossModeCodingIntakeDeps> = {}) {
  const saved: unknown[] = [];
  const deps: CrossModeCodingIntakeDeps = {
    sessionId: "sess_code_1",
    destination: { workspacePath: "/repo/app" },
    persistSession: async (objective) => {
      calls.push(`persist:${objective}`);
    },
    saveOriginEntry: async (entry) => {
      calls.push(`origin:${entry.type}`);
      saved.push(entry);
    },
    now: () => 100,
    ...overrides,
  };
  return { deps, saved };
}

test("intake admits, persists the session before the origin entry, and projects the origin", async () => {
  const calls: string[] = [];
  const confirmation = confirm();
  const { deps, saved } = intakeDeps(calls);
  const outcome = await acceptCrossModeCodingHandoff(confirmation, deps);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(calls, [
    "persist:Add a reminders settings page",
    `origin:${CROSS_MODE_ORIGIN_SESSION_ENTRY_TYPE}`,
  ]);
  assert.deepEqual(outcome.origin.sourceRefs, [{ kind: "conversation", id: "sess_bot_1" }]);
  assert.deepEqual(outcome.origin.resultRef, { kind: "coding-session", id: "sess_code_1" });
  assert.equal(outcome.origin.handoffId, confirmation.handoffId);
  const entry = saved[0] as { id: string; data: { confirmation: HandoffConfirmation } };
  assert.equal(entry.id, `v4_cross_mode_origin:sess_code_1:${confirmation.handoffId}`);
  // 原样保存确认快照：回程可用冻结契约重新解析出原始 packet。
  assert.equal(entry.data.confirmation.packetJson, confirmation.packetJson);
});

test("intake rejects tampered snapshots without persisting anything", async () => {
  const calls: string[] = [];
  const confirmation = confirm();
  const { deps } = intakeDeps(calls);
  const outcome = await acceptCrossModeCodingHandoff(
    {
      ...confirmation,
      // 冻结契约不做内容签名；结构性篡改（未知版本）必须 fail closed。
      packetJson: confirmation.packetJson.replace("handoff-packet/v1", "handoff-packet/v9"),
    },
    deps,
  );
  assert.equal(outcome.ok, false);
  assert.deepEqual(calls, []);
});

test("intake turns a persistence failure into a bounded rejection", async () => {
  const calls: string[] = [];
  const { deps } = intakeDeps(calls, {
    saveOriginEntry: async () => {
      throw new Error("FOREIGN KEY constraint failed");
    },
  });
  const outcome = await acceptCrossModeCodingHandoff(confirm(), deps);
  assert.deepEqual(outcome, {
    ok: false,
    reason: "rejected",
    message: "FOREIGN KEY constraint failed",
  });
});

test("preflight only admits transferable bot → coding snapshots", () => {
  assert.equal(preflightCrossModeCodingHandoff(confirm()).ok, true);
  const toMultitask = confirm({
    sourceMode: "coding",
    destinationMode: "multitask",
    sourceRefs: [{ kind: "coding-session", id: "sess_1" }],
    linkedProject: { kind: "project", id: "acevra" },
  });
  const preflight = preflightCrossModeCodingHandoff(toMultitask);
  assert.equal(preflight.ok, false);
  const mismatched = { ...confirm(), handoffId: "other" };
  assert.equal(preflightCrossModeCodingHandoff(mismatched).ok, false);
});

test("first input renders the objective, included context and constraints only", () => {
  const confirmation = confirm();
  const packet = JSON.parse(confirmation.packetJson) as Parameters<
    typeof renderCrossModeHandoffFirstInput
  >[0];
  const text = renderCrossModeHandoffFirstInput(packet);
  assert.match(text, /handed off from a conversation with Ace/);
  assert.match(text, /## Objective\nAdd a reminders settings page/);
  assert.match(text, /### Notes\nReuse the existing form controls\./);
  assert.match(text, /- Do not touch billing/);
  assert.equal(text.includes("UNSELECTED-ASIDE"), false);
  assert.equal(text.includes("sess_bot_1"), false);
});

// ── createSession handler ───────────────────────────────────────────────

interface FakeRecord {
  app: Record<string, unknown> & { sessionId: string };
  traceContext: { traceId: string };
  workspace: { workspacePath: string };
  persistence: "immediate" | "deferred";
}

function fakeHost(options: { intake?: (input: unknown) => Promise<unknown> }) {
  const created: string[] = [];
  const closed: string[] = [];
  const published: CrossModeOriginState[] = [];
  const sentTexts: string[] = [];
  const records = new Map<string, FakeRecord>();
  const host = {
    getRecord: (sessionId: string) => records.get(sessionId),
    createSessionRecord: async (params: { workspaceId: string; taskType?: string }) => {
      const sessionId = `sess_${created.length + 1}`;
      created.push(params.workspaceId);
      records.set(sessionId, {
        app: {
          sessionId,
          getModel: () => "glm/glm-5",
          runtime: {
            getSessionModelSelection: () => ({ providerId: "glm", modelId: "glm-5" }),
          },
          ...(options.intake ? { acceptCrossModeHandoff: options.intake } : {}),
          sendInput: async (input: { text: string }) => {
            sentTexts.push(input.text);
            return { kind: "started", completion: Promise.resolve() };
          },
        },
        traceContext: { traceId: "trace" },
        workspace: { workspacePath: params.workspaceId },
        persistence: "deferred",
      });
      return { sessionId };
    },
    closeSession: async (sessionId: string) => {
      closed.push(sessionId);
    },
    publishCrossModeOrigin: (_sessionId: string, origin: CrossModeOriginState) => {
      published.push(origin);
    },
  } as unknown as V4CommandCoreHost;
  return { host, created, closed, published, sentTexts };
}

function createEnvelope(payload: Record<string, unknown>): CommandEnvelope {
  return {
    commandId: "cmd_1",
    sessionId: null,
    type: "createSession",
    payload,
    issuedAt: 1,
  } as unknown as CommandEnvelope;
}

test("createSession rejects invalid handoffs before any session record exists", async () => {
  const fake = fakeHost({});
  const confirmation = confirm();
  await assert.rejects(
    NATIVE_HANDLERS.createSession(
      fake.host,
      createEnvelope({
        workspaceId: "/repo/app",
        crossModeHandoff: { confirmation: { ...confirmation, handoffId: "other" } },
      }),
    ),
    /does not match/,
  );
  await assert.rejects(
    NATIVE_HANDLERS.createSession(
      fake.host,
      createEnvelope({
        workspaceId: "/repo/app",
        crossModeHandoff: { confirmation },
        firstInput: { text: "hi" },
      }),
    ),
    /cannot be combined/,
  );
  assert.deepEqual(fake.created, []);
});

test("createSession closes the new session when the intake rejects", async () => {
  const fake = fakeHost({
    intake: async () => ({ ok: false, reason: "rejected", message: "disk full" }),
  });
  await assert.rejects(
    NATIVE_HANDLERS.createSession(
      fake.host,
      createEnvelope({ workspaceId: "/repo/app", crossModeHandoff: { confirmation: confirm() } }),
    ),
    /disk full/,
  );
  assert.deepEqual(fake.created, ["/repo/app"]);
  assert.deepEqual(fake.closed, ["sess_1"]);
  assert.deepEqual(fake.published, []);
});

test("createSession accepts, publishes the origin, and starts the rendered first turn", async () => {
  const confirmation = confirm();
  const calls: string[] = [];
  const fake = fakeHost({
    intake: async (input) => {
      const { deps } = intakeDeps(calls);
      return acceptCrossModeCodingHandoff(
        (input as { confirmation: HandoffConfirmation }).confirmation,
        { ...deps, sessionId: "sess_1" },
      );
    },
  });
  const result = await NATIVE_HANDLERS.createSession(
    fake.host,
    createEnvelope({ workspaceId: "/repo/app", crossModeHandoff: { confirmation } }),
  );
  assert.equal(result?.type, "createSession");
  const ack = result as { crossModeOrigin?: CrossModeOriginState; input?: unknown };
  assert.equal(ack.crossModeOrigin?.handoffId, confirmation.handoffId);
  assert.ok(ack.input);
  assert.equal(fake.published.length, 1);
  assert.equal(fake.sentTexts.length, 1);
  assert.match(fake.sentTexts[0] ?? "", /## Objective\nAdd a reminders settings page/);
  assert.deepEqual(fake.closed, []);
});

test("cold materialization restores crossModeOrigin from the persisted entry", async () => {
  const confirmation = confirm();
  const saved: { type: string; data: unknown }[] = [];
  const { deps } = intakeDeps([], {
    saveOriginEntry: async (entry) => {
      saved.push(entry);
    },
  });
  const outcome = await acceptCrossModeCodingHandoff(confirmation, deps);
  assert.equal(outcome.ok, true);
  const store = {
    getSession: async () => ({ title: "Add a reminders settings page" }),
    messages: async () => [],
    readTarget: async () => null,
    sessionEntries: async () => [
      ...saved.map((entry) => ({
        ...entry,
        id: "e1",
        sessionID: "sess_code_1",
        time: { created: 1, updated: 1 },
      })),
      // 坏数据不能拖垮快照，也不能伪造来源。
      {
        id: "e2",
        sessionID: "sess_code_1",
        type: CROSS_MODE_ORIGIN_SESSION_ENTRY_TYPE,
        data: { version: "x" },
        time: { created: 1, updated: 1 },
      },
    ],
  };
  const loaded = await loadPersistedConversationMaterialization({
    memoryEvents: [],
    sessionId: "sess_code_1",
    store: store as unknown as Parameters<
      typeof loadPersistedConversationMaterialization
    >[0]["store"],
  });
  assert.equal(loaded.crossModeOrigin?.handoffId, confirmation.handoffId);
  assert.deepEqual(loaded.crossModeOrigin?.sourceRefs, [
    { kind: "conversation", id: "sess_bot_1" },
  ]);
});
