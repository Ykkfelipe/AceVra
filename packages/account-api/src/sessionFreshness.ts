/**
 * Bounded revocation freshness for human sessions.
 *
 * Clerk's `verifyToken` is a pure cryptographic check, so a JWT minted before a
 * remote revocation keeps passing until its own `exp`. This module bounds that window
 * to a value this codebase owns: a session's status is re-confirmed with Clerk at
 * most once per TTL, and cached in between.
 *
 * Clerk remains the authority. Nothing here decides a session's status; it only
 * remembers the last answer and remembers when that answer stopped being fresh.
 *
 * Deliberately in memory. A restart empties the cache and the next request
 * revalidates, so a restart tightens freshness rather than reopening a window —
 * which is why this milestone adds no table.
 */

export type SessionStatusCheck = "active" | "not_active" | "unavailable";

export interface SessionFreshnessDeps {
  /**
   * Asks Clerk whether a session is still live. Must resolve `unavailable` rather
   * than throw or answer `not_active` when Clerk cannot be reached: an outage is not
   * evidence that a session was revoked.
   */
  check(clerkUserId: string, sessionId: string): Promise<SessionStatusCheck>;
  /** How long a confirmed answer is trusted. */
  ttlMs: number;
  clock?: () => number;
  /** Cap on tracked sessions; the least recently confirmed is evicted first. */
  maxEntries?: number;
}

export interface SessionFreshnessVerdict {
  /** Whether this request may proceed. */
  admit: boolean;
  /** Why, for tests and diagnostics. Never exposed to the client. */
  reason: "fresh_active" | "fresh_revoked" | "revalidated_active" | "revoked" | "outage_unexpired";
}

interface Entry {
  verifiedAt: number;
  active: boolean;
}

const DEFAULT_MAX_ENTRIES = 1_000;

/**
 * A `sid` is the cache key. It comes from a signed token together with its `sub`, so
 * the pair cannot disagree; keying on the `sid` alone is safe and keeps one entry per
 * login rather than one per (user, login).
 */
export function createSessionFreshness(deps: SessionFreshnessDeps) {
  const now = deps.clock ?? Date.now;
  const maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries = new Map<string, Entry>();
  // One in-flight check per sid, so a burst of first requests is one Clerk call.
  const inFlight = new Map<string, Promise<SessionStatusCheck>>();

  const read = (sessionId: string): Entry | null => {
    const entry = entries.get(sessionId);
    if (!entry) return null;
    // Refresh recency on read so eviction drops genuinely idle sessions.
    entries.delete(sessionId);
    entries.set(sessionId, entry);
    return entry;
  };

  const remember = (sessionId: string, active: boolean): void => {
    entries.delete(sessionId);
    entries.set(sessionId, { verifiedAt: now(), active });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  };

  const checkOnce = (clerkUserId: string, sessionId: string): Promise<SessionStatusCheck> => {
    const pending = inFlight.get(sessionId);
    if (pending) return pending;
    const request = deps
      .check(clerkUserId, sessionId)
      .catch(() => "unavailable" as const)
      .finally(() => inFlight.delete(sessionId));
    inFlight.set(sessionId, request);
    return request;
  };

  return {
    /**
     * Decides whether a session may keep being accepted.
     *
     * `tokenExpiresAt` is the verified token's own `exp`. It is what bounds the
     * fallback when Clerk cannot be reached: an outage must never widen the window
     * beyond what expiry already allowed, and must never turn an authentication
     * problem into an authorization success.
     */
    async evaluate(input: {
      clerkUserId: string;
      sessionId: string;
      tokenExpiresAt: number;
    }): Promise<SessionFreshnessVerdict> {
      const { clerkUserId, sessionId, tokenExpiresAt } = input;
      const cached = read(sessionId);

      if (cached && now() - cached.verifiedAt < deps.ttlMs) {
        return cached.active
          ? { admit: true, reason: "fresh_active" }
          : { admit: false, reason: "fresh_revoked" };
      }

      const status = await checkOnce(clerkUserId, sessionId);
      if (status === "active") {
        remember(sessionId, true);
        return { admit: true, reason: "revalidated_active" };
      }
      if (status === "not_active") {
        // Cache the negative. Forgetting it would let the next Clerk outage re-admit
        // a session we already know is dead.
        remember(sessionId, false);
        return { admit: false, reason: "revoked" };
      }

      // Clerk is unreachable. Do not cache: this is an absence of information, not an
      // answer. Fall back to the guarantee we already had — an unexpired, signed token.
      if (tokenExpiresAt > now()) return { admit: true, reason: "outage_unexpired" };
      return { admit: false, reason: "fresh_revoked" };
    },

    /** Drops a session's cached answer, forcing revalidation. Used by local sign-out. */
    forget(sessionId: string): void {
      entries.delete(sessionId);
    },

    /** Test/diagnostic surface. */
    size: () => entries.size,
  };
}

export type SessionFreshness = ReturnType<typeof createSessionFreshness>;
