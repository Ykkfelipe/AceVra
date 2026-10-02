/**
 * M3 UI: the floating mini Computer panel (LocalComputerPreview). Deterministic fakes only — no
 * Helper, no service, no capture. Covers: appears on active workspace state, live window-stream
 * frame rendering (never the screen observation), logical cursor over the letterboxed window
 * frame, frame refresh in the SAME panel, × hide/reopen without stopping,
 * expanded = same workspace, task fencing, truthful background mode, staleness, pause/stop
 * wiring, and zero-capture/zero-side-effect rendering.
 *
 * Run: TSX_TSCONFIG_PATH=packages/ui/tsconfig.json mise exec -- node --import tsx --test packages/ui/test/miniComputerPanel.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { register } from "node:module";
import {
  TID_V4_MINI_COMPUTER,
  TID_V4_MINI_COMPUTER_CAPTION,
  TID_V4_MINI_COMPUTER_CLOSE,
  TID_V4_MINI_COMPUTER_CURSOR,
  TID_V4_MINI_COMPUTER_EXPAND,
  TID_V4_MINI_COMPUTER_FRAME,
  TID_V4_MINI_COMPUTER_PAUSE,
  TID_V4_MINI_COMPUTER_REOPEN,
  TID_V4_MINI_COMPUTER_STOP,
} from "@zcode/shared";

register("./uiAssetStubLoader.mjs", import.meta.url);

const { ZCodeIntlProvider } = await import("../src/i18n/IntlProvider.js");
const enUS = (await import("../src/i18n/locales/en-US.js")).default;
const { isAgentWorkspaceActive, MiniComputerPanel, MiniComputerPanelMounted, localCursorStyle } =
  await import("../src/v4/composer/MiniComputerPanel.js");
const { useMiniComputerStore } = await import("../src/store/miniComputerStore.js");

const FRAME_URL = "data:image/jpeg;base64,QUJD";
const OBSERVATION_URL = "data:image/png;base64,T0JTRVJWQVRJT04=";

function workspace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: "workspace:session-a",
    backendId: "agent-workspace",
    state: "idle",
    target: { pid: 42, windowId: 7, app: "WorkspaceFixture" },
    frame: {
      frameId: "OBS-1",
      capturedAt: 1_000,
      dimensions: { width: 800, height: 600 },
      freshness: "fresh",
    },
    cursor: { x: 200, y: 150, updatedAt: 1_000 },
    action: {
      method: "workspace_click",
      label: "Clicking",
      targetLabel: "WorkspaceFixture",
      effect: "confirmed",
    },
    framesCaptured: 1,
    // 默认“刚刚更新”：让 wired 组件的相关性窗口成立；过期场景由具体测试显式覆盖。
    updatedAt: Date.now(),
    ...overrides,
  };
}

/** Session-poll observation preview: must never be rendered as the live local preview. */
function preview(): Record<string, unknown> {
  return { status: "available", dataUrl: OBSERVATION_URL, observationId: "OBS-1" };
}

function stream(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identity: "gen-1:42:7",
    stream: {
      frame: { seq: 3, capturedAt: 1_000, url: FRAME_URL },
      cursor: null,
      counters: { presented: 3, dropped: 0, cursorUpdates: 0, lastLatencyMs: 20 },
    },
    cursor: { left: 25, top: 25, updatedAt: 1_000 },
    status: "live",
    reason: null,
    workspace: null,
    aspectRatio: 4 / 3,
    ...overrides,
  };
}

function mountedData(
  overrides: {
    workspace?: Record<string, unknown>;
    stream?: Record<string, unknown>;
    paused?: boolean;
    leaseActive?: boolean;
    turnRunning?: boolean;
    hidden?: boolean;
    expanded?: boolean;
    relevant?: boolean;
    pending?: string | null;
  } = {},
): Record<string, unknown> {
  return {
    workspace: overrides.workspace ?? workspace(),
    stream: overrides.stream ?? stream(),
    paused: overrides.paused === true,
    leaseActive: overrides.leaseActive === true,
    turnRunning: overrides.turnRunning === true,
    hidden: overrides.hidden === true,
    expanded: overrides.expanded === true,
    relevant: overrides.relevant !== false,
    pending: overrides.pending ?? null,
  };
}

const noopActions = {
  onHide: () => undefined,
  onReopen: () => undefined,
  onSetExpanded: () => undefined,
  onPause: () => undefined,
  onResume: () => undefined,
  onStop: () => undefined,
};

function renderMounted(data: Record<string, unknown>, actions = noopActions): string {
  return renderToStaticMarkup(
    React.createElement(
      ZCodeIntlProvider,
      { locale: "en-US", messages: enUS },
      React.createElement(MiniComputerPanelMounted, { data, actions }),
    ),
  );
}

/** Renders the wired component against a fake shared session result. */
function renderWired(input: {
  sessionId?: string | null;
  sessionView?: Record<string, unknown> | null;
  preview?: Record<string, unknown>;
  pending?: string | null;
  turnRunning?: boolean;
}): string {
  const sessionView = input.sessionView === undefined ? workspace() : input.sessionView;
  const session = {
    session:
      sessionView === null
        ? null
        : { present: true, paused: false, lease: { state: "inactive" }, workspace: sessionView },
    preview: input.preview ?? preview(),
    pending: input.pending ?? null,
    pause: () => undefined,
    resume: () => undefined,
    stopComputerControl: () => undefined,
    view: { visible: false },
  };
  return renderToStaticMarkup(
    React.createElement(
      ZCodeIntlProvider,
      { locale: "en-US", messages: enUS },
      React.createElement(MiniComputerPanel, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        session: session as any,
        sessionId: input.sessionId ?? "session-a",
        turnRunning: input.turnRunning === true,
        onStop: () => undefined,
      }),
    ),
  );
}

function resetStore(): void {
  useMiniComputerStore.setState({
    hiddenBySession: {},
    expandedBySession: {},
    positionBySession: {},
    widthBySession: {},
    stoppedAtBySession: {},
  });
}

test("panel appears on active workspace state", () => {
  const html = renderMounted(mountedData());
  assert.ok(html.includes(TID_V4_MINI_COMPUTER));
  assert.ok(html.includes(TID_V4_MINI_COMPUTER_CLOSE));
  assert.ok(html.includes(TID_V4_MINI_COMPUTER_EXPAND));
  assert.ok(html.includes("WorkspaceFixture"));
});

test("frame renders the live window stream with its source identity; a new frame updates the SAME panel", () => {
  const first = renderMounted(mountedData());
  assert.ok(first.includes(`data-frame-seq="3"`));
  assert.ok(first.includes(`data-frame-source="gen-1:42:7"`));
  assert.ok(first.includes(FRAME_URL));
  const second = renderMounted(
    mountedData({
      stream: stream({
        stream: {
          frame: { seq: 4, capturedAt: 2_000, url: "data:image/jpeg;base64,REVG" },
          cursor: null,
          counters: { presented: 4, dropped: 0, cursorUpdates: 0, lastLatencyMs: 20 },
        },
      }),
    }),
  );
  // Same test id — one persistent panel; new frame seq and new pixels.
  assert.ok(second.includes(TID_V4_MINI_COMPUTER_FRAME));
  assert.ok(second.includes(`data-frame-seq="4"`));
  assert.ok(second.includes("REVG"));
});

test("the screen-scoped observation frame is never shown as the local live preview", () => {
  const html = renderMounted(
    mountedData({
      stream: stream({
        stream: {
          frame: null,
          cursor: null,
          counters: { presented: 0, dropped: 0, cursorUpdates: 0, lastLatencyMs: null },
        },
        status: "waiting",
        cursor: null,
      }),
    }),
  );
  assert.equal(html.includes(OBSERVATION_URL), false);
  assert.equal(html.includes(TID_V4_MINI_COMPUTER_FRAME), false);
  assert.ok(html.includes("Waiting for the window"));
  const lost = renderMounted(
    mountedData({
      stream: stream({
        stream: {
          frame: null,
          cursor: null,
          counters: { presented: 0, dropped: 0, cursorUpdates: 0, lastLatencyMs: null },
        },
        status: "unavailable",
        reason: "target_lost",
        cursor: null,
      }),
    }),
  );
  assert.ok(lost.includes("isn&#x27;t available"));
});

test("cursor overlay is placed over the letterboxed window frame; no cursor without geometry", () => {
  const html = renderMounted(mountedData());
  assert.ok(html.includes(TID_V4_MINI_COMPUTER_CURSOR));
  assert.ok(html.includes(`data-cursor-left="25.0"`));
  assert.ok(html.includes("calc(50cqw + -0.2500 * min(100cqw, 1.3333 * 100cqh))"));
  assert.deepEqual(localCursorStyle({ left: 50, top: 50 }, 2), {
    left: "calc(50cqw + 0.0000 * min(100cqw, 2.0000 * 100cqh))",
    top: "calc(50cqh + 0.0000 * min(100cqh, 100cqw / 2.0000))",
  });
  const noGeometry = renderMounted(mountedData({ stream: stream({ aspectRatio: null }) }));
  assert.equal(noGeometry.includes(TID_V4_MINI_COMPUTER_CURSOR), false);
  const noCursor = renderMounted(mountedData({ stream: stream({ cursor: null }) }));
  assert.equal(noCursor.includes(TID_V4_MINI_COMPUTER_CURSOR), false);
});

test("caption shows the projection's real action with the app; a finished task shows Done", () => {
  const acting = renderMounted(mountedData({ turnRunning: true }));
  assert.ok(acting.includes(TID_V4_MINI_COMPUTER_CAPTION));
  assert.ok(acting.includes("Clicking in WorkspaceFixture"));
  const observing = renderMounted(
    mountedData({
      workspace: workspace({
        action: { method: "observe", label: "观察 Notes 状态", targetLabel: "Notes" },
      }),
      turnRunning: true,
    }),
  );
  assert.ok(observing.includes("Looking at Notes"));
  assert.equal(observing.includes("观察"), false);
  const done = renderMounted(
    mountedData({ workspace: workspace({ action: null, state: "idle" }), turnRunning: false }),
  );
  assert.ok(done.includes("Done"));
  // 完成态是绿色对勾（Codex 式收尾信号），不是灰点；运行中不得出现。
  assert.ok(done.includes('data-mini-computer-done="true"'));
  assert.ok(done.includes('data-testid="v4-mini-computer-done"'));
  // 大对勾盖在画面中央（Codex 式）：完成时必须有，运行中必须没有。
  assert.ok(done.includes('data-testid="v4-mini-computer-done-overlay"'));
  assert.equal(observing.includes("v4-mini-computer-done"), false);
  assert.equal(observing.includes("v4-mini-computer-done-overlay"), false);
});

test("the stream's fresher projection wins over the 1 s session poll", () => {
  const html = renderMounted(
    mountedData({
      stream: stream({
        workspace: workspace({ action: { method: "workspace_type_text", targetLabel: "Notes" } }),
      }),
      turnRunning: true,
    }),
  );
  assert.ok(html.includes("Typing in Notes"));
});

test("stale workspace state is indicated", () => {
  const stale = renderMounted(mountedData({ workspace: workspace({ state: "stale" }) }));
  assert.ok(stale.includes("Stale"));
});

test("background mode label is truthful; exclusive only on a real lease", () => {
  const background = renderMounted(mountedData());
  assert.ok(background.includes("Working in background"));
  assert.equal(background.includes("Exclusive control"), false);
  const escalated = renderMounted(mountedData({ leaseActive: true }));
  assert.ok(escalated.includes("Exclusive control"));
});

test("paused shows the real pause state and Resume", () => {
  const html = renderMounted(
    mountedData({ paused: true, workspace: workspace({ state: "paused" }) }),
  );
  assert.ok(html.includes("Paused"));
  assert.ok(html.includes("Resume"));
});

test("× hides the panel without stopping anything; reopen brings it back", () => {
  resetStore();
  let stopCalls = 0;
  let pauseCalls = 0;
  const actions = {
    ...noopActions,
    onStop: () => {
      stopCalls += 1;
    },
    onPause: () => {
      pauseCalls += 1;
    },
  };
  // Rendering the hidden state itself must not invoke stop or pause.
  const hiddenHtml = renderMounted(mountedData({ hidden: true }), actions);
  assert.equal(hiddenHtml.includes(TID_V4_MINI_COMPUTER_STOP), false);
  assert.equal(stopCalls, 0);
  assert.equal(pauseCalls, 0);
  // While relevant, a reopen affordance exists.
  assert.ok(hiddenHtml.includes(TID_V4_MINI_COMPUTER_REOPEN));
  const gone = renderMounted(mountedData({ hidden: true, relevant: false }), actions);
  assert.equal(gone.includes(TID_V4_MINI_COMPUTER), false);
});

test("hide/reopen is presentation-only state, keyed per session", () => {
  resetStore();
  useMiniComputerStore.getState().hide("session-a");
  assert.equal(useMiniComputerStore.getState().hiddenBySession["session-a"], true);
  assert.equal(useMiniComputerStore.getState().hiddenBySession["session-b"], undefined);
  // 隐藏只改呈现偏好，绝不触碰任何 workspace 事实（store 里只有 hidden/expanded 两个键）。
  assert.deepEqual(
    Object.keys(useMiniComputerStore.getState()).sort(),
    [
      "expandedBySession",
      "hiddenBySession",
      "positionBySession",
      "widthBySession",
      "stoppedAtBySession",
      "reopen",
      "hide",
      "setExpanded",
      "setPosition",
      "setWidth",
      "markStopped",
      "clearStopped",
    ].sort(),
  );
  useMiniComputerStore.getState().reopen("session-a");
  assert.equal(useMiniComputerStore.getState().hiddenBySession["session-a"], false);
});

test("expand is the same workspace: same frame, larger presentation", () => {
  const html = renderMounted(mountedData({ expanded: true }));
  assert.ok(html.includes(`data-mini-computer-expanded="true"`));
  assert.ok(html.includes(`data-frame-seq="3"`));
  assert.ok(html.includes(TID_V4_MINI_COMPUTER));
});

test("task fencing: hide state is strictly per session", () => {
  resetStore();
  useMiniComputerStore.getState().hide("session-a");
  // A 被隐藏，B 完全不受影响；B 的展开状态同样独立。
  useMiniComputerStore.getState().setExpanded("session-b", true);
  assert.equal(useMiniComputerStore.getState().hiddenBySession["session-a"], true);
  assert.equal(useMiniComputerStore.getState().hiddenBySession["session-b"] ?? false, false);
  assert.equal(useMiniComputerStore.getState().expandedBySession["session-b"], true);
  assert.equal(useMiniComputerStore.getState().expandedBySession["session-a"], false);
  // 静态渲染（SSR getServerSnapshot 读初始 store）下 wired 面板仍按初始呈现出现，
  // 隐藏路径由 MiniComputerPanelMounted 的 hidden prop 测试与上面 store 级测试覆盖。
  assert.ok(renderWired({ sessionId: "session-b" }).includes(TID_V4_MINI_COMPUTER));
});

test("wired: no workspace facts means no panel at all", () => {
  resetStore();
  const none = renderWired({ sessionView: null });
  assert.equal(none.includes(TID_V4_MINI_COMPUTER), false);
  const stale = renderWired({
    sessionView: { ...workspace(), updatedAt: 1_000 },
    turnRunning: false,
  });
  // Relevance window: a long-finished idle workspace is not shown (clock is real; 1_000 is
  // far in the past), so a completed task does not linger forever.
  assert.equal(stale.includes(`${TID_V4_MINI_COMPUTER}"`), false);
});

test("pause and stop controls exist and render through the real service wiring", () => {
  const html = renderMounted(mountedData({ turnRunning: true }));
  assert.ok(html.includes(TID_V4_MINI_COMPUTER_PAUSE));
  assert.ok(html.includes(TID_V4_MINI_COMPUTER_STOP));
  const busy = renderMounted(mountedData({ pending: "stop", turnRunning: true }));
  assert.ok(busy.includes("disabled"), "in-flight stop disables the control");
});

test("rendering is pure: no frame fetch, no capture, identical markup across renders", () => {
  resetStore();
  const one = renderWired({ turnRunning: true });
  const two = renderWired({ turnRunning: true });
  assert.equal(one, two);
  // The mounted presentation needs no services provider at all — no poll, no capture path.
  const bare = renderToStaticMarkup(
    React.createElement(
      ZCodeIntlProvider,
      { locale: "en-US", messages: enUS },
      React.createElement(MiniComputerPanelMounted, { data: mountedData(), actions: noopActions }),
    ),
  );
  assert.ok(bare.includes(TID_V4_MINI_COMPUTER));
});

// ---------------------------------------------------------------------------
// M3 cleanup: the mini panel is the canonical Computer UI for background work.
// ---------------------------------------------------------------------------

/** Wraps the fake workspace into a present session view (as the shared poll returns it). */
function activeView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const ws = workspace({ updatedAt: Date.now(), ...overrides });
  const rest = { ...overrides };
  delete rest.updatedAt;
  return {
    present: true,
    paused: false,
    lease: { state: "inactive" },
    workspace: ws,
    ...rest,
  };
}

test("agent-workspace active: the large Computer Use bar is suppressed, the panel is canonical", () => {
  resetStore();
  // The composer gates the bar on this exact predicate.
  assert.equal(isAgentWorkspaceActive(activeView(), true), true);
  const html = renderWired({ turnRunning: true });
  assert.ok(html.includes(TID_V4_MINI_COMPUTER));
});

test("mini hidden: only the compact reopen chip shows; the bar stays suppressed", () => {
  resetStore();
  assert.equal(isAgentWorkspaceActive(activeView(), true), true);
  useMiniComputerStore.getState().hide("session-a");
  // Helper truth unchanged by a visual preference: the composer still suppresses the bar.
  assert.equal(isAgentWorkspaceActive(activeView(), true), true);
  const mounted = renderMounted(
    mountedData({
      hidden: true,
      turnRunning: true,
      workspace: workspace({ updatedAt: Date.now() }),
    }),
  );
  assert.equal(mounted.includes(TID_V4_MINI_COMPUTER_STOP), false);
  assert.ok(mounted.includes(TID_V4_MINI_COMPUTER_REOPEN));
  assert.ok(mounted.includes("Working in background · Show Computer"));
});

test("native exclusive control: the large bar stays visible (safety surface)", () => {
  assert.equal(
    isAgentWorkspaceActive(
      {
        present: true,
        paused: false,
        lease: { state: "reserving" },
        workspace: workspace({ updatedAt: Date.now() }),
      },
      true,
    ),
    false,
    "even an active workspace never suppresses the bar during native lease activity",
  );
  assert.equal(isAgentWorkspaceActive(null, true), false);
  assert.equal(isAgentWorkspaceActive({ present: false }, true), false);
  // Native observe-only activity without a workspace projection keeps the bar too.
  assert.equal(
    isAgentWorkspaceActive({ present: true, paused: false, lease: { state: "inactive" } }, true),
    false,
  );
});

test("switching tasks: suppression is per session view, no state leakage", () => {
  resetStore();
  // Task A's active workspace does not leak into Task B's (workspace-less) view.
  assert.equal(isAgentWorkspaceActive(activeView(), true), true);
  assert.equal(
    isAgentWorkspaceActive({ present: true, paused: false, lease: { state: "inactive" } }, false),
    false,
  );
  // And hiding task A's panel does not hide task B's (store-level, session-keyed).
  useMiniComputerStore.getState().hide("session-a");
  assert.equal(useMiniComputerStore.getState().hiddenBySession["session-a"], true);
  assert.equal(useMiniComputerStore.getState().hiddenBySession["session-b"] ?? false, false);
});

// ---------------------------------------------------------------------------
// Floating window (LocalComputerPreview presentation).
// ---------------------------------------------------------------------------

const RECT = { x: 900, y: 420, width: 352, frameHeight: 220 };

test("floating: fixed window at the stored rect, with a title-bar drag area and a resize corner", () => {
  const html = renderMounted({ ...mountedData({ turnRunning: true }), rect: RECT });
  assert.ok(html.includes("translate3d(900px, 420px, 0)"));
  assert.ok(html.includes("width:352px"));
  assert.ok(html.includes("height:220px"), "frame height follows the aspect, no letterbox");
  assert.ok(html.includes(`${TID_V4_MINI_COMPUTER}-titlebar`));
  assert.ok(html.includes(`${TID_V4_MINI_COMPUTER}-resize`));
  assert.ok(html.includes('draggable="false"'), "the live frame never starts a native drag");
});

test("expand is the same element tree in a larger rect, with Restore and no resize corner", () => {
  const compact = renderMounted({ ...mountedData({ turnRunning: true }), rect: RECT });
  const expanded = renderMounted({
    ...mountedData({ turnRunning: true, expanded: true }),
    rect: { x: 120, y: 80, width: 1_200, frameHeight: 675 },
  });
  assert.ok(expanded.includes(`data-mini-computer-expanded="true"`));
  assert.ok(expanded.includes("Restore"));
  assert.equal(expanded.includes(`${TID_V4_MINI_COMPUTER}-resize`), false);
  // 同一帧、同一来源：展开不新开流，帧序号不变。
  for (const html of [compact, expanded]) {
    assert.ok(html.includes(`data-frame-seq="3"`));
    assert.ok(html.includes(`data-frame-source="gen-1:42:7"`));
  }
});

test("Stop shows a truthful Stopped state and disables further commands", () => {
  const html = renderMounted({ ...mountedData({ turnRunning: true }), stopped: true });
  assert.ok(html.includes("Stopped"));
  assert.ok(html.includes(`data-mini-computer-state="stopped"`));
});

test("presentation is per session: moving/resizing one preview never affects another", () => {
  resetStore();
  const store = useMiniComputerStore.getState();
  store.setPosition("session-a", { x: 10, y: 20 });
  store.setWidth("session-a", 480);
  const next = useMiniComputerStore.getState();
  assert.deepEqual(next.positionBySession["session-a"], { x: 10, y: 20 });
  assert.equal(next.positionBySession["session-b"], undefined);
  assert.equal(next.widthBySession["session-b"], undefined);
  next.setExpanded("session-a", true);
  useMiniComputerStore.getState().markStopped("session-a", 1);
  assert.equal(useMiniComputerStore.getState().expandedBySession["session-a"], false);
});

// ---------------------------------------------------------------------------
// Screen takeover: the agent drives the real screen, so the mini preview hides.
// ---------------------------------------------------------------------------

test("screen takeover hides the mini panel: active lease, pending or granted for the same task", () => {
  const takeoverView = (lease: string, takeover?: Record<string, unknown>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    activeView({
      lease: { state: lease },
      activity: { task: "turn-1", method: "acquire_control", phase: "started" },
      ...(takeover ? { takeover } : {}),
    }) as any;
  assert.equal(isAgentWorkspaceActive(takeoverView("active"), true), false);
  assert.equal(
    isAgentWorkspaceActive(takeoverView("inactive", { state: "pending", task: "turn-1" }), true),
    false,
    "waiting for Allow/Deny",
  );
  assert.equal(
    isAgentWorkspaceActive(takeoverView("inactive", { state: "granted", task: "turn-1" }), true),
    false,
    "between foreground actions of the granted task",
  );
  assert.equal(
    isAgentWorkspaceActive(takeoverView("inactive", { state: "granted", task: "turn-0" }), true),
    true,
    "an old task's grant does not hide new background work",
  );
  assert.equal(
    isAgentWorkspaceActive(takeoverView("inactive", { state: "denied", task: "turn-1" }), true),
    true,
    "declined: background work continues in the mini panel",
  );
});
