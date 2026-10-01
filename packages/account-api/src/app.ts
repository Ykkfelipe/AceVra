import { Hono } from "hono";
import type { createAccountService } from "./accounts.js";
import type { HumanIdentityVerifier } from "./ports.js";

export interface MeResponse {
  account: { id: string; displayName: string | null; avatarUrl: string | null };
  admission: { status: "approved" };
}

/** Header-only bearer: a token in the URL would leak through logs and referrers. */
function readBearer(header: string | undefined): string | null {
  const match = header?.trim().match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

export function createAccountApp(deps: {
  verifier: HumanIdentityVerifier;
  accounts: ReturnType<typeof createAccountService>;
}) {
  const app = new Hono();
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
