// M3: the lease authority's host-maintained mini Computer projection.
//
// Deterministic fakes only — no Helper, no socket, no capture. Covers: workspace methods
// (observe / workspace_click / workspace_type_text) feed the projection; native-only
// methods never create a workspace view; a confirmed mutation supersedes the frame; pause
// is a real boundary; session isolation; and the read is pure (UI polling never captures).
import assert from "node:assert/strict";
import test from "node:test";

import { createLeaseAuthority } from "../src/cua-permission-broker/lease-authority/authority.js";
import { describeComputerUseSession } from "../src/cua-permission-broker/cuaSessionView.js";

let clockNow = 1_000_000;
const tick = (ms = 1) => {
  clockNow += ms;
  return clockNow;
};

function report(overrides: {
  session?: string;
  method: string;
  phase: "started" | "completed";
  callId?: string;
  effect?: string;
  code?: string;
  target?: { pid: number; app?: string; windowId?: number };
  observation?: { id: string; width?: number; height?: number };
  workspaceCursor?: { x: number; y: number };
}) {
  return {
    session: overrides.session ?? "session-a",
    task: "task-1",
    callId: overrides.callId ?? `call-${clockNow}`,
    phase: overrides.phase,
    method: overrides.method,
    at: tick(),
    ...(overrides.effect ? { effect: overrides.effect } : {}),
    ...(overrides.code ? { code: overrides.code } : {}),
    ...(overrides.target ? { target: overrides.target } : {}),
    ...(overrides.observation ? { observation: overrides.observation } : {}),
    ...(overrides.workspaceCursor ? { workspaceCursor: overrides.workspaceCursor } : {}),
  };
}

function newAuthority() {
  clockNow = 1_000_000;
  return createLeaseAuthority({ now: () => clockNow });
}

test("observe creates a fresh frame; framesCaptured counts real observations only", () => {
  const authority = newAuthority();
  authority.reportActivity(report({ method: "observe", phase: "started", callId: "c1" }));
  authority.reportActivity(
    report({
      method: "observe",
      phase: "completed",
      callId: "c1",
      observation: { id: "OBS-1", width: 800, height: 600 },
      target: { pid: 42, app: "WorkspaceFixture" },
    }),
  );
  const view = authority.getWorkspace("session-a");
  assert.ok(view);
  assert.equal(view.state, "idle");
  assert.equal(view.framesCaptured, 1);
  assert.equal(view.frame?.frameId, "OBS-1");
  assert.equal(view.frame?.freshness, "fresh");
  assert.equal(view.frame?.dimensions?.width, 800);
  assert.equal(view.target?.pid, 42);
  assert.equal(view.target?.appName, "WorkspaceFixture");
});

test("workspace click notes the action, the logical cursor, and supersedes the frame", () => {
  const authority = newAuthority();
  authority.reportActivity(
    report({
      method: "observe",
      phase: "completed",
      callId: "c1",
      observation: { id: "OBS-1" },
      target: { pid: 42, app: "WorkspaceFixture" },
    }),
  );
  authority.reportActivity(
    report({
      method: "workspace_click",
      phase: "started",
      callId: "c2",
      target: { pid: 42, app: "WorkspaceFixture" },
    }),
  );
  assert.equal(authority.getWorkspace("session-a")?.state, "acting");
  authority.reportActivity(
    report({
      method: "workspace_click",
      phase: "completed",
      callId: "c2",
      effect: "confirmed",
      target: { pid: 42, app: "WorkspaceFixture" },
      workspaceCursor: { x: 120, y: 90 },
    }),
  );
  const view = authority.getWorkspace("session-a");
  assert.equal(view?.state, "idle");
  assert.equal(view?.frame?.freshness, "superseded", "a confirmed mutation predates the frame");
  assert.equal(view?.framesCaptured, 1, "mutations never create frames");
  assert.equal(view?.cursor?.x, 120);
  assert.equal(view?.cursor?.y, 90);
  assert.equal(view?.action?.method, "workspace_click");
  assert.equal(view?.action?.effect, "confirmed");
});

test("a refused workspace type reports failed truthfully", () => {
  const authority = newAuthority();
  authority.reportActivity(
    report({
      method: "workspace_type_text",
      phase: "completed",
      callId: "c1",
      effect: "refused",
      code: "ambiguous_target",
      target: { pid: 7 },
    }),
  );
  const view = authority.getWorkspace("session-a");
  assert.equal(view?.state, "failed");
  assert.equal(view?.action?.code, "ambiguous_target");
});

test("native-only methods never create a workspace view", () => {
  const authority = newAuthority();
  authority.reportActivity(
    report({ method: "acquire_control", phase: "completed", effect: "confirmed" }),
  );
  authority.reportActivity(report({ method: "press", phase: "completed", effect: "confirmed" }));
  assert.equal(authority.getWorkspace("session-a"), undefined);
});

test("pause is a real boundary: the projection enters paused and resume lifts it", async () => {
  const authority = newAuthority();
  authority.reportActivity(
    report({ method: "observe", phase: "completed", callId: "c1", observation: { id: "OBS-1" } }),
  );
  await authority.pause();
  assert.equal(authority.getWorkspace("session-a")?.state, "paused");
  await authority.resume();
  assert.equal(authority.getWorkspace("session-a")?.state, "idle");
});

test("session isolation: another session's workspace is never returned", () => {
  const authority = newAuthority();
  authority.reportActivity(
    report({
      session: "session-a",
      method: "observe",
      phase: "completed",
      callId: "c1",
      observation: { id: "OBS-A" },
      target: { pid: 1, app: "A" },
    }),
  );
  authority.reportActivity(
    report({
      session: "session-b",
      method: "observe",
      phase: "completed",
      callId: "c2",
      observation: { id: "OBS-B" },
      target: { pid: 2, app: "B" },
    }),
  );
  assert.equal(authority.getWorkspace("session-a")?.frame?.frameId, "OBS-A");
  assert.equal(authority.getWorkspace("session-b")?.frame?.frameId, "OBS-B");
});

test("the read is pure: snapshot mutations never leak and reads never capture", () => {
  const authority = newAuthority();
  authority.reportActivity(
    report({
      method: "observe",
      phase: "completed",
      callId: "c1",
      observation: { id: "OBS-1" },
      target: { pid: 42 },
    }),
  );
  const first = authority.getWorkspace("session-a");
  const second = authority.getWorkspace("session-a");
  assert.deepEqual(first, second);
  if (first?.frame) first.frame.frameId = "TAMPERED";
  if (first) first.framesCaptured = 999;
  assert.equal(authority.getWorkspace("session-a")?.frame?.frameId, "OBS-1");
  assert.equal(authority.getWorkspace("session-a")?.framesCaptured, 1);
});

test("the session view carries the owning session's workspace projection", async () => {
  const authority = newAuthority();
  authority.reportActivity(
    report({
      method: "observe",
      phase: "completed",
      callId: "c1",
      observation: { id: "OBS-1" },
      target: { pid: 42, app: "WorkspaceFixture" },
    }),
  );
  const view = await describeComputerUseSession(
    { authority, host: undefined, workspace: authority },
    "session-a",
  );
  assert.equal(view.present, true);
  assert.equal(view.present ? view.workspace?.frame?.frameId : undefined, "OBS-1");
  assert.equal(view.present ? view.workspace?.target?.app : undefined, "WorkspaceFixture");
  // 另一会话读不到（present:false 即无任何事实外泄）。
  const other = await describeComputerUseSession(
    { authority, host: undefined, workspace: authority },
    "session-unknown",
  );
  assert.equal(other.present, false);
});

test("semantic press/set_value drive the target and logical cursor; a new target fences the old cursor", () => {
  const authority = newAuthority();
  authority.reportActivity(
    report({
      method: "observe",
      phase: "completed",
      callId: "c1",
      observation: { id: "OBS-1" },
      target: { pid: 95733, app: "Google Chrome" },
    }),
  );
  authority.reportActivity(report({ method: "press", phase: "started", callId: "c2" }));
  authority.reportActivity(
    report({
      method: "press",
      phase: "completed",
      callId: "c2",
      effect: "unknown",
      target: { pid: 95733, app: "Google Chrome" },
      workspaceCursor: { x: 616, y: 53 },
    }),
  );
  let view = authority.getWorkspace("session-a");
  assert.equal(view?.action?.method, "press");
  assert.deepEqual([view?.cursor?.x, view?.cursor?.y], [616, 53]);
  // Chrome → Notes：set_value 在新 pid 上，旧目标的光标被清掉后再写新光标。
  authority.reportActivity(
    report({
      method: "set_value",
      phase: "completed",
      callId: "c3",
      effect: "confirmed",
      target: { pid: 25548, app: "Notes" },
      workspaceCursor: { x: 900, y: 400 },
    }),
  );
  view = authority.getWorkspace("session-a");
  assert.equal(view?.target?.pid, 25548);
  assert.equal(view?.target?.appName, "Notes");
  assert.deepEqual([view?.cursor?.x, view?.cursor?.y], [900, 400]);
});
