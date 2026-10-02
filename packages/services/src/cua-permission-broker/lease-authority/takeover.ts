// Screen takeover grants (zcode-cua/specs/computer-use.md "Screen takeover").
//
// Pure state: who asked for foreground control, and what the user decided. The lease authority
// owns one instance; the runtime sideband may only `request` and read `status`, while `decide`
// is reachable only from the owning UI. A grant is scoped to one (session, task) and revoked
// when a lease ends by user interruption, Stop or Pause.
//
// A granted record is the ProtectedForegroundGrant (specs/computer-use.md "Protected foreground
// grant"): it carries a grantId and an expiry, survives Helper restarts and native-lease turnover,
// and is ended only by Stop, Pause, user takeover or its expiry.

import { randomUUID } from "node:crypto";

/** Screen takeover approval (zcode-cua/specs/computer-use.md "Screen takeover"). */
export type TakeoverState = "none" | "pending" | "granted" | "denied";

export interface TakeoverRecord {
  readonly session: string;
  readonly task: string;
  readonly state: Exclude<TakeoverState, "none">;
  readonly requestedAt: number;
  readonly decidedAt?: number;
  /** ProtectedForegroundGrant identity, minted by the user's Allow. */
  readonly grantId?: string;
  /** A granted record stops authorizing protected foreground at this time. */
  readonly expiresAt?: number;
}

/**
 * The runtime-facing view of the ProtectedForegroundGrant for one task. The approval itself lives
 * here (the authority is its single owner); the runtime keeps only the private native-lease binding.
 */
export interface ProtectedGrantView {
  readonly state: TakeoverState;
  readonly grantId?: string;
  readonly expiresAt?: number;
  /** True once a granted record reached `expiresAt`; the task must ask the user again. */
  readonly expired?: boolean;
}

export interface TakeoverPort {
  /** Runtime sideband: ask for screen takeover for one task (never grants). */
  request(owner: { session: string; task: string }): TakeoverState;
  /** Runtime sideband: the decision for exactly this task. */
  status(owner: { session: string; task: string }): TakeoverState;
  /** Owning UI only: answer the session's pending takeover request. */
  decide(session: string, decision: "allow" | "deny"): boolean;
  /** Owning UI read model. */
  view(session: string): TakeoverRecord | undefined;
  /** Runtime sideband: the grant for exactly this task, with its identity and expiry. */
  grant(owner: { session: string; task: string }): ProtectedGrantView;
}

export interface TakeoverOwner {
  readonly session: string;
  readonly task: string;
}

/**
 * Lease endings that mean the user took the screen back. Only these (plus Stop and Pause) end the
 * ProtectedForegroundGrant. Lease-lifecycle endings — the native lease's 15 s deadline, a Helper
 * restart or reconnect, stale geometry — end one native lease, not the user's Allow: the runtime
 * re-acquires a fresh native lease under the same grant.
 */
const USER_RECLAIM_REASONS = new Set([
  "interrupted",
  "interrupted_or_focus_lost",
  "user_takeover",
  "secure_field",
]);

export function isUserReclaimReason(reason: string | undefined): boolean {
  return reason !== undefined && USER_RECLAIM_REASONS.has(reason);
}

export const TAKEOVER_PENDING_TTL_MS = 5 * 60_000;
/**
 * Bounded life of an Allow. Native leases are short (15 s, Helper-owned) and are re-acquired under
 * the grant; the grant itself must not authorize the screen indefinitely. Stop, Pause and user
 * takeover end it earlier.
 */
export const PROTECTED_GRANT_TTL_MS = 15 * 60_000;
const MAX_TAKEOVER_RECORDS = 64;

export interface TakeoverGrants {
  /** Runtime: record a request (idempotent; an existing grant for the same task is kept). */
  request(owner: TakeoverOwner): TakeoverState;
  /** Runtime: current state for this exact task. */
  status(owner: TakeoverOwner): TakeoverState;
  /** UI only: answer the session's pending request. Returns false when nothing is pending. */
  decide(session: string, decision: "allow" | "deny"): boolean;
  /** Authority: revoke the session's grant (interruption, Stop, Pause). */
  revoke(session?: string): void;
  /** Read model for the owning UI. */
  view(session: string): TakeoverRecord | undefined;
  /** Runtime: the grant for this exact task (identity + expiry). */
  grant(owner: TakeoverOwner): ProtectedGrantView;
}

export function createTakeoverGrants(
  now: () => number = Date.now,
  mintGrantId: () => string = randomUUID,
): TakeoverGrants {
  const records = new Map<string, TakeoverRecord>();
  /** Sessions whose granted record expired, so the runtime can name the cause once. */
  const expiredSessions = new Map<string, string>();

  const live = (session: string): TakeoverRecord | undefined => {
    const record = records.get(session);
    if (!record) return undefined;
    // 未答复的请求有界：过期即视为不存在，绝不因为陈旧 pending 而被后来误批。
    if (record.state === "pending" && now() - record.requestedAt > TAKEOVER_PENDING_TTL_MS) {
      records.delete(session);
      return undefined;
    }
    // 授权同样有界：到期即失效，运行时得到 protected_grant_expired，绝不无限期授权屏幕。
    if (record.state === "granted" && record.expiresAt !== undefined && now() >= record.expiresAt) {
      records.delete(session);
      expiredSessions.set(session, record.task);
      return undefined;
    }
    return record;
  };

  const store = (record: TakeoverRecord) => {
    records.delete(record.session);
    records.set(record.session, record);
    while (records.size > MAX_TAKEOVER_RECORDS) {
      const oldest = records.keys().next().value;
      if (oldest === undefined) break;
      records.delete(oldest);
    }
  };

  return {
    request(owner) {
      const current = live(owner.session);
      if (current && current.task === owner.task) {
        // 同一任务里已批准/待批：不重复弹卡；已拒绝的任务再次请求则重新询问。
        if (current.state === "granted" || current.state === "pending") return current.state;
      }
      expiredSessions.delete(owner.session);
      store({ session: owner.session, task: owner.task, state: "pending", requestedAt: now() });
      return "pending";
    },
    status(owner) {
      const current = live(owner.session);
      if (!current || current.task !== owner.task) return "none";
      return current.state;
    },
    decide(session, decision) {
      const current = live(session);
      if (!current || current.state !== "pending") return false;
      const decidedAt = now();
      store(
        decision === "allow"
          ? {
              ...current,
              state: "granted",
              decidedAt,
              grantId: mintGrantId(),
              expiresAt: decidedAt + PROTECTED_GRANT_TTL_MS,
            }
          : { ...current, state: "denied", decidedAt },
      );
      return true;
    },
    revoke(session) {
      if (session === undefined) {
        records.clear();
        expiredSessions.clear();
        return;
      }
      records.delete(session);
      expiredSessions.delete(session);
    },
    view(session) {
      return live(session);
    },
    grant(owner) {
      const current = live(owner.session);
      if (!current || current.task !== owner.task) {
        return expiredSessions.get(owner.session) === owner.task
          ? { state: "none", expired: true }
          : { state: "none" };
      }
      return {
        state: current.state,
        ...(current.grantId ? { grantId: current.grantId } : {}),
        ...(current.expiresAt !== undefined ? { expiresAt: current.expiresAt } : {}),
      };
    },
  };
}
