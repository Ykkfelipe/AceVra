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
}

export interface RegisterSessionRoutesOptions {
  app: Hono;
  sessions: HumanSessionDirectory;
  authenticate(c: Context): Promise<SessionAuth | { ok: false; response: Response }>;
  clientKey?: (request: Request) => string;
  /** Requests per window per client key for revoke. Defaults: 10 / minute. */
  revokeRateLimit?: { limit: number; windowMs: number };
}

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
    const records = await sessions.listActiveSessions(auth.clerkUserId);
    return c.json({
      sessions: records.map((record) => ({
        ...record,
        // Only the verified `sid` can mark a session current. A token without one
        // marks nothing, rather than guessing "the only session".
        current: record.id === auth.sessionId,
      })),
    });
  });

  app.post("/v1/sessions/:id/revoke", async (c) => {
    const wait = revokeLimiter.check(options.clientKey?.(c.req.raw) ?? "local");
    if (wait !== null) {
      c.header("Retry-After", String(wait));
      return c.json({ error: "rate_limited" }, 429);
    }
    const auth = await authenticate(c);
    if (!auth.ok) return auth.response;
    const result = await sessions.revokeSession(auth.clerkUserId, c.req.param("id"));
    // Non-disclosing: a session belonging to someone else is indistinguishable from
    // one that does not exist, matching the device registry's convention.
    if (!result.ok) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });
}
