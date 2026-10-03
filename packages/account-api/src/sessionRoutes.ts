import type { Context, Hono } from "hono";
import { createRateLimiter } from "./rateLimit.js";
import type { HumanSessionDirectory } from "./ports.js";

/**
 * Human login sessions: which logins belong to this account, and ending one.
 *
 * This is NOT the device registry. A session is a login (a Clerk object, scoped to one
 * Clerk user); a device is a machine this account may drive (scoped to an AceVra
 * account, proven by a device credential). The two share no identifiers and no routes.
 *
 * Routes live here rather than in `app.ts` so the session surface stays readable on its
 * own; the ownership rules are the security-relevant part.
 */

export interface SessionAuth {
  ok: true;
  /** The Clerk user the request authenticated as. Never client-supplied. */
  clerkUserId: string;
  /** The `sid` this request carried, or null when the token had none. */
  sessionId: string | null;
  /** The resolved AceVra account, used as a rate-limit bucket key. */
  accountId: string;
}

export interface RegisterSessionRoutesOptions {
  app: Hono;
  sessions: HumanSessionDirectory;
  authenticate(c: Context): Promise<SessionAuth | { ok: false; response: Response }>;
  clientKey?: (request: Request) => string;
  /** Requests per window per client key for revoke. Defaults: 10 / minute. */
  revokeRateLimit?: { limit: number; windowMs: number };
}

/**
 * A session id as Clerk mints them. Constraining the shape here means the value is
 * interpolated into an outbound Clerk URL without carrying `/`, `.`, `?`, `#` or `%`.
 * Without it, path traversal is blocked only by an undocumented internal of the Clerk
 * SDK, and a hostile id would still let an authenticated caller force one arbitrary
 * Clerk request per call.
 */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function registerSessionRoutes(options: RegisterSessionRoutesOptions): void {
  const { app, sessions, authenticate } = options;
  // Ending someone else's login is a destructive authenticated write, so it gets a
  // limiter tighter than the global one — and separate from reads, so browsing the
  // list can never exhaust it.
  const revokeLimiter = createRateLimiter(
    options.revokeRateLimit ?? { limit: 10, windowMs: 60_000 },
  );

  app.get("/v1/sessions", async (c) => {
    const auth = await authenticate(c);
    if (!auth.ok) return auth.response;
    const { sessions: records, partial } = await sessions.listActiveSessions(auth.clerkUserId);
    return c.json({
      partial,
      sessions: records.map((record) => ({
        ...record,
        // Only the verified `sid` can mark a session current. A token without one
        // marks nothing, rather than guessing "the only session".
        current: record.id === auth.sessionId,
      })),
    });
  });

  app.post("/v1/sessions/:id/revoke", async (c) => {
    const auth = await authenticate(c);
    if (!auth.ok) return auth.response;
    // Throttled per account, after authentication. Keying on the client key before
    // auth would let an unauthenticated caller spend a shared bucket and lock the
    // revoke control for everyone on the instance.
    const wait = revokeLimiter.check(auth.accountId);
    if (wait !== null) {
      c.header("Retry-After", String(wait));
      return c.json({ error: "rate_limited" }, 429);
    }
    const sessionId = c.req.param("id");
    // Non-disclosing, same as an unknown session: a malformed id must not be
    // distinguishable from one that does not exist.
    if (!SESSION_ID.test(sessionId)) return c.json({ error: "not_found" }, 404);
    const result = await sessions.revokeSession(auth.clerkUserId, sessionId);
    // Non-disclosing: a session belonging to someone else is indistinguishable from
    // one that does not exist, matching the device registry's convention.
    if (!result.ok) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });
}
