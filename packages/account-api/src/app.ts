import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { createRateLimiter } from "./rateLimit.js";
import { normalizePairingCode, parseEd25519PublicKey, type PairingService } from "./pairing.js";
import type { createAccountService } from "./accounts.js";
import type { HumanIdentityVerifier, HumanSessionDirectory } from "./ports.js";
import type { SessionFreshness } from "./sessionFreshness.js";
import { registerSessionRoutes } from "./sessionRoutes.js";
import { parseProcessSpec } from "./processSpec.js";
import type { TaskService } from "./tasks.js";
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
  pairings?: PairingService;
  tasks?: TaskService;
  /** Human login sessions. Absent = this build exposes no session listing. */
  sessions?: HumanSessionDirectory;
  /**
   * Revocation freshness. Present = a signed session is re-confirmed with Clerk at
   * most once per TTL, so a remotely revoked session stops being accepted promptly.
   * Absent = the check is off, which restores M3 behaviour (token expiry only).
   */
  freshness?: SessionFreshness;
  /** A task was queued: let the channel offer it now. */
  onTaskQueued?: (deviceId: string) => void;
  /** A cancel was requested for a live process: tell the node. */
  onTaskCancel?: (deviceId: string, taskId: string) => void;
  /** Called after a revoke so live realtime connections are closed promptly. */
  onDeviceRevoked?: (deviceId: string) => void;
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
  app.use(bodyLimit({ maxSize: 16_384, onError: (c) => c.json({ error: "too_large" }, 413) }));
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
  async function authenticate(c: Context): Promise<
    | {
        ok: true;
        account: { id: string; displayName: string | null; avatarUrl: string | null };
        clerkUserId: string;
        sessionId: string | null;
        /** The resolved account, used as a rate-limit bucket key. Never client-supplied. */
        accountId: string;
      }
    | { ok: false; response: Response }
  > {
    c.header("Cache-Control", "no-store");
    const token = readBearer(c.req.header("authorization"));
    const identity = token ? await deps.verifier.verify(token) : null;
    if (!identity) return { ok: false, response: c.json({ error: "unauthenticated" }, 401) };

    // Revocation freshness, enforced here and nowhere else. It sits after the
    // cryptographic check and before the ledger read, so no route body — present or
    // future — runs for a session that has been revoked, and no individual route has
    // to know this exists.
    //
    // Skipped when the token carried no `sid`: there is no session identity to
    // revalidate, and inventing one would be a guess.
    if (deps.freshness && identity.sessionId) {
      const verdict = await deps.freshness.evaluate({
        clerkUserId: identity.clerkUserId,
        sessionId: identity.sessionId,
        tokenExpiresAt: identity.expiresAt ?? 0,
      });
      if (!verdict.admit) {
        return { ok: false, response: c.json({ error: "unauthenticated" }, 401) };
      }
    }

    try {
      const result = await deps.accounts.resolve(identity.clerkUserId);
      // Non-disclosing: a denied caller learns nothing about the ledger.
      if (!("account" in result)) {
        return { ok: false, response: c.json({ error: "not_admitted" }, 403) };
      }
      return {
        ok: true,
        account: result.account,
        // Kept server-side: the client never decides which session it is, and a token
        // without a `sid` claim yields null rather than a guess.
        clerkUserId: identity.clerkUserId,
        sessionId: identity.sessionId ?? null,
        accountId: result.account.id,
      };
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

  if (deps.sessions) {
    registerSessionRoutes({
      app,
      sessions: deps.sessions,
      authenticate,
      clientKey: deps.clientKey,
    });
  }

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
      if (device) deps.onDeviceRevoked?.(device.id);
      return device ? c.json({ device }) : c.json({ error: "not_found" }, 404);
    });
  }

  const tasks = deps.tasks;
  if (tasks && devices) {
    const taskIdOk = (id: string) => /^[A-Za-z0-9-]{8,64}$/.test(id);
    /** ExecutionTarget: derived from Devices; nothing here knows machine names. */
    app.get("/v1/targets", async (c) => {
      const auth = await authenticate(c);
      if (!auth.ok) return auth.response;
      const targets = (await devices.list(auth.account.id))
        .filter((d) => d.presence !== "revoked")
        .map((d) => {
          const online = d.live;
          const remoteShell = d.type === "node" && d.capabilities.includes("shell");
          return {
            id: d.id,
            type: d.type,
            displayName: d.displayName,
            online,
            capabilities: d.capabilities,
            available: remoteShell && online,
            ...(remoteShell && online
              ? {}
              : {
                  unavailableReason: !remoteShell
                    ? d.type === "node"
                      ? "no_shell_service"
                      : "remote_desktop_unsupported"
                    : "offline",
                }),
          };
        });
      return c.json({ targets });
    });
    app.post("/v1/tasks", async (c) => {
      const auth = await authenticate(c);
      if (!auth.ok) return auth.response;
      const input = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
      const spec = parseProcessSpec(input?.process);
      const key = input?.idempotencyKey;
      if (
        !input ||
        typeof input.targetDeviceId !== "string" ||
        !spec ||
        (key !== undefined && (typeof key !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(key)))
      ) {
        return c.json({ error: "invalid_request" }, 400);
      }
      const result = await tasks.create(auth.account.id, auth.account.id, {
        targetDeviceId: input.targetDeviceId,
        spec,
        idempotencyKey: key as string | undefined,
      });
      if (!result.ok) {
        return c.json({ error: result.reason }, result.reason === "target_not_found" ? 404 : 409);
      }
      if (result.created) deps.onTaskQueued?.(result.task.targetDeviceId);
      return c.json({ task: result.task }, result.created ? 201 : 200);
    });
    app.get("/v1/tasks", async (c) => {
      const auth = await authenticate(c);
      if (!auth.ok) return auth.response;
      return c.json({
        tasks: await tasks.list(auth.account.id, Number(c.req.query("limit") ?? 50) || 50),
      });
    });
    app.get("/v1/tasks/:id", async (c) => {
      const auth = await authenticate(c);
      if (!auth.ok) return auth.response;
      const task = taskIdOk(c.req.param("id"))
        ? await tasks.get(auth.account.id, c.req.param("id"))
        : null;
      return task ? c.json({ task }) : c.json({ error: "not_found" }, 404);
    });
    app.get("/v1/tasks/:id/events", async (c) => {
      const auth = await authenticate(c);
      if (!auth.ok) return auth.response;
      const after = Number(c.req.query("after") ?? 0);
      const events = taskIdOk(c.req.param("id"))
        ? await tasks.events(
            auth.account.id,
            c.req.param("id"),
            Number.isFinite(after) ? after : 0,
            Number(c.req.query("limit") ?? 200) || 200,
          )
        : null;
      return events ? c.json({ events }) : c.json({ error: "not_found" }, 404);
    });
    app.post("/v1/tasks/:id/cancel", async (c) => {
      const auth = await authenticate(c);
      if (!auth.ok) return auth.response;
      if (!taskIdOk(c.req.param("id"))) return c.json({ error: "not_found" }, 404);
      const force = ((await c.req.json().catch(() => ({}))) as { force?: unknown })?.force === true;
      const result = await tasks.cancel(auth.account.id, c.req.param("id"), force);
      if (!result) return c.json({ error: "not_found" }, 404);
      if (result.notifyDeviceId && result.task.state === "cancelling") {
        deps.onTaskCancel?.(result.notifyDeviceId, result.task.id);
      }
      return c.json({ task: result.task });
    });
  }

  const pairings = deps.pairings;
  if (pairings) {
    // Unauthenticated creation is the abuse surface: tighter than the global limiter.
    const createLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });
    // Wrong human codes are brute-force attempts: a few misses per account, then a cooldown.
    const missLimiter = createRateLimiter({ limit: 5, windowMs: 10 * 60_000 });
    const clientOf = (c: Context) => deps.clientKey?.(c.req.raw) ?? "local";
    const body = async (c: Context): Promise<Record<string, unknown>> => {
      const parsed = await c.req.json().catch(() => null);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    };
    const nameOf = (value: unknown) => {
      const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
      return text.length >= 1 && text.length <= 60 && ![...text].some((ch) => ch.charCodeAt(0) < 32)
        ? text
        : null;
    };

    app.post("/v1/pairings", async (c) => {
      const wait = createLimiter.check(clientOf(c));
      if (wait !== null) {
        c.header("Retry-After", String(wait));
        return c.json({ error: "rate_limited" }, 429);
      }
      const input = await body(c);
      const key = parseEd25519PublicKey(input.publicKey);
      const displayName = nameOf(input.displayName);
      const platform = (DEVICE_PLATFORMS as readonly string[]).includes(input.platform as string)
        ? (input.platform as (typeof DEVICE_PLATFORMS)[number])
        : null;
      const caps = Array.isArray(input.capabilities) ? input.capabilities : [];
      const capabilities = caps.map((cap) =>
        (DEVICE_CAPABILITIES as readonly string[]).includes(cap as string)
          ? (cap as DeviceCapability)
          : null,
      );
      if (!key || !displayName || !platform || caps.length > 16 || capabilities.includes(null)) {
        return c.json({ error: "invalid_request" }, 400);
      }
      const created = await pairings.create({
        publicKey: input.publicKey as string,
        keyId: key.keyId,
        displayName,
        platform,
        capabilities: [...new Set(capabilities as DeviceCapability[])],
      });
      c.header("Cache-Control", "no-store");
      return c.json(created, 201);
    });

    app.post("/v1/pairings/lookup", async (c) => {
      const auth = await authenticate(c);
      if (!auth.ok) return auth.response;
      const blocked = missLimiter.peek(auth.account.id);
      if (blocked !== null) {
        c.header("Retry-After", String(blocked));
        return c.json({ error: "too_many_attempts" }, 429);
      }
      const code = normalizePairingCode((await body(c)).code);
      const found = code ? await pairings.lookup(code) : null;
      if (!found) {
        missLimiter.check(auth.account.id);
        return c.json({ error: "not_found" }, 404);
      }
      return c.json({ pairing: found });
    });
    for (const decision of ["approve", "reject"] as const) {
      app.post(`/v1/pairings/:id/${decision}`, async (c) => {
        const auth = await authenticate(c);
        if (!auth.ok) return auth.response;
        const result = await pairings.decide(auth.account.id, c.req.param("id"), decision);
        if (result.ok) return c.json({ status: decision === "approve" ? "approved" : "rejected" });
        return result.reason === "not_found"
          ? c.json({ error: "not_found" }, 404)
          : c.json({ error: result.reason }, 409);
      });
    }

    // Node-facing (secret-proven, no Clerk). POST so the secret never rides in a URL.
    app.post("/v1/pairings/:id/status", async (c) => {
      const status = await pairings.status(c.req.param("id"), (await body(c)).secret);
      return status ? c.json({ status }) : c.json({ error: "not_found" }, 404);
    });
    app.post("/v1/pairings/:id/challenge", async (c) => {
      const result = await pairings.challenge(c.req.param("id"), (await body(c)).secret);
      if (result.ok) return c.json({ nonce: result.nonce, expiresAt: result.expiresAt });
      return result.reason === "not_found"
        ? c.json({ error: "not_found" }, 404)
        : c.json({ error: result.reason }, 409);
    });
    app.post("/v1/pairings/:id/claim", async (c) => {
      const input = await body(c);
      const result = await pairings.claim(c.req.param("id"), {
        secret: input.secret,
        nonce: input.nonce,
        signature: input.signature,
      });
      if (result.ok) return c.json({ deviceId: result.deviceId, keyId: result.keyId }, 201);
      if (result.reason === "not_found") return c.json({ error: "not_found" }, 404);
      return c.json({ error: result.reason }, result.reason === "bad_proof" ? 401 : 409);
    });
  }
  return app;
}
