// M2B workspace projection tests: frame contract, backend identity, capture discipline
// (UI polling creates zero captures), logical cursor, action projection, target fencing,
// staleness, honest failure semantics, and the carried-forward zero-steal/no-lease
// invariants. Envelope shapes mirror the real Helper records captured live in M2A.
//
// Run: node --test packages/zcode-cua/test/computer-workspace-projection.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAgentWorkspaceBackend } from "../computer-workspace-backend.js";
import { createWorkspaceProjection, WORKSPACE_STATES } from "../computer-workspace-projection.js";

const LOCAL = Object.freeze({
  sessionId: "session-a",
  turnId: "turn-1",
  runtimeScope: "main",
  clientMode: "desktop-continuous",
  deliveryKind: "desktop-continuous",
});

// Real-envelope shapes (field names/casing taken from live M2A records, values trimmed).
const observeEnvelope = (observationId, pid, dimensions = { width: 480, height: 300 }) => ({
  operation: "observe",
  effect: "confirmed",
  route: "ax",
  classification: "BACKGROUND_SAFE",
  image: { observation_id: observationId, width: dimensions.width, height: dimensions.height, blank: false },
  elements: [],
});
const clickEnvelope = (pid) => ({
  operation: "workspace_click",
  effect: "confirmed",
  route: "accessibility_action",
  classification: "BACKGROUND_SAFE",
  mode: "AGENT_WORKSPACE",
  target: { pid, role: "AXButton", strategy: "role_label", matches: 1 },
  element_center: { x: 1024, y: 400 },
  zero_steal: {
    kind: "zero_steal",
    frontmost_before: 971,
    frontmost_after: 971,
    frontmost_unchanged: true,
    cursor_before: { x: 645.4, y: 654.6 },
    cursor_after: { x: 645.4, y: 654.6 },
    cursor_unchanged: true,
  },
});
const refusedEnvelope = (code) => ({
  operation: "workspace_click",
  effect: "refused",
  route: "none",
  classification: "BACKGROUND_SAFE",
  mode: "AGENT_WORKSPACE",
  code,
  evidence: [],
});

function backendWith(script) {
  // script: array of responses in dispatch order; records calls.
  const calls = [];
  let index = 0;
  const execute = async (input) => {
    calls.push(input);
    const next = script[Math.min(index, script.length - 1)];
    index += 1;
    return typeof next === "function" ? next(input) : next;
  };
  const backend = createAgentWorkspaceBackend({ execute });
  return { backend, calls };
}

describe("frame contract and backend identity", () => {
  it("stamps frames with workspace and backend identity", async () => {
    const { backend } = backendWith([observeEnvelope("FRAME-1", 4242)]);
    await backend.perform("observe", { pid: 4242 }, LOCAL);
    const snap = backend.projectionSnapshot();
    assert.equal(snap.backendId, "agent-workspace");
    assert.equal(snap.workspaceId, "workspace:agent-workspace");
    assert.equal(snap.frame.frameId, "FRAME-1");
    assert.equal(snap.frame.workspaceId, snap.workspaceId);
    assert.equal(snap.frame.backendId, "agent-workspace", "frames must identify their producer");
    assert.deepEqual(snap.frame.dimensions, { width: 480, height: 300 });
    assert.equal(snap.frame.freshness, "fresh");
    assert.equal(snap.framesCaptured, 1);
  });

  it("keeps native frames distinguishable from workspace frames", async () => {
    const { backend } = backendWith([observeEnvelope("FRAME-1", 4242)]);
    await backend.perform("observe", { pid: 4242 }, LOCAL);
    assert.notEqual(backend.projectionSnapshot().frame.backendId, "native-mac");
    assert.notEqual(backend.capabilities.id, "native-mac");
  });
});

describe("capture discipline (UI polling creates zero captures)", () => {
  it("reading the projection never captures and never executes anything", async () => {
    const { backend, calls } = backendWith([observeEnvelope("FRAME-1", 4242)]);
    await backend.perform("observe", { pid: 4242 }, LOCAL);
    const afterFirst = calls.length;
    for (let i = 0; i < 200; i += 1) {
      const snap = backend.projectionSnapshot();
      assert.equal(snap.frame.frameId, "FRAME-1");
    }
    assert.equal(calls.length, afterFirst, "UI-style polling must not trigger any backend call");
    assert.equal(backend.projectionSnapshot().framesCaptured, 1);
  });

  it("only real observations add frames", async () => {
    const { backend, calls } = backendWith([
      observeEnvelope("FRAME-1", 4242),
      clickEnvelope(4242),
      observeEnvelope("FRAME-2", 4242),
    ]);
    await backend.perform("observe", { pid: 4242 }, LOCAL);
    await backend.perform("workspace_click", { pid: 4242, target_role: "AXButton", target_label: "Increment" }, LOCAL);
    assert.equal(backend.projectionSnapshot().framesCaptured, 1, "actions do not fabricate frames");
    await backend.perform("observe", { pid: 4242 }, LOCAL);
    const snap = backend.projectionSnapshot();
    assert.equal(snap.framesCaptured, 2);
    assert.equal(snap.frame.frameId, "FRAME-2");
    assert.equal(snap.frame.freshness, "fresh");
    assert.equal(calls.length, 3);
  });
});

describe("logical cursor (display-only)", () => {
  it("updates from the element the Helper resolved, with the target attached", async () => {
    const { backend } = backendWith([observeEnvelope("FRAME-1", 4242), clickEnvelope(4242)]);
    await backend.perform("observe", { pid: 4242, app_name: "WorkspaceFixture" }, LOCAL);
    await backend.perform("workspace_click", { pid: 4242, app_name: "WorkspaceFixture", target_role: "AXButton", target_label: "Increment" }, LOCAL);
    const cursor = backend.projectionSnapshot().cursor;
    assert.equal(cursor.x, 1024);
    assert.equal(cursor.y, 400);
    assert.equal(cursor.target.pid, 4242);
    assert.ok(Number.isFinite(cursor.updatedAt));
  });

  it("never appears without a pointer action and never touches any OS cursor API", async () => {
    const { backend } = backendWith([observeEnvelope("FRAME-1", 4242)]);
    await backend.perform("observe", { pid: 4242 }, LOCAL);
    assert.equal(backend.projectionSnapshot().cursor, null, "observation alone must not invent a cursor");
  });
});

describe("action projection", () => {
  it("describes the current action truthfully", async () => {
    const { backend } = backendWith([observeEnvelope("FRAME-1", 4242)]);
    await backend.perform("observe", { pid: 4242, app_name: "WorkspaceFixture" }, LOCAL);
    const action = backend.projectionSnapshot().action;
    assert.equal(action.method, "observe");
    assert.equal(action.label, "Observing");
    assert.equal(action.targetLabel, "WorkspaceFixture");
    assert.equal(action.effect, "confirmed");
  });

  it("labels clicks and typing for the mini view", async () => {
    const { backend } = backendWith([clickEnvelope(4242)]);
    await backend.perform("workspace_click", { pid: 4242, app_name: "WorkspaceFixture", target_role: "AXButton", target_label: "Increment" }, LOCAL);
    const action = backend.projectionSnapshot().action;
    assert.equal(action.label, "Clicking");
    assert.equal(action.effect, "confirmed");
    assert.equal(action.code, null);
  });
});

describe("state model", () => {
  it("never fabricates exclusive/lease state for workspace routes", async () => {
    const { backend } = backendWith([observeEnvelope("FRAME-1", 4242), clickEnvelope(4242)]);
    await backend.perform("observe", { pid: 4242 }, LOCAL);
    await backend.perform("workspace_click", { pid: 4242, target_role: "AXButton", target_label: "Increment" }, LOCAL);
    const snap = backend.projectionSnapshot();
    assert.ok(WORKSPACE_STATES.includes(snap.state));
    const serialized = JSON.stringify(snap);
    assert.ok(!serialized.includes("EXCLUSIVE"), "workspace state must never mention exclusive takeover");
    assert.ok(!serialized.includes("lease"), "workspace projection carries no lease concepts");
  });

  it("supersedes the frame after a mutation instead of keeping it fresh", async () => {
    const { backend } = backendWith([observeEnvelope("FRAME-1", 4242), clickEnvelope(4242)]);
    await backend.perform("observe", { pid: 4242 }, LOCAL);
    await backend.perform("workspace_click", { pid: 4242, target_role: "AXButton", target_label: "Increment" }, LOCAL);
    assert.equal(backend.projectionSnapshot().frame.freshness, "superseded");
  });

  it("reports stale on target_lost and paused on admission refusal", async () => {
    const { backend: stale } = backendWith([refusedEnvelope("target_lost")]);
    await stale.perform("workspace_click", { pid: 4242, target_role: "AXButton", target_label: "Increment" }, LOCAL);
    assert.equal(stale.projectionSnapshot().state, "stale");
    const { backend: paused } = backendWith([refusedEnvelope("paused")]);
    await paused.perform("workspace_click", { pid: 4242, target_role: "AXButton", target_label: "Increment" }, LOCAL);
    assert.equal(paused.projectionSnapshot().state, "paused");
  });

  it("keeps unverified typing as unknown — never promoted to confirmed", async () => {
    const unverified = {
      operation: "workspace_type_text",
      effect: "unknown",
      route: "quartz_input",
      classification: "BACKGROUND_SAFE",
      mode: "AGENT_WORKSPACE",
      input_delivery: "confirmed",
      verification: "unverified",
    };
    const { backend } = backendWith([unverified]);
    await backend.perform("workspace_type_text", { pid: 4242, text: "hi" }, LOCAL);
    const action = backend.projectionSnapshot().action;
    assert.equal(action.effect, "unknown");
    assert.notEqual(action.effect, "confirmed");
    assert.equal(backend.projectionSnapshot().state, "failed");
  });
});

describe("target fencing (A -> B)", () => {
  it("resets frame, cursor and action when the target switches", async () => {
    const { backend } = backendWith([
      observeEnvelope("FRAME-A", 1111),
      clickEnvelope(1111),
      observeEnvelope("FRAME-B", 2222),
    ]);
    await backend.perform("observe", { pid: 1111, app_name: "AppA" }, LOCAL);
    await backend.perform("workspace_click", { pid: 1111, app_name: "AppA", target_role: "AXButton", target_label: "Go" }, LOCAL);
    assert.equal(backend.projectionSnapshot().cursor.x, 1024);
    await backend.perform("observe", { pid: 2222, app_name: "AppB" }, LOCAL);
    const snap = backend.projectionSnapshot();
    assert.equal(snap.target.pid, 2222);
    assert.equal(snap.frame.frameId, "FRAME-B", "no frame leakage across targets");
    assert.equal(snap.cursor, null, "the old target's logical cursor must not float over the new target");
    assert.equal(snap.action.targetLabel, "AppB");
  });

  it("keeps separate projections for separate workspaces", async () => {
    const a = createWorkspaceProjection({ workspaceId: "ws:task-a", sessionId: "s", taskId: "task-a" });
    const b = createWorkspaceProjection({ workspaceId: "ws:task-b", sessionId: "s", taskId: "task-b" });
    a.noteObservation({ target: { pid: 1, windowId: null, appName: "A" }, result: observeEnvelope("F-A", 1) });
    assert.equal(b.snapshot().frame, null);
    assert.equal(a.snapshot().workspaceId, "ws:task-a");
    assert.equal(b.snapshot().workspaceId, "ws:task-b");
  });
});

describe("zero-steal carried forward", () => {
  it("records the Helper's zero-steal evidence on the projection", async () => {
    const { backend } = backendWith([clickEnvelope(4242)]);
    await backend.perform("workspace_click", { pid: 4242, target_role: "AXButton", target_label: "Increment" }, LOCAL);
    const zs = backend.projectionSnapshot().lastZeroSteal;
    assert.equal(zs.frontmost_unchanged, true);
    assert.equal(zs.cursor_unchanged, true);
  });
});

describe("projection purity and lifecycle", () => {
  it("snapshot returns a detached copy (UI cannot mutate backend truth)", async () => {
    const { backend } = backendWith([observeEnvelope("FRAME-1", 4242)]);
    await backend.perform("observe", { pid: 4242 }, LOCAL);
    const snap = backend.projectionSnapshot();
    snap.frame.frameId = "MUTATED";
    snap.state = "acting";
    const again = backend.projectionSnapshot();
    assert.equal(again.frame.frameId, "FRAME-1");
    assert.equal(again.state, "idle");
  });

  it("requires a workspace id", () => {
    assert.throws(() => createWorkspaceProjection({}), /workspaceId/u);
  });

  it("marking pause is explicit and reversible", () => {
    const projection = createWorkspaceProjection({ workspaceId: "ws:1" });
    projection.notePaused(true);
    assert.equal(projection.snapshot().state, "paused");
    projection.notePaused(false);
    assert.equal(projection.snapshot().state, "idle");
  });
});
