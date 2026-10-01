import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { createRateLimiter } from "./rateLimit.js";
import type { createAccountService } from "./accounts.js";
import type { HumanIdentityVerifier } from "./ports.js";
import {
  DEVICE_CAPABILITIES,
  DEVICE_PLATFORMS,
  DEVICE_TYPES,
  type DeviceCapability,
  type DeviceService,
} from "./devices.js";

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
  devices?: DeviceService;
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
  app.use(bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: "too_large" }, 413) }));
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
  /** Verifies Clerk, enforces admission, and resolves the account. The account id is always
   * server-derived; no client-supplied account or owner id is ever read. */
  async function authenticate(
    c: Context,
  ): Promise<
    | { ok: true; account: { id: string; displayName: string | null; avatarUrl: string | null } }
    | { ok: false; response: Response }
  > {
    c.header("Cache-Control", "no-store");
    const token = readBearer(c.req.header("authorization"));
    const identity = token ? await deps.verifier.verify(token) : null;
    if (!identity) return { ok: false, response: c.json({ error: "unauthenticated" }, 401) };
    try {
      const result = await deps.accounts.resolve(identity.clerkUserId);
      // Non-disclosing: a denied caller learns nothing about the ledger.
      if (!("account" in result)) {
        return { ok: false, response: c.json({ error: "not_admitted" }, 403) };
      }
      return { ok: true, account: result.account };
    } catch {
      return { ok: false, response: c.json({ error: "unavailable" }, 503) };
    }
  }

  app.get("/v1/me", async (c) => {
    const auth = await authenticate(c);
    if (!auth.ok) return auth.response;
    const body: MeResponse = {
      account: {
        id: auth.account.id,
        displayName: auth.account.displayName,
        avatarUrl: auth.account.avatarUrl,
      },
      admission: { status: "approved" },
    };
    return c.json(body);
  });

  const devices = deps.devices;
  if (devices) {
    const readJson = async (c: Context): Promise<Record<string, unknown> | null> => {
      const body = await c.req.json().catch(() => null);
      return body && typeof body === "object" && !Array.isArray(body) ? body : null;
    };
    const name = (value: unknown) => {
      const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
      return text.length >= 1 && text.length <= 60 && ![...text].some((ch) => ch.charCodeAt(0) < 32)
        ? text
        : null;
    };
    const oneOf = <T extends string>(set: readonly T[], value: unknown): T | null =>
      typeof value === "string" && (set as readonly string[]).includes(value) ? (value as T) : null;

    app.get("/v1/devices", async (c) => {
      const auth = await authenticate(c);
      if (!auth.ok) return auth.response;
      return c.json({ devices: await devices.list(auth.account.id) });
    });
    app.post("/v1/devices/register", async (c) => {
      const auth = await authenticate(c);
      if (!auth.ok) return auth.response;
      const body = await readJson(c);
      const installationId = body?.installationId;
      const type = oneOf(DEVICE_TYPES, body?.type);
      const platform = oneOf(DEVICE_PLATFORMS, body?.platform);
      const displayName = name(body?.displayName);
      const caps = body?.capabilities;
      const capabilities = Array.isArray(caps)
        ? caps.map((cap) => oneOf(DEVICE_CAPABILITIES, cap))
        : null;
      if (
        typeof installationId !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(installationId) ||
        !type ||
        !platform ||
        !displayName ||
        !capabilities ||
        capabilities.length > 16 ||
        capabilities.includes(null)
      ) {
        return c.json({ error: "invalid_request" }, 400);
      }
      const result = await devices.register(auth.account.id, {
        installationId: installationId.toLowerCase(),
        type,
        platform,
        displayName,
        capabilities: [...new Set(capabilities as DeviceCapability[])],
      });
      if (!result.ok) {
        return c.json({ error: result.reason }, result.reason === "installation_bound" ? 409 : 403);
      }
      return c.json({ device: result.device }, result.created ? 201 : 200);
    });
    app.patch("/v1/devices/:id", async (c) => {
      const auth = await authenticate(c);
      if (!auth.ok) return auth.response;
      const displayName = name((await readJson(c))?.displayName);
      if (!displayName) return c.json({ error: "invalid_request" }, 400);
      const device = await devices.rename(auth.account.id, c.req.param("id"), displayName);
      return device ? c.json({ device }) : c.json({ error: "not_found" }, 404);
    });
    app.post("/v1/devices/:id/heartbeat", async (c) => {
      const auth = await authenticate(c);
      if (!auth.ok) return auth.response;
      const result = await devices.heartbeat(auth.account.id, c.req.param("id"));
      if (result.status === "ok") return c.json({ device: result.device });
      return result.status === "revoked"
        ? c.json({ error: "device_revoked" }, 403)
        : c.json({ error: "not_found" }, 404);
    });
    app.post("/v1/devices/:id/revoke", async (c) => {
      const auth = await authenticate(c);
      if (!auth.ok) return auth.response;
      const device = await devices.revoke(auth.account.id, c.req.param("id"));
      return device ? c.json({ device }) : c.json({ error: "not_found" }, 404);
    });
  }
  return app;
}
