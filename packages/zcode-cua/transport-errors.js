// Canonical Computer Use failure codes (specs/computer-use.md "Structured transport errors").
//
// Proven installed 92454874: when the Helper exited, every later call reached the model as
// "Computer Use request failed (unknown): failed". Each layer (Helper → session socket → host relay
// → broker client → runtime) now carries a stable code, and this module is the single place that
// turns a layer-specific code into the canonical, model-facing one. The original code is kept
// beside it (`original_code`) so no layer's diagnosis is lost.

/** Every canonical code the runtime may hand to the model for a failed or refused call. */
export const CANONICAL_FAILURE_CODES = Object.freeze({
  // Transport: the Helper or its connection is gone. Recoverable by relaunch.
  helper_disconnected: { recoverable: true, delivery: "not_sent" },
  helper_exited: { recoverable: true, delivery: "unknown" },
  connection_closed: { recoverable: true, delivery: "unknown" },
  connection_generation_changed: { recoverable: true, delivery: "not_sent" },
  // Native lease: owned by one Helper connection generation; never reused across generations.
  invalid_lease: { recoverable: true, delivery: "not_sent" },
  lease_expired: { recoverable: true, delivery: "not_sent" },
  lease_not_owned: { recoverable: false, delivery: "not_sent" },
  exclusive_busy: { recoverable: true, delivery: "not_sent" },
  // Runtime grant: owned by AceVra, created by the user's Allow, ended by Stop/Pause/takeover.
  protected_grant_expired: { recoverable: false, delivery: "not_sent" },
  user_takeover: { recoverable: false, delivery: "not_sent" },
  // Actuation.
  injection_failed: { recoverable: true, delivery: "unknown" },
  unsupported_action: { recoverable: false, delivery: "not_sent" },
  // Ambiguous delivery: re-observe before deciding whether to retry; never replayed silently.
  effect_unverified: { recoverable: true, delivery: "unknown" },
});

/**
 * Layer codes that already mean one canonical code. Anything not listed keeps its own code
 * (e.g. `paused`, `stale_geometry`, `takeover_pending`): those are already specific and actionable.
 */
const LAYER_TO_CANONICAL = Object.freeze({
  // broker.js / host relay
  connect_failed: "helper_disconnected",
  no_socket: "helper_disconnected",
  // Helper lease refusals (ForegroundControl.swift foregroundRefusal codes)
  interrupted: "user_takeover",
  interrupted_or_focus_lost: "user_takeover",
  host_disconnected: "helper_disconnected",
  shutdown: "helper_exited",
  input_unavailable: "injection_failed",
  invalid_key: "unsupported_action",
  invalid_modifiers: "unsupported_action",
  unsupported: "unsupported_action",
  unsupported_method: "unsupported_action",
});

/** The canonical code for a layer code, or the layer code itself when it is already specific. */
export function canonicalFailureCode(code) {
  if (typeof code !== "string" || !code) return "unknown";
  if (Object.hasOwn(CANONICAL_FAILURE_CODES, code)) return code;
  return LAYER_TO_CANONICAL[code] ?? code;
}

/** Metadata for a canonical code; unknown codes are reported as non-recoverable, delivery unknown. */
export function failureTraits(code) {
  return CANONICAL_FAILURE_CODES[code] ?? { recoverable: false, delivery: "unknown" };
}

const MODEL_HINTS = Object.freeze({
  helper_disconnected:
    "The Computer Helper is not connected (it exited or the host session was recycled). The request was not delivered. This is recoverable: the next call relaunches the Helper, and a still-valid screen-takeover approval is not lost.",
  helper_exited:
    "The Computer Helper exited while this request was in flight, so whether it took effect is unknown. Observe again before deciding whether to repeat it. The next call relaunches the Helper; a still-valid screen-takeover approval is not lost.",
  connection_closed:
    "The connection to the Computer Helper closed before it answered, so whether the request took effect is unknown. Observe again before deciding whether to repeat it.",
  connection_generation_changed:
    "The Computer Helper restarted since this request was prepared; the answer from the old Helper was discarded.",
  effect_unverified:
    "The Helper restarted while this action was in flight, so whether it was delivered is unknown. It was NOT repeated. Call get_app_state to see the current state before deciding whether to retry.",
  protected_grant_expired:
    "Screen takeover for this task has ended (Stop, Pause, user input, or its time limit). The user owns the screen again. Ask with computer.acquire_control only if a step truly needs it.",
  user_takeover:
    "The user took back control of the screen (physical input, Esc or Stop). Do not fight the user; continue in the background or tell them which step needs their hands.",
});

/** One-sentence explanation for a canonical code, or "" when the layer message already says it. */
export function failureHint(code) {
  return MODEL_HINTS[code] ?? "";
}

/**
 * Classify a thrown transport/broker error.
 *
 * `socketGone` is the result of checking the session socket the call used: an untyped or
 * connect-family failure against a socket that no longer exists means the Helper (or its host
 * session) is gone, which is the case that used to reach the model as "(unknown): failed".
 */
export function classifyThrownFailure(error, { socketGone = false } = {}) {
  const original =
    error && typeof error === "object" && typeof error.code === "string" && error.code
      ? error.code
      : "unknown";
  let code = canonicalFailureCode(original);
  if (socketGone && ["unknown", "connection_closed", "helper_disconnected"].includes(code)) {
    code = "helper_disconnected";
  }
  const traits = failureTraits(code);
  const details = error && typeof error === "object" ? error.details : undefined;
  const generation =
    details && typeof details === "object" && Number.isInteger(details.connection_generation)
      ? details.connection_generation
      : undefined;
  return {
    code,
    original_code: original,
    recoverable: traits.recoverable,
    delivery:
      details && typeof details === "object" && typeof details.delivery === "string"
        ? details.delivery
        : traits.delivery,
    ...(generation !== undefined ? { connection_generation: generation } : {}),
  };
}

/**
 * Annotate a Helper result (an action that reached the Helper and was refused or failed) with
 * the canonical code while keeping the Helper's own code. Results without a code are unchanged.
 */
export function annotateHelperFailure(result) {
  if (!result || typeof result !== "object" || typeof result.code !== "string") return result;
  if (result.effect !== "refused" && result.effect !== "failed") return result;
  const code = canonicalFailureCode(result.code);
  const traits = failureTraits(code);
  return {
    ...result,
    code,
    ...(code !== result.code ? { original_code: result.code } : {}),
    recoverable: traits.recoverable,
  };
}
