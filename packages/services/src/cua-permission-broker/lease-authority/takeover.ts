// Screen takeover grants (zcode-cua/specs/computer-use.md "Screen takeover").
//
// Pure state: who asked for foreground control, and what the user decided. The lease authority
// owns one instance; the runtime sideband may only `request` and read `status`, while `decide`
// is reachable only from the owning UI. A grant is scoped to one (session, task) and revoked
// when a lease ends by user interruption, Stop or Pause.

/** Screen takeover approval (zcode-cua/specs/computer-use.md "Screen takeover"). */
export type TakeoverState = "none" | "pending" | "granted" | "denied";

export interface TakeoverRecord {
  readonly session: string;
  readonly task: string;
  readonly state: Exclude<TakeoverState, "none">;
  readonly requestedAt: number;
  readonly decidedAt?: number;
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
}

export interface TakeoverOwner {
  readonly session: string;
  readonly task: string;
}

export const TAKEOVER_PENDING_TTL_MS = 5 * 60_000;
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
}

export function createTakeoverGrants(now: () => number = Date.now): TakeoverGrants {
  const records = new Map<string, TakeoverRecord>();

  const live = (session: string): TakeoverRecord | undefined => {
    const record = records.get(session);
    if (!record) return undefined;
    // 未答复的请求有界：过期即视为不存在，绝不因为陈旧 pending 而被后来误批。
    if (record.state === "pending" && now() - record.requestedAt > TAKEOVER_PENDING_TTL_MS) {
      records.delete(session);
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
      store({ ...current, state: decision === "allow" ? "granted" : "denied", decidedAt: now() });
      return true;
    },
    revoke(session) {
      if (session === undefined) {
        records.clear();
        return;
      }
      records.delete(session);
    },
    view(session) {
      return live(session);
    },
  };
}
