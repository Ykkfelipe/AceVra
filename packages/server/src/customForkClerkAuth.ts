import type { Context } from "hono";

/**
 * Small, reversible auth boundary for the private fork route.
 *
 * The local server accepts a session token supplied out-of-band by the Clerk
 * integration. Keeping the comparison here means the route can later switch
 * to Clerk JWT/JWKS verification without changing the WebSocket or UI layers.
 */
export function isCustomForkClerkAuthorized(c: Context): boolean {
  const expected = process.env.ZCODE_FORK_CLERK_SESSION_TOKEN?.trim();
  if (!expected) {
    return process.env.ZCODE_FORK_ALLOW_UNAUTHENTICATED === "1";
  }
  const authorization = c.req.header("authorization")?.trim();
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return token === expected || new URL(c.req.url).searchParams.get("token") === expected;
}
