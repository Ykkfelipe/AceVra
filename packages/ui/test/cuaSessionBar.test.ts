/**
 * CUA-4 UI: the pure session projection (every user-facing state), the stop-confirmation
 * decision, the poll/frame token fences, and the Computer Use bar render. Deterministic fakes
 * only — no Accessibility/Screen Recording permission, no Helper, no real service.
 *
 * Run: TSX_TSCONFIG_PATH=packages/ui/tsconfig.json mise exec -- node --import tsx --test packages/ui/test/cuaSessionBar.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CuaComputerUseSessionView } from "@zcode/services";
import { register } from "node:module";
import { TID_V4_COMPUTER_USE_BAR } from "@zcode/shared";

register("./uiAssetStubLoader.mjs", import.meta.url);

const { projectComputerUseBar, resolveComputerUseShownState, stopConfirmed } =
  await import("../src/lib/cuaSessionProjection.js");
const { createTokenFence, shouldFetchObservation } =
  await import("../src/hooks/useComputerUseSession.js");

const NOW = 1_000_000;
const TURN_ID = "turn-1";

function sessionView(overrides: {
  activity?: Partial<
    NonNullable<Extract<CuaComputerUseSessionView, { present: true }>>["activity"]
  > & {
    method: string;
    phase: "started" | "completed";
  };
  observation?: Partial<
    NonNullable<Extract<CuaComputerUseSessionView, { present: true }>>["observation"]
  > & { id: string; capturedAt: number };
  lease?: Partial<Extract<CuaComputerUseSessionView, { present: true }>["lease"]>;
  paused?: boolean;
  stopMeaningful?: boolean;
}): CuaComputerUseSessionView {
  const activity = overrides.activity
    ? {
        callId: "call-1",
        task: TURN_ID,
        startedAt: NOW - 5_000,
        ...overrides.activity,
      }
    : undefined;
  const observation = overrides.observation
    ? {
        capturedAt: NOW - 1_000,
        ...overrides.observation,
      }
    : undefined;
  return {
    present: true,
    sessionId: "session-a",
    paused: overrides.paused === true,
    ...(observation ? { observation } : {}),
    stopMeaningful: overrides.stopMeaningful === true,
    lease: {
      state: "inactive",
      termination: overrides.lease?.termination,
      ...overrides.lease,
    },
    ...(activity ? { activity } : {}),
  } as CuaComputerUseSessionView;
}

function project(
  session: CuaComputerUseSessionView | null,
  input: {
    turnRunning?: boolean;
    pending?: "pause" | "resume" | "stop" | null;
    now?: number;
    currentTurnId?: string | null;
  } = {},
) {
  return projectComputerUseBar({
    session,
    turnRunning: input.turnRunning === true,
    pending: input.pending ?? null,
    now: input.now ?? NOW,
    ...(input.currentTurnId !== undefined ? { currentTurnId: input.currentTurnId } : {}),
  });
}

test("inactive session means no bar at all", () => {
  assert.equal(project(null).visible, false);
  assert.equal(project({ present: false }).visible, false);
  assert.equal(project(sessionView({})).visible, false, "facts-less present view is not shown");
});

test("observing is NOT safety-relevant: no native takeover, no large bar", () => {
  const view = project(
    sessionView({
      activity: { method: "observe", phase: "completed", effect: "confirmed" },
      observation: { id: "obs-1", capturedAt: NOW - 1_000 },
    }),
    { turnRunning: true },
  );
  // 大 ComputerUseBar 是「真实桌面接管」的安全面；observe/get_app_state 不触发它，
  // 由 MiniComputerPanel 呈现。规则：无原生前台接管 → 无大 bar。
  assert.equal(view.visible, false);
  assert.equal(view.state, "observing");
  assert.equal(view.mode, "observe");
  assert.equal(view.observationStale, false);
  assert.equal(view.effectUnverified, false);
});

test("work in the background workspace is NOT safety-relevant: no large bar", () => {
  const workspaceAction = project(
    sessionView({
      activity: { method: "workspace_type_text", phase: "started" },
      observation: { id: "obs-1", capturedAt: NOW - 1_000 },
    }),
    { turnRunning: true },
  );
  // 后台 workspace 动作（含 get_app_state / observe / screenshot）由 MiniComputerPanel
  // 呈现，绝不当成原生前台接管渲染大 bar。
  assert.equal(workspaceAction.visible, false);
  assert.equal(workspaceAction.state, "observing"); // workspace 动作非前台 → 观察系
});

test("native reserving/active is the ONLY thing that raises the safety bar", () => {
  const reserving = project(
    sessionView({ activity: { method: "acquire_control", phase: "started" } }),
    { turnRunning: true },
  );
  assert.equal(reserving.state, "waitingForForeground");
  assert.equal(
    reserving.visible,
    true,
    "reserving native foreground is chosen by the model; show the safety surface",
  );
  const active = project(
    sessionView({
      activity: { method: "click", phase: "started" },
      lease: { state: "active", leaseId: "lease-1" },
    }),
    { turnRunning: true },
  );
  assert.equal(active.visible, true, "an exclusive native lease always shows the safety bar");
  // 后台动作从不成全 bar。
  const bg = project(sessionView({ activity: { method: "set_value", phase: "started" } }), {
    turnRunning: true,
  });
  assert.equal(bg.visible, false, "background semantic actions never raise the safety bar");
});

test("background-safe action is its own state and never reads as foreground", () => {
  const started = project(sessionView({ activity: { method: "press", phase: "started" } }), {
    turnRunning: true,
  });
  assert.equal(started.state, "backgroundAction");
  assert.equal(started.mode, "background");
  assert.equal(started.visible, false, "a background action does not raise the safety bar");
  const completed = project(
    sessionView({
      activity: {
        method: "press",
        phase: "completed",
        effect: "unknown",
        applicationEffect: "unknown",
      },
    }),
    { turnRunning: true },
  );
  assert.equal(completed.state, "backgroundAction");
  assert.equal(completed.effectUnverified, true, "unknown effect is flagged, never success");
});

test("acquire in flight waits for foreground; an active lease means exclusive foreground", () => {
  const waiting = project(
    sessionView({ activity: { method: "acquire_control", phase: "started" } }),
    { turnRunning: true },
  );
  assert.equal(waiting.state, "waitingForForeground");
  const exclusive = project(
    sessionView({
      activity: { method: "click", phase: "started" },
      lease: { state: "active", leaseId: "lease-1" },
    }),
    { turnRunning: true },
  );
  assert.equal(exclusive.state, "exclusiveActive");
  assert.equal(exclusive.visible, true);
  assert.equal(exclusive.stopMeaningful, true);
});

test("physical-input yield is shown as control returned to the user and never auto-reacquired", () => {
  const view = project(
    sessionView({
      lease: {
        state: "released",
        termination: { leaseId: "lease-1", reason: "interrupted", at: NOW },
      },
      activity: { method: "click", phase: "completed", effect: "refused", code: "interrupted" },
      observation: { id: "obs-1", capturedAt: NOW - 2_000 },
    }),
    { turnRunning: true },
  );
  assert.equal(view.state, "yieldedToUser");
  assert.equal(view.visible, true);
  assert.equal(view.terminationReason, "interrupted");
  assert.equal(view.pauseAvailable, true);
});

test("paused comes from the authority admission; resume reopens admission only", () => {
  // 没有原生前台接管时，暂停也不渲染大 bar（后台 pause 由 MiniComputerPanel 呈现）。
  const paused = project(sessionView({ paused: true }), { turnRunning: false });
  assert.equal(paused.state, "paused");
  assert.equal(paused.visible, false, "no takeover → no safety bar, even while paused");
  assert.equal(paused.pauseAvailable, false, "the button flips to Resume");
  // 暂停一段原生接管则是安全场景 → 大 bar 保留。
  const takeoverPaused = project(
    sessionView({
      paused: true,
      activity: { method: "click", phase: "started" },
      lease: { state: "active", leaseId: "lease-1" },
    }),
    { turnRunning: false },
  );
  assert.equal(takeoverPaused.state, "paused");
  assert.equal(takeoverPaused.visible, true, "pausing an active takeover keeps the safety surface");
  // After resume the view is no longer paused and never claims an active operation.
  const resumed = project(sessionView({ paused: false }), { turnRunning: false });
  assert.equal(resumed.state, "idle");
  assert.equal(resumed.pauseAvailable, true);
  assert.equal(resumed.visible, false, "resume alone must not fake an active operation");
});

test("stopping is transient; stopped requires the authority and the turn to settle", () => {
  const view = project(sessionView({ stopMeaningful: true }), {
    pending: "stop",
    turnRunning: true,
  });
  assert.equal(view.state, "stopping");
  assert.equal(view.stopMeaningful, true);
  // The authority reports stopped and the turn ended.
  const stopped = sessionView({
    lease: { state: "stopped", termination: { leaseId: "l", reason: "stopped", at: NOW } },
  });
  const settled = project(stopped, { turnRunning: false });
  assert.equal(settled.state, "stopped");
  assert.equal(settled.visible, true, "the stop outcome of this turn stays visible");
  assert.equal(stopConfirmed(settled.state, false), true);
  assert.equal(stopConfirmed("stopped", true), false, "a running turn is not yet stopped");
  // A stopped click alone (pending) never reports stopped.
  assert.equal(resolveComputerUseShownState("exclusiveActive", true, false), "stopping");
  assert.equal(resolveComputerUseShownState("stopped", true, false), "stopped");
});

test("failed outcome and unknown results are shown, not success", () => {
  const view = project(
    sessionView({
      activity: {
        method: "click",
        phase: "completed",
        effect: "failed",
        code: "helper_unavailable",
      },
    }),
    { turnRunning: true },
  );
  assert.equal(view.state, "failed");
  assert.equal(view.visible, true);
  assert.equal(view.lastCode, "helper_unavailable");
});

test("stale observation: age, later actions, and ended control all mark it stale", () => {
  const old = project(
    sessionView({
      activity: { method: "observe", phase: "completed", effect: "confirmed" },
      observation: { id: "obs-1", capturedAt: NOW - 31_000 },
    }),
    { turnRunning: true },
  );
  assert.equal(old.observationStale, true);
  const actionAfter = project(
    sessionView({
      activity: { method: "press", phase: "completed", effect: "confirmed", completedAt: NOW },
      observation: { id: "obs-1", capturedAt: NOW - 5_000 },
    }),
    { turnRunning: true },
  );
  assert.equal(actionAfter.observationStale, true);
  const fresh = project(
    sessionView({
      activity: { method: "observe", phase: "completed", effect: "confirmed" },
      observation: { id: "obs-1", capturedAt: NOW - 2_000 },
    }),
    { turnRunning: true },
  );
  assert.equal(fresh.observationStale, false);
});

test("target naming: app only, app + window, and disappearing target", () => {
  const appOnly = project(
    sessionView({
      activity: { method: "observe", phase: "completed", effect: "confirmed" },
      observation: { id: "obs-1", capturedAt: NOW - 1_000, target: { pid: 101, app: "Notes" } },
    }),
    { turnRunning: true },
  );
  assert.equal(appOnly.targetApp, "Notes");
  assert.equal(appOnly.targetWindow, null);
  const appAndWindow = project(
    sessionView({
      activity: { method: "observe", phase: "completed", effect: "confirmed" },
      observation: {
        id: "obs-1",
        capturedAt: NOW - 1_000,
        target: { pid: 101, app: "Notes", window: "Shopping list" },
      },
    }),
    { turnRunning: true },
  );
  assert.equal(appAndWindow.targetApp, "Notes");
  assert.equal(appAndWindow.targetWindow, "Shopping list");
  // Target disappears: an observation without a target leaves both empty.
  const gone = project(
    sessionView({
      activity: { method: "observe", phase: "completed", effect: "confirmed" },
      observation: { id: "obs-2", capturedAt: NOW - 1_000 },
    }),
    { turnRunning: true },
  );
  assert.equal(gone.targetApp, null);
  assert.equal(gone.targetWindow, null);
});

test("an outcome of a previous turn is not shown for the current conversation", () => {
  const view = project(
    sessionView({
      lease: { state: "stopped", termination: { leaseId: "l", reason: "stopped", at: NOW } },
      activity: { method: "observe", phase: "completed", effect: "confirmed", task: "turn-0" },
    }),
    { turnRunning: false, currentTurnId: "turn-2" },
  );
  assert.equal(view.visible, false);
});

test("token fence drops late responses from previous tasks", () => {
  const fence = createTokenFence();
  const first = fence.next();
  assert.equal(fence.isCurrent(first), true);
  fence.next(); // a newer poll started
  assert.equal(fence.isCurrent(first), false, "the superseded poll is ignored");
  const taskIdA = fence.next();
  fence.invalidate(); // task switch
  assert.equal(fence.isCurrent(taskIdA), false, "a late response from a prior task is ignored");
});

test("bar buttons write through the real service operations; stop composes both truths", async () => {
  const { readFile } = await import("node:fs/promises");
  const hookSource = await readFile(
    new URL("../src/hooks/useComputerUseSession.js", import.meta.url),
    "utf8",
  ).catch(() => "");
  const hookSourceTs = hookSource
    ? hookSource
    : await readFile(new URL("../src/hooks/useComputerUseSession.ts", import.meta.url), "utf8");
  assert.match(hookSourceTs, /pauseComputerUse\(\)/u, "Pause writes through pauseComputerUse");
  assert.match(hookSourceTs, /resumeComputerUse\(\)/u, "Resume writes through resumeComputerUse");
  assert.match(
    hookSourceTs,
    /stopComputerControl\(\)/u,
    "Stop reuses the existing service operation",
  );
  const barSource = await readFile(
    new URL("../src/v4/composer/ComputerUseBar.tsx", import.meta.url),
    "utf8",
  );
  assert.match(barSource, /onStop\(\);/u, "Stop also fires the conversation turn stop command");
});

test("preview is fetched once per observation id and re-fetched for a new one", () => {
  assert.equal(shouldFetchObservation(null, "obs-1"), true);
  assert.equal(shouldFetchObservation("obs-1", "obs-1"), false, "no refetch for the same frame");
  assert.equal(shouldFetchObservation("obs-1", "obs-2"), true);
  assert.equal(shouldFetchObservation("obs-1", null), false);
});

// ---------------------------------------------------------------------------
// Render tests (static markup): what the user actually sees per state.
// ---------------------------------------------------------------------------

const { ComputerUseBar, ComputerUseBarMounted } =
  await import("../src/v4/composer/ComputerUseBar.js");
const { ZCodeIntlProvider } = await import("../src/i18n/IntlProvider.js");
const enUS = (await import("../src/i18n/locales/en-US.js")).default;

function fakeSessionResult(overrides: {
  view: Partial<ReturnType<typeof projectComputerUseBar>>;
  preview?: { status: "idle" | "loading" | "available" | "unavailable"; dataUrl?: string };
  pending?: "pause" | "resume" | "stop" | null;
  calls?: string[];
}): Record<string, unknown> {
  const calls = overrides.calls ?? [];
  return {
    session: null,
    view: {
      visible: true,
      state: "observing",
      mode: "observe",
      targetApp: null,
      targetWindow: null,
      targetStale: false,
      observation: null,
      observationStale: false,
      effectUnverified: false,
      lastCode: null,
      terminationReason: null,
      pauseAvailable: true,
      stopMeaningful: true,
      ...overrides.view,
    },
    preview: overrides.preview ?? { status: "idle" },
    pending: overrides.pending ?? null,
    pause: () => calls.push("pause"),
    resume: () => calls.push("resume"),
    stopComputerControl: () => calls.push("stopControl"),
  };
}

function renderBar(sessionResult: Record<string, unknown>, turnRunning = false): string {
  return renderToStaticMarkup(
    React.createElement(
      ZCodeIntlProvider,
      { locale: "en-US", messages: enUS },
      React.createElement(ComputerUseBarMounted, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        session: sessionResult as any,
        turnRunning,
        onStop: () => undefined,
      }),
    ),
  );
}

test("bar render: no bar for plain chat", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      ZCodeIntlProvider,
      { locale: "en-US", messages: enUS },
      // M3：bar 与 mini Computer 面板共享 composer 提升的同一份轮询结果（session prop）。
      React.createElement(ComputerUseBar, {
        session: { view: { visible: false } },
        turnRunning: false,
        onStop: () => undefined,
      }),
    ),
  );
  assert.equal(html.includes(TID_V4_COMPUTER_USE_BAR), false);
});

test("bar render: observing with target app + window and a fresh snapshot", () => {
  const html = renderBar(
    fakeSessionResult({
      view: {
        state: "observing",
        mode: "observe",
        targetApp: "Notes",
        targetWindow: "Shopping list",
        observation: { id: "obs-1", capturedAt: 5, blank: false },
        stopMeaningful: true,
      },
      preview: { status: "available", dataUrl: "data:image/png;base64,QUJD" },
    }),
    true,
  );
  assert.equal(html.includes(TID_V4_COMPUTER_USE_BAR), true);
  assert.equal(html.includes("Computer Use"), true);
  assert.equal(html.includes("Notes — Shopping list"), true);
  assert.equal(html.includes("Observing"), true);
  assert.equal(html.includes("data:image/png;base64,QUJD"), true, "the real snapshot bytes render");
  assert.equal(html.includes("Pause"), true);
  assert.equal(html.includes("Stop"), true, "Stop shows while the turn runs");
});

test("bar render: yield shows the returned-control notice; paused shows Resume", () => {
  const yielded = renderBar(
    fakeSessionResult({
      view: { state: "yieldedToUser", terminationReason: "interrupted" },
    }),
  );
  assert.equal(yielded.includes("Control returned to you"), true);
  assert.equal(yielded.includes("reclaim control automatically"), true);
  const paused = renderBar(fakeSessionResult({ view: { state: "paused", pauseAvailable: false } }));
  assert.equal(paused.includes("Paused"), true);
  assert.equal(paused.includes("Resume"), true);
});

test("bar render: stale preview is dimmed and labelled; unverified result is flagged", () => {
  const html = renderBar(
    fakeSessionResult({
      view: {
        state: "backgroundAction",
        mode: "background",
        observationStale: true,
        effectUnverified: true,
        observation: { id: "obs-1", capturedAt: 5, blank: false },
      },
      preview: { status: "available", dataUrl: "data:image/png;base64,QUJD" },
    }),
    true,
  );
  assert.equal(html.includes("Stale"), true);
  assert.equal(html.includes("Could not verify the result"), true);
  assert.equal(html.includes("Background action"), true);
});

test("bar render: stopping disables the stop button and keeps the bar visible", () => {
  const html = renderBar(
    fakeSessionResult({
      view: { state: "exclusiveActive", stopMeaningful: true },
      pending: "stop",
    }),
    true,
  );
  assert.equal(html.includes("Stopping…"), true);
  assert.equal(
    html.includes("Controlling (exclusive)"),
    false,
    "stopping supersedes the lease state",
  );
});
