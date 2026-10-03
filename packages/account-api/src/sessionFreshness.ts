/**
 * Bounded revocation freshness for human sessions.
 *
 * Clerk's `verifyToken` is a pure cryptographic check, so a JWT minted before a
 * remote revocation keeps passing until its own `exp`. This module bounds that window
 * to a value this codebase owns.
 *
 * Clerk remains the authority. Nothing here decides a session's status; it only
 * remembers the last answer and remembers when that answer stopped being fresh.
 *
 * The three kinds of memory age differently, so they are kept apart on purpose:
 *
 *  - `active` is a guess that may go stale, so it expires with the TTL.
 *  - `revoked` is a fact. Clerk said the session is dead and it cannot become alive
 *    again, so it must never expire: a time-limited negative would let the next Clerk
 *    outage re-admit a session already known to be gone, which is precisely the window
 *    this milestone exists to close.
 *  - `outage` is an absence of information. It is cached only briefly, so a burst of
 *    requests during an outage is one failed Clerk call rather than many, while a
 *    session is re-checked promptly once Clerk returns.
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
  /** How long a confirmed *active* answer is trusted. This is the revocation bound. */
  ttlMs: number;
  clock?: () => number;
  /** Cap on tracked live sessions; the least recently used is evicted first. */
  maxEntries?: number;
  /** Cap on remembered revocations. Defaults to 5000, independent of `maxEntries`. */
  revokedMaxEntries?: number;
  /** How long a Clerk outage is remembered before retrying. Defaults to 10s. */
  outageCacheMs?: number;
  /**
   * How long a revoked sid is remembered. Defaults to 24h — far beyond any plausible
   * session-token lifetime, so a retained negative cannot outlive the token it
   * protects. This bounds memory only; it is not part of the revocation bound.
   */
  revokedRetentionMs?: number;
  /** Abort a hung Clerk call, so one connection cannot wedge a session. Defaults to 5s. */
  timeoutMs?: number;
}

export interface SessionFreshnessVerdict {
  /** Whether this request may proceed. */
  admit: boolean;
  /** Diagnostic only; never exposed to the client. */
  reason:
    | "fresh_active"
    | "revalidated_active"
    | "revoked"
    | "outage_cached"
    | "outage_unexpired"
    | "token_expired_during_outage";
}

const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_OUTAGE_CACHE_MS = 10_000;
const DEFAULT_REVOKED_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5_000;
/**
 * Revocations get a far larger allowance than live sessions. Dropping a revocation to
 * save memory would re-open exactly the window this module exists to close, so normal
 * memory pressure must never evict one; only an extraordinary number of revocations
 * may, oldest first.
 */
const DEFAULT_REVOKED_MAX_ENTRIES = 5_000;

/**
 * A `sid` is the cache key. It comes from a signed token together with its `sub`, so
 * the pair cannot disagree; keying on the `sid` alone is safe and keeps one entry per
 * login rather than one per (user, login).
 */
export function createSessionFreshness(deps: SessionFreshnessDeps) {
  const now = deps.clock ?? Date.now;
  const maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const outageCacheMs = deps.outageCacheMs ?? DEFAULT_OUTAGE_CACHE_MS;
  const revokedMaxEntries = deps.revokedMaxEntries ?? DEFAULT_REVOKED_MAX_ENTRIES;
  const revokedRetentionMs = deps.revokedRetentionMs ?? DEFAULT_REVOKED_RETENTION_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** sid -> when it was confirmed active. Expiring: this is a guess. */
  const active = new Map<string, number>();
  /** sid -> when Clerk reported it dead. Durable: this is a fact. */
  const revoked = new Map<string, number>();
  /** sid -> until when a Clerk outage should not be retried. */
  const outage = new Map<string, number>();
  // One in-flight check per sid, so a burst of requests is one Clerk call.
  const inFlight = new Map<string, Promise<SessionStatusCheck>>();

  /** Moves an entry to the tail so eviction drops genuinely idle ones. */
  const touch = (map: Map<string, number>, key: string, value: number): void => {
    map.delete(key);
    map.set(key, value);
  };

  const cap = (map: Map<string, number>, limit = maxEntries): void => {
    while (map.size > limit) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  };

  const pruneRevoked = (): void => {
    const cutoff = now() - revokedRetentionMs;
    for (const [sid, at] of revoked) {
      if (at < cutoff) revoked.delete(sid);
    }
    cap(revoked, revokedMaxEntries);
  };

  return {
    async evaluate(input: {
      clerkUserId: string;
      sessionId: string;
      tokenExpiresAt: number;
    }): Promise<SessionFreshnessVerdict> {
      const { clerkUserId, sessionId, tokenExpiresAt } = input;

      // A known revocation is a fact, and outranks everything else — including a fresh
      // positive cached before the revocation was learned.
      if (revoked.has(sessionId)) return { admit: false, reason: "revoked" };

      const confirmedAt = active.get(sessionId);
      if (confirmedAt !== undefined) {
        touch(active, sessionId, confirmedAt);
        if (now() - confirmedAt < deps.ttlMs) return { admit: true, reason: "fresh_active" };
        active.delete(sessionId);
      }

      const outageUntil = outage.get(sessionId);
      if (outageUntil !== undefined && outageUntil > now()) {
        return tokenExpiresAt > now()
          ? { admit: true, reason: "outage_cached" }
          : { admit: false, reason: "token_expired_during_outage" };
      }

      const status = await checkOnce(clerkUserId, sessionId);
      if (status === "active") {
        touch(active, sessionId, now());
        outage.delete(sessionId);
        cap(active);
        return { admit: true, reason: "revalidated_active" };
      }
      if (status === "not_active") {
        markRevoked(sessionId);
        return { admit: false, reason: "revoked" };
      }

      // Clerk is unreachable. Remember it briefly, then fall back to the guarantee we
      // already had: an unexpired, signed token. Never wider than expiry allowed.
      touch(outage, sessionId, now() + outageCacheMs);
      cap(outage);
      if (tokenExpiresAt > now()) return { admit: true, reason: "outage_unexpired" };
      return { admit: false, reason: "token_expired_during_outage" };
    },

    /** Records an authoritative revocation so it applies without waiting out a TTL. */
    markRevoked,

    /** Drops every cached answer for a session, forcing revalidation. */
    forget(sessionId: string): void {
      active.delete(sessionId);
      revoked.delete(sessionId);
      outage.delete(sessionId);
    },

    /** Test/diagnostic surface. */
    size: () => active.size + revoked.size + outage.size,
    revokedCount: () => revoked.size,
  };

  function markRevoked(sessionId: string): void {
    revoked.delete(sessionId);
    revoked.set(sessionId, now());
    active.delete(sessionId);
    outage.delete(sessionId);
    pruneRevoked();
  }

  async function checkOnce(clerkUserId: string, sid: string): Promise<SessionStatusCheck> {
    const pending = inFlight.get(sid);
    if (pending) return pending;
    const request = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          deps.check(clerkUserId, sid),
          // A hung Clerk connection must not wedge every request for this session.
          new Promise<SessionStatusCheck>((resolve) => {
            timer = setTimeout(() => resolve("unavailable"), timeoutMs);
            timer.unref?.();
          }),
        ]);
      } catch {
        return "unavailable" as const;
      } finally {
        if (timer) clearTimeout(timer);
      }
    })().finally(() => inFlight.delete(sid));
    inFlight.set(sid, request);
    return request;
  }
}

export type SessionFreshness = ReturnType<typeof createSessionFreshness>;
