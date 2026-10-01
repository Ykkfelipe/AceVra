import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { createRateLimiter } from "./rateLimit.js";
import type { createAccountService } from "./accounts.js";
import type { HumanIdentityVerifier } from "./ports.js";

export interface MeResponse {
  account: { id: string; displayName: string | null; avatarUrl: string | null };
  admission: { status: "approved" };
}

const MAX_TOKEN_LENGTH = 4096;
/** Header-only, single-token bearer: a token in the URL would leak through logs and referrers. */
function readBearer(header: string | undefined): string | null {
  const match = header?.trim().match(/^Bearer ([A-Za-z0-9._~+/=-]+)$/);
  return match && match[1]!.length <= MAX_TOKEN_LENGTH ? match[1]! : null;
}

export function createAccountApp(deps: {
  verifier: HumanIdentityVerifier;
  accounts: ReturnType<typeof createAccountService>;
  /** Requests per window per client key. Defaults: 60 / minute. */
  rateLimit?: { limit: number; windowMs: number };
  /** Derives the client key. Behind a trusted proxy, supply its forwarded address. */
  clientKey?: (request: Request) => string;
  /** Log sink for request lines (method, path, status only; never headers or tokens). */
  log?: (line: string) => void;
}) {
  const app = new Hono();
  const limiter = createRateLimiter(deps.rateLimit ?? { limit: 60, windowMs: 60_000 });
  // No CORS headers on purpose: the only client is the desktop main process (no Origin).
  app.use(secureHeaders());
  app.use(bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: "too_large" }, 413) }));
  app.use("/v1/*", async (c, next) => {
    const wait = limiter.check(deps.clientKey?.(c.req.raw) ?? "local");
    if (wait !== null) {
      c.header("Retry-After", String(wait));
      return c.json({ error: "rate_limited" }, 429);
    }
    await next();
  });
  app.use(async (c, next) => {
    await next();
    deps.log?.(`${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status}`);
  });
  app.onError((_error, c) => c.json({ error: "unavailable" }, 503));
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/v1/me", async (c) => {
    c.header("Cache-Control", "no-store");
    const token = readBearer(c.req.header("authorization"));
    const identity = token ? await deps.verifier.verify(token) : null;
    if (!identity) return c.json({ error: "unauthenticated" }, 401);
    try {
      const result = await deps.accounts.resolve(identity.clerkUserId);
      // Non-disclosing: a denied caller learns nothing about the ledger.
      if (!("account" in result)) return c.json({ error: "not_admitted" }, 403);
      const body: MeResponse = {
        account: {
          id: result.account.id,
          displayName: result.account.displayName,
          avatarUrl: result.account.avatarUrl,
        },
        admission: { status: "approved" },
      };
      return c.json(body);
    } catch {
      return c.json({ error: "unavailable" }, 503);
    }
  });
  return app;
}
