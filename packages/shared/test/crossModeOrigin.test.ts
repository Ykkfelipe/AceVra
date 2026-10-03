/**
 * Cross-Mode origin（docs/specs/cross-mode-bot-to-coding.md §4）：确认快照的传输形状、
 * 持久 entry 的宽容读取、以及 entry → 只读投影（不含上下文正文、篡改即无来源）。
 *
 * Run: mise exec -- node --import tsx --test packages/shared/test/crossModeOrigin.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  beginHandoffPreview,
  confirmHandoffPreview,
  createHandoffContextItem,
  createHandoffPacket,
  type HandoffConfirmation,
} from "../src/cross-mode/index.js";
import {
  CROSS_MODE_ORIGIN_VERSION,
  commandPayloadSchemas,
  commandResultSchema,
  conversationSnapshotSchema,
  crossModeHandoffCreateSchema,
  parseCrossModeOriginEntry,
  projectCrossModeOriginState,
  type CrossModeOriginEntry,
} from "../src/zcode-protocol-v4/index.js";

function confirmedBotToCoding(): HandoffConfirmation {
  const packet = createHandoffPacket({
    sourceMode: "bot",
    destinationMode: "coding",
    objective: "Add a settings page for reminders",
    returnPolicy: "summary",
    sourceRefs: [{ kind: "conversation", id: "sess_bot_1" }],
    context: [
      createHandoffContextItem({ label: "Notes", content: "Use the existing form components." }),
      createHandoffContextItem({
        label: "Ace: earlier idea",
        content: "private aside",
        included: false,
      }),
    ],
  });
  const confirmed = confirmHandoffPreview(beginHandoffPreview(packet, 10), 20);
  assert.equal(confirmed.ok, true);
  if (!confirmed.ok || !confirmed.session.confirmation) throw new Error("not confirmed");
  return confirmed.session.confirmation;
}

function entryFor(confirmation: HandoffConfirmation): CrossModeOriginEntry {
  return {
    version: CROSS_MODE_ORIGIN_VERSION,
    confirmation: { ...confirmation, warnings: [...confirmation.warnings] },
    resultRef: { kind: "coding-session", id: "sess_code_1" },
    destination: { workspacePath: "/repo/app" },
    acceptedAt: 30,
  };
}

test("createSession accepts a confirmed handoff snapshot and the ACK carries the origin", () => {
  const confirmation = confirmedBotToCoding();
  const payload = commandPayloadSchemas.createSession.parse({
    workspaceId: "/repo/app",
    crossModeHandoff: { confirmation },
  });
  assert.equal(payload.crossModeHandoff?.confirmation.handoffId, confirmation.handoffId);
  // 只接受确认快照：草稿字段（例如直接塞 packet）被 strict schema 拒绝。
  assert.equal(crossModeHandoffCreateSchema.safeParse({ confirmation, packet: {} }).success, false);

  const origin = projectCrossModeOriginState(entryFor(confirmation));
  assert.ok(origin);
  const ack = commandResultSchema.parse({
    type: "createSession",
    sessionId: "sess_code_1",
    crossModeOrigin: origin,
  });
  assert.equal(ack.type, "createSession");
});

test("projection names the source conversation, handoff and result without carried content", () => {
  const confirmation = confirmedBotToCoding();
  const origin = projectCrossModeOriginState(entryFor(confirmation));
  assert.deepEqual(origin, {
    version: CROSS_MODE_ORIGIN_VERSION,
    handoffId: confirmation.handoffId,
    sourceMode: "bot",
    destinationMode: "coding",
    objective: "Add a settings page for reminders",
    sourceRefs: [{ kind: "conversation", id: "sess_bot_1" }],
    returnPolicy: "summary",
    resultRef: { kind: "coding-session", id: "sess_code_1" },
    acceptedAt: 30,
  });
  assert.equal(JSON.stringify(origin).includes("existing form components"), false);
});

test("tampered or mismatched snapshots project to no origin; bad entries parse to null", () => {
  const confirmation = confirmedBotToCoding();
  assert.equal(
    projectCrossModeOriginState(
      entryFor({ ...confirmation, packetJson: confirmation.packetJson.replace("bot", "b0t") }),
    ),
    null,
  );
  assert.equal(
    projectCrossModeOriginState(entryFor({ ...confirmation, handoffId: "someone-else" })),
    null,
  );
  assert.equal(parseCrossModeOriginEntry({ version: "cross-mode-origin/v0" }), null);
  assert.ok(parseCrossModeOriginEntry(JSON.parse(JSON.stringify(entryFor(confirmation)))));
});

test("snapshot schema accepts crossModeOrigin additively", () => {
  const shape = conversationSnapshotSchema.shape as Record<string, unknown>;
  assert.ok("crossModeOrigin" in shape);
});
