// Runtime side of the ProtectedForegroundGrant (specs/computer-use.md "Protected foreground grant").
//
// Two different things used to be one opaque `lease_id` the model had to carry:
//
//   ProtectedForegroundGrant  — owned by AceVra: minted by the user's Allow, kept by the lease
//                               authority (services), scoped to one (session, task), ended only by
//                               Stop, Pause, user takeover or its expiry. Survives Helper restarts.
//   NativeHelperLease         — owned by one Helper connection generation; dies with it; never
//                               reused across generations.
//
// The runtime keeps one private binding per session: which grant it acts under, and which native
// lease (and Helper connection generation) currently implements it. The model never sees or
// passes a native lease id; it sees `protectedForeground: "active"` and calls computer.click /
// computer.key_press / … as usual. The runtime resolves task → grant → generation → native lease.
//
//   model call ──► binding(session) ──► authority grant check (granted, same grantId)
//                        │                         │ revoked/expired → user_takeover / protected_grant_expired
//                        ▼
//                 inject native lease ──► Helper (generation G)
//                        │
//      result stamped G' ≠ G, lease dead, or Helper gone
//                        ▼
//      recover Helper (lifecycle owner) → observe target → NEW native lease → bind to same grant

/** Foreground methods that act under the native lease (acquire/release are handled separately). */
export const PROTECTED_LEASE_METHODS = Object.freeze([
  "activate_target",
  "move_pointer",
  "click",
  "type_text",
  "key_press",
  "scroll",
  "drag",
]);

/** Helper codes that mean the user took the screen back: the grant ends with the lease. */
const USER_RECLAIM_CODES = new Set([
  "interrupted",
  "interrupted_or_focus_lost",
  "user_takeover",
  "secure_field",
]);

/**
 * Helper refusals that mean only the native lease is gone, checked before anything was posted
 * (ForegroundControl.swift `checkedLease` runs first), so delivery is definitely "not_sent" and the
 * grant may re-acquire and retry once.
 */
const NATIVE_LEASE_ENDED_CODES = new Set([
  "invalid_lease",
  "lease_expired",
  "connection_generation_changed",
  "host_disconnected",
  "shutdown",
]);

export function isUserReclaimCode(code) {
  return typeof code === "string" && USER_RECLAIM_CODES.has(code);
}

export function isNativeLeaseEndedCode(code) {
  return typeof code === "string" && NATIVE_LEASE_ENDED_CODES.has(code);
}

/**
 * Per-session bindings. A binding is created only after a confirmed acquire under a granted
 * approval; `native` is null while no live native lease implements it (after a Helper restart,
 * a native lease ending, or before re-acquisition finishes).
 */
export function createProtectedGrantBindings() {
  /** @type {Map<string, ProtectedBinding>} */
  const bindings = new Map();
  return {
    get: (sessionId) => bindings.get(sessionId),
    set: (sessionId, binding) => bindings.set(sessionId, binding),
    delete: (sessionId) => bindings.delete(sessionId),
    sessions: () => [...bindings.keys()],
    entries: () => [...bindings.entries()],
    values: () => [...bindings.values()],
  };
}

/**
 * @typedef {object} ProtectedBinding
 * @property {string} grantId          authority grant this binding acts under
 * @property {string} taskId
 * @property {string} computerSessionId
 * @property {number} approvedAt       when this runtime first bound the grant
 * @property {number|undefined} expiresAt
 * @property {{pid?: number, window_id?: number, window_bounds?: object}} target
 * @property {null | {helperLeaseId: string, authorityLeaseId: string, connectionGeneration?: number}} native
 */

/** The only protected-foreground state a model sees. Never carries a native lease id. */
export function protectedForegroundView(binding) {
  if (!binding) return { protectedForeground: "inactive" };
  return {
    protectedForeground: binding.native ? "active" : "reacquiring",
    ...(Number.isFinite(binding.expiresAt)
      ? {
          protectedForegroundExpiresAt: new Date(binding.expiresAt).toISOString(),
        }
      : {}),
  };
}

/** Remove native lease identifiers from a Helper result before it reaches the model. */
export function withoutNativeLease(result, binding) {
  if (!result || typeof result !== "object") return result;
  const rest = { ...result };
  delete rest.lease_id;
  delete rest.lease_authority_generation;
  delete rest.connection_generation;
  return { ...rest, ...protectedForegroundView(binding) };
}

/** Same window state: the model's observation and the fresh one describe the same geometry. */
export function sameForegroundGeometry(a, b) {
  if (!a || !b || a.pid !== b.pid || a.window_id !== b.window_id) return false;
  const ra = a.window_bounds;
  const rb = b.window_bounds;
  if (!ra || !rb) return false;
  return ["x", "y", "w", "h"].every((key) => Number(ra[key]) === Number(rb[key]));
}

/**
 * Whether a result was produced by the generation the binding's native lease belongs to. A result
 * from any other generation must never update the binding (generation fencing). Results without a
 * stamp (no host relay) are accepted: there is only one generation to talk about.
 */
export function fromBoundGeneration(binding, result) {
  const stamped = result?.connection_generation;
  const bound = binding?.native?.connectionGeneration;
  if (!Number.isInteger(stamped) || !Number.isInteger(bound)) return true;
  return stamped === bound;
}

/**
 * Decide what the runtime must do with the authority's view of the grant.
 * Returns null when the binding may act, or the canonical refusal code.
 */
export function grantRefusal(binding, view) {
  if (!binding) return "invalid_lease";
  if (!view || typeof view !== "object") return "lease_authority_unavailable";
  // 到期由 authority 判定（它是授权的唯一所有者）：到期后它不再返回 granted。
  if (view.state === "granted" && view.grantId === binding.grantId) return null;
  if (view.expired === true) return "protected_grant_expired";
  return "user_takeover";
}

/** A Helper-shaped foreground refusal produced by the runtime (passes normalizeComputerUseResult). */
export function runtimeForegroundRefusal(code, extra = {}) {
  return {
    effect: "refused",
    code,
    route: "none",
    evidence: [],
    classification: "REQUIRES_FOREGROUND",
    input_delivery: "none",
    application_effect: "unknown",
    mode: "EXCLUSIVE_FOREGROUND",
    lease_state: "inactive",
    ...extra,
  };
}

/** A confirmed, Helper-shaped foreground record the runtime answers itself (no input posted). */
export function foregroundRecord(operation, leaseState, extra = {}) {
  return {
    operation,
    effect: "confirmed",
    route: "none",
    evidence: [],
    classification: "REQUIRES_FOREGROUND",
    input_delivery: "none",
    application_effect: "unknown",
    mode: "EXCLUSIVE_FOREGROUND",
    lease_state: leaseState,
    ...extra,
  };
}

/** control_status answer: the grant state for this task, never a native lease id. */
export function statusRecord(binding, leaseState) {
  return {
    effect: "confirmed",
    route: "none",
    evidence: [],
    lease_state: leaseState,
    ...protectedForegroundView(binding),
  };
}
