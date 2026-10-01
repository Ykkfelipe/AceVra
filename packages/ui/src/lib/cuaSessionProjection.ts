// CUA-4: pure renderer-side projection from the service Computer Use session read model.
//
// This module owns NO state and performs NO IO: it maps the authoritative service facts
// (`CuaComputerUseSessionView` from the lease authority) plus the conversation's own turn
// flag into one user-facing view. It is deliberately the only place that decides which
// state the Computer Use bar shows, so the UI can never drift from the runtime truth.
//
// State derivation order (first match wins) — each rule cites its authoritative fact:
//   1. no session record / not present        → invisible idle
//   2. a stop command is in flight            → stopping      (pending, transient)
//   3. the authority reports paused admission → paused
//   4. the session owns an active lease       → exclusive active (acquire in flight → waiting)
//   5. an action is in flight (started)       → by method: observe / background / waiting
//   6. the last lease ended by physical input → yielded to user (reason "interrupted")
//   7. the last action failed                 → failed
//   8. the last action completed              → by method (observe/background/…)
//   9. the lease record is terminal           → stopped
//  10. otherwise                              → idle

import type { CuaComputerUseSessionView, CuaSessionObservationView } from "@zcode/services";

export type ComputerUseUiState =
  | "idle"
  | "observing"
  | "backgroundAction"
  | "waitingForForeground"
  | "exclusiveActive"
  | "yieldedToUser"
  | "paused"
  | "stopping"
  | "stopped"
  | "failed";

/** Coarse interaction family of the latest action, derived from the Helper method. */
export type ComputerUseInteractionMode = "observe" | "background" | "control" | "foreground";

/** Mirrors the runtime's method classification (capability contract); presentation only. */
const MODE_BY_METHOD: Readonly<Record<string, ComputerUseInteractionMode>> = Object.freeze({
  observe: "observe",
  list_apps: "observe",
  list_windows: "observe",
  get_app_state: "observe",
  screenshot: "observe",
  request_access: "observe",
  control_status: "observe",
  press: "background",
  set_value: "background",
  acquire_control: "control",
  release_control: "control",
  activate_target: "foreground",
  move_pointer: "foreground",
  click: "foreground",
  type_text: "foreground",
  key_press: "foreground",
  scroll: "foreground",
  drag: "foreground",
});

/** After this long without a fresh observation the target naming is presented as stale. */
export const CUA_OBSERVATION_STALE_MS = 30_000;

export interface ComputerUseBarProjectionInput {
  session: CuaComputerUseSessionView | null;
  /** The open conversation's turn running flag (composer snapshot). */
  turnRunning: boolean;
  /** Transient optimistic command shown while the service call is in flight. */
  pending: "pause" | "resume" | "stop" | null;
  /** Renderer clock (ms epoch) — injected for deterministic staleness. */
  now: number;
  /**
   * Turn id of the conversation currently open, when the caller knows it. A stale outcome
   * belonging to another turn stops being visible.
   */
  currentTurnId?: string | null;
}

export interface ComputerUseBarView {
  visible: boolean;
  state: ComputerUseUiState;
  mode: ComputerUseInteractionMode | null;
  targetApp: string | null;
  targetWindow: string | null;
  targetStale: boolean;
  observation: { id: string; capturedAt: number; blank: boolean } | null;
  observationStale: boolean;
  /** The latest result could not be verified (unknown effect) — never shown as success. */
  effectUnverified: boolean;
  /** Last refusal/termination code when present (`paused`, `interrupted`, `target_gone`, …). */
  lastCode: string | null;
  /** Termination reason of the last lease, when the session knows one. */
  terminationReason: string | null;
  /** True → show Pause; false → show Resume (only meaningful while paused). */
  pauseAvailable: boolean;
  stopMeaningful: boolean;
}

function modeOf(method: string | undefined): ComputerUseInteractionMode | null {
  if (!method) return null;
  return MODE_BY_METHOD[method] ?? "observe";
}

function isTerminalTurnOutcome(state: ComputerUseUiState): boolean {
  return (
    state === "yieldedToUser" ||
    state === "stopped" ||
    state === "failed" ||
    state === "paused" ||
    state === "stopping"
  );
}

export function projectComputerUseBar(input: ComputerUseBarProjectionInput): ComputerUseBarView {
  const { session, turnRunning, pending, now, currentTurnId } = input;
  const base: ComputerUseBarView = {
    visible: false,
    state: "idle",
    mode: null,
    targetApp: null,
    targetWindow: null,
    targetStale: false,
    observation: null,
    observationStale: false,
    effectUnverified: false,
    lastCode: null,
    terminationReason: null,
    pauseAvailable: true,
    stopMeaningful: false,
  };
  if (!session || !session.present) return base;

  const activity = session.activity ?? null;
  const observation: CuaSessionObservationView | null = session.observation ?? null;
  const leaseActive = session.lease.state === "active" || session.lease.state === "reserving";
  const terminationReason = session.lease.termination?.reason ?? null;
  const activityMode = modeOf(activity?.method);
  const acquireInFlight = activity?.phase === "started" && activity.method === "acquire_control";

  let state: ComputerUseUiState;
  if (pending === "stop") {
    state = "stopping";
  } else if (session.paused) {
    state = "paused";
  } else if (leaseActive) {
    state = acquireInFlight ? "waitingForForeground" : "exclusiveActive";
  } else if (activity?.phase === "started") {
    if (activity.method === "acquire_control") state = "waitingForForeground";
    else if (activityMode === "foreground" || activityMode === "control") {
      state = "waitingForForeground";
    } else if (activityMode === "background") state = "backgroundAction";
    else state = "observing";
  } else if (terminationReason === "interrupted") {
    state = "yieldedToUser";
  } else if (activity?.phase === "completed" && activity.effect === "failed") {
    state = "failed";
  } else if (activity?.phase === "completed") {
    if (activityMode === "background") state = "backgroundAction";
    else state = "observing";
  } else if (session.lease.state === "stopped") {
    state = "stopped";
  } else {
    state = "idle";
  }

  // 大 ComputerUseBar 是「真实用户桌面接管」的安全面，不是通用活动指示器。渲染的充分
  // 必要条件是：原生前台/独占租约确实涉及（reserving/active、前台/control 方法在飞、或
  // 一段租约刚结束）。observe / get_app_state / screenshot / background 语义 / workspace
  // 后台动作一律不触发它 —— 那些由 MiniComputerPanel 呈现。
  const isForegroundMethod = (name: string | undefined): boolean => {
    const mode = modeOf(name);
    return mode === "control" || mode === "foreground";
  };
  const takeoverActive =
    leaseActive ||
    (activity !== null && isForegroundMethod(activity.method)) ||
    activity?.method === "acquire_control";
  // 一段租约已结束（让出、停止、释放、物理输入打断）→ 安全面仍有价值。
  const takeoverEnded = terminationReason !== null;
  const safetySurface =
    takeoverActive ||
    takeoverEnded ||
    state === "waitingForForeground" ||
    state === "exclusiveActive" ||
    state === "stopped";
  const outcomeBelongsToCurrentTurn =
    !currentTurnId || !activity || activity.task === currentTurnId || isTerminalTurnOutcome(state);
  const visible =
    safetySurface &&
    outcomeBelongsToCurrentTurn &&
    (turnRunning ||
      session.paused ||
      leaseActive ||
      pending !== null ||
      isTerminalTurnOutcome(state));

  const completedAfterObservation =
    activity?.phase === "completed" &&
    activity.method !== "observe" &&
    (activity.completedAt ?? 0) > (observation?.capturedAt ?? 0);
  const controlEnded = !leaseActive && terminationReason !== null;
  const observationStale =
    observation !== null &&
    (now - observation.capturedAt > CUA_OBSERVATION_STALE_MS ||
      completedAfterObservation ||
      controlEnded);

  const effectUnverified =
    activity !== null &&
    (activity.effect === "unknown" || activity.applicationEffect === "unknown");

  return {
    visible,
    state,
    mode: activityMode,
    targetApp: observation?.target?.app ?? null,
    targetWindow: observation?.target?.window ?? null,
    targetStale: observationStale,
    observation:
      observation !== null
        ? {
            id: observation.id,
            capturedAt: observation.capturedAt,
            blank: observation.blank === true,
          }
        : null,
    observationStale,
    effectUnverified,
    lastCode: activity?.code ?? null,
    terminationReason,
    pauseAvailable: !session.paused,
    stopMeaningful: session.stopMeaningful || turnRunning || pending === "stop",
  };
}

/**
 * The state the bar shows while a Stop confirmation is outstanding. STOPPING is presented from
 * the click until BOTH existing truths settle (turn no longer running AND the authority reports
 * the control stopped); the click alone never produces "stopped".
 */
export function resolveComputerUseShownState(
  state: ComputerUseUiState,
  stopRequested: boolean,
  serviceStopPending: boolean,
): ComputerUseUiState {
  const stopping = (stopRequested || serviceStopPending) && state !== "stopped";
  return stopping ? "stopping" : state;
}

/** True only when both Stop confirmations arrived — the point where STOPPED may be shown. */
export function stopConfirmed(state: ComputerUseUiState, turnRunning: boolean): boolean {
  return state === "stopped" && !turnRunning;
}
