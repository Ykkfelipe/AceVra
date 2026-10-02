// Workspace projection — M2B of the background-first Computer Workspace spec
// (specs/computer-workspace.md). The stable, read-only workspace/session view that M3's
// mini Computer panel renders: latest frame, logical agent cursor, current action, target,
// and a small lifecycle state — all PROJECTED from facts the backend already produces
// (Helper envelopes, observation ids, action results). It is not a second state machine:
// every field is stamped by an actual backend event, never by a UI timer or a poll.
//
// Capture discipline: this module never triggers capture. Frames only appear when a real
// observation ran (agent observe, or an explicit refresh that goes through the backend);
// reading snapshots is pure and side-effect free — UI polling creates zero observations.
//
// Fencing: one projection belongs to one workspace (session/task). Addressing a different
// target (pid/window) resets frame/cursor/action so a previous target's metadata can never
// leak into the new one.

export const WORKSPACE_STATES = Object.freeze([
  "idle",
  "observing",
  "acting",
  "paused",
  "failed",
  "stale",
]);

const ACTION_LABELS = Object.freeze({
  workspace_click: "Clicking",
  workspace_type_text: "Typing",
  workspace_scroll: "Scrolling",
  observe: "Observing",
  list_apps: "Listing apps",
  list_windows: "Listing windows",
  press: "Pressing",
  set_value: "Typing",
});

function sameTarget(left, right) {
  if (!left || !right) return false;
  if (left.pid !== right.pid) return false;
  const leftWindow = left.windowId ?? null;
  const rightWindow = right.windowId ?? null;
  // Unknown window ids compare equal on pid alone; a known-vs-different known id is a switch.
  if (leftWindow === null || rightWindow === null) return true;
  return leftWindow === rightWindow;
}

function normalizeTarget(target) {
  if (!target || typeof target.pid !== "number") return null;
  return {
    pid: target.pid,
    windowId: typeof target.windowId === "number" ? target.windowId : null,
    appName: typeof target.appName === "string" && target.appName ? target.appName : null,
  };
}

export function createWorkspaceProjection({
  workspaceId,
  backendId = "agent-workspace",
  sessionId = null,
  taskId = null,
  now = () => Date.now(),
} = {}) {
  if (typeof workspaceId !== "string" || !workspaceId.trim()) {
    throw new Error("workspace projection requires a workspaceId");
  }
  let state = {
    workspaceId,
    backendId,
    sessionId,
    taskId,
    state: "idle",
    target: null,
    frame: null,
    cursor: null,
    action: null,
    lastZeroSteal: null,
    /** Number of frames produced by real observations (diagnostic/test evidence). */
    framesCaptured: 0,
    updatedAt: now(),
  };

  const touch = (patch) => {
    state = { ...state, ...patch, updatedAt: now() };
  };

  const switchTargetIfNeeded = (target) => {
    const next = normalizeTarget(target);
    if (!next) return;
    if (state.target && !sameTarget(state.target, next)) {
      // Target switch: never leak the previous target's frame/cursor/action.
      touch({ target: next, frame: null, cursor: null, action: null, state: "idle" });
      return;
    }
    touch({ target: next });
  };

  return {
    /** A mutating or observing workspace action is starting. */
    noteActionStart({ method, target = null, describe = null } = {}) {
      if (target) switchTargetIfNeeded(target);
      touch({
        state: method === "observe" ? "observing" : "acting",
        action: {
          method,
          label: describe ?? ACTION_LABELS[method] ?? method,
          targetLabel: target?.appName ?? state.target?.appName ?? null,
          startedAt: now(),
          completedAt: null,
          effect: null,
          code: null,
        },
      });
    },

    /** A real observation produced a frame. */
    noteObservation({ target = null, result = null } = {}) {
      if (target) switchTargetIfNeeded(target);
      const image = result && typeof result.image === "object" ? result.image : null;
      const frameId =
        image && typeof image.observation_id === "string"
          ? image.observation_id
          : result && typeof result.observation_id === "string"
            ? result.observation_id
            : null;
      const refused = result && typeof result.effect === "string" && result.effect !== "confirmed";
      touch({
        state: refused ? (result.code === "target_lost" ? "stale" : "failed") : "idle",
        ...(frameId
          ? {
              framesCaptured: state.framesCaptured + 1,
              frame: {
                frameId,
                workspaceId: state.workspaceId,
                backendId: state.backendId,
                capturedAt: now(),
                dimensions:
                  image && Number.isFinite(image.width) && Number.isFinite(image.height)
                    ? { width: image.width, height: image.height }
                    : null,
                freshness: "fresh",
              },
            }
          : {}),
        action: state.action
          ? {
              ...state.action,
              completedAt: now(),
              effect: result?.effect ?? null,
              code: result?.code ?? null,
            }
          : null,
      });
    },

    /** A workspace action completed (confirmed, refused, unknown or failed). */
    noteActionResult({ method, target = null, result = null, cursor = null } = {}) {
      if (target) switchTargetIfNeeded(target);
      const effect = result && typeof result.effect === "string" ? result.effect : "unknown";
      const code = result && typeof result.code === "string" ? result.code : null;
      const refused = effect !== "confirmed";
      const nextState =
        code === "paused"
          ? "paused"
          : code === "target_lost" || code === "stale_target"
            ? "stale"
            : refused
              ? "failed"
              : "idle";
      touch({
        state: nextState,
        // A successful mutation supersedes the last frame: it predates the action, so M3 must
        // show it as stale until a fresh observation arrives. Never silently keep it "fresh".
        ...(effect === "confirmed" && state.frame
          ? { frame: { ...state.frame, freshness: "superseded" } }
          : {}),
        ...(cursor
          ? {
              cursor: {
                x: Number.isFinite(cursor.x) ? cursor.x : null,
                y: Number.isFinite(cursor.y) ? cursor.y : null,
                target: state.target,
                updatedAt: now(),
              },
            }
          : {}),
        ...(result && typeof result.zero_steal === "object" && result.zero_steal !== null
          ? { lastZeroSteal: result.zero_steal }
          : {}),
        action: state.action
          ? { ...state.action, completedAt: now(), effect, code }
          : {
              method,
              label: ACTION_LABELS[method] ?? method,
              targetLabel: state.target?.appName ?? null,
              startedAt: null,
              completedAt: now(),
              effect,
              code,
            },
      });
    },

    /** Explicitly note an admission pause (services may call this; UI never does). */
    notePaused(paused) {
      touch({
        state: paused === true ? "paused" : state.state === "paused" ? "idle" : state.state,
      });
    },

    /** Read-only snapshot for the UI. Pure: never captures, never mutates. */
    snapshot() {
      return {
        ...state,
        target: state.target ? { ...state.target } : null,
        frame: state.frame ? { ...state.frame } : null,
        cursor: state.cursor ? { ...state.cursor } : null,
        action: state.action ? { ...state.action } : null,
      };
    },
  };
}
