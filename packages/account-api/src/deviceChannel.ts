import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { DEVICE_CAPABILITIES } from "./devices.js";
import type { SqlExecutor } from "./ports.js";
import { verifySignature } from "./pairing.js";

/**
 * Outbound realtime channel for paired nodes (M2C). Tiny on purpose: auth, presence and
 * lifecycle only. There is NO command surface (no exec/file/git/computer messages); any
 * unknown message type closes the connection.
 *
 * Client → server: hello, auth, heartbeat, pong, capabilities, reauth
 * Server → client: challenge, authenticated, ping, session_expiring, revoked, disconnect, error
 */
export const DEVICE_CHANNEL_PATH = "/v1/device-channel";
export const PROTOCOL_VERSION = 1;
export const deviceAuthMessage = (deviceId: string, nonce: string) =>
  `acevra-device-auth:v1:${deviceId}:${nonce}`;

export interface DeviceChannelOptions {
  pingIntervalMs?: number;
  /** Authenticated session lifetime; renewed by re-proving key possession on the same socket. */
  sessionTtlMs?: number;
  /** Warn this long before expiry. */
  expiringWarnMs?: number;
  authTimeoutMs?: number;
  maxPayload?: number;
  /** Messages allowed per window per connection. */
  messageLimit?: number;
  messageWindowMs?: number;
  maxPendingConnections?: number;
  clock?: () => number;
  log?: (line: string) => void;
}

interface NodeRow {
  id: string;
  public_key: string;
  revoked_at: Date | string | null;
  /** Admission of the owning human, re-read on every (re)authentication and ping. */
  admitted: boolean;
}

const CLOSE = {
  badRequest: 1008,
  tooBig: 1009,
  revoked: 4001,
  expired: 4002,
  authFailed: 4003,
  replaced: 4004,
};

export function createDeviceChannel(deps: { db: SqlExecutor; options?: DeviceChannelOptions }) {
  const o = {
    pingIntervalMs: 20_000,
    sessionTtlMs: 10 * 60_000,
    expiringWarnMs: 60_000,
    authTimeoutMs: 10_000,
    maxPayload: 4096,
    messageLimit: 30,
    messageWindowMs: 10_000,
    maxPendingConnections: 100,
    clock: Date.now,
    ...deps.options,
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: o.maxPayload });
  const live = new Map<string, Connection>();
  let pending = 0;

  async function loadNode(deviceId: string): Promise<NodeRow | null> {
    const rows = await deps.db.query<NodeRow>(
      `SELECT d.id, d.public_key, d.revoked_at,
              EXISTS (SELECT 1 FROM admissions ad WHERE ad.clerk_user_id = a.clerk_user_id AND ad.status = 'approved') AS admitted
       FROM devices d JOIN accounts a ON a.id = d.account_id
       WHERE d.id = $1 AND d.type = 'node' AND d.public_key IS NOT NULL`,
      [deviceId],
    );
    return rows.rows[0] ?? null;
  }
  const touch = (deviceId: string) =>
    deps.db.query("UPDATE devices SET last_seen_at = $2 WHERE id = $1 AND revoked_at IS NULL", [
      deviceId,
      new Date(o.clock()),
    ]);

  class Connection {
    state: "hello" | "challenge" | "authed" = "hello";
    deviceId: string | null = null;
    nonce: string | null = null;
    expiresAt = 0;
    warned = false;
    alive = true;
    lastTouch = 0;
    window = { start: o.clock(), count: 0 };
    timers: NodeJS.Timeout[] = [];
    closed = false;
    /** Counted against maxPendingConnections until authenticated. */
    counted = true;
    constructor(readonly ws: WebSocket) {}
    send(message: Record<string, unknown>) {
      if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(message));
    }
    close(code: number, type: string, extra: Record<string, unknown> = {}) {
      if (this.closed) return;
      this.closed = true;
      this.send({ type, ...extra });
      this.ws.close(code);
      this.cleanup();
    }
    cleanup() {
      this.timers.forEach(clearTimeout);
      this.timers = [];
      if (this.deviceId && live.get(this.deviceId) === this) live.delete(this.deviceId);
    }
  }

  function startSession(c: Connection) {
    c.expiresAt = o.clock() + o.sessionTtlMs;
    c.warned = false;
    c.send({
      type: "authenticated",
      sessionExpiresAt: new Date(c.expiresAt).toISOString(),
      pingIntervalMs: o.pingIntervalMs,
    });
  }

  async function tick(c: Connection) {
    if (c.closed || c.state !== "authed" || !c.deviceId) return;
    if (!c.alive) return c.close(CLOSE.badRequest, "disconnect", { reason: "ping_timeout" });
    c.alive = false;
    // Revocation and admission are re-read each cycle so even a multi-instance deployment
    // terminates a revoked device within one interval.
    const row = await loadNode(c.deviceId).catch(() => null);
    if (c.closed) return;
    if (row && (row.revoked_at || !row.admitted)) return c.close(CLOSE.revoked, "revoked");
    const t = o.clock();
    if (t >= c.expiresAt)
      return c.close(CLOSE.expired, "disconnect", { reason: "session_expired" });
    if (!c.warned && t >= c.expiresAt - o.expiringWarnMs) {
      c.warned = true;
      c.send({ type: "session_expiring", sessionExpiresAt: new Date(c.expiresAt).toISOString() });
    }
    c.send({ type: "ping" });
  }

  async function onMessage(c: Connection, raw: string) {
    const t = o.clock();
    if (t - c.window.start > o.messageWindowMs) c.window = { start: t, count: 0 };
    if (++c.window.count > o.messageLimit)
      return c.close(CLOSE.badRequest, "error", { code: "rate_limited" });
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
      message = parsed;
    } catch {
      return c.close(CLOSE.badRequest, "error", { code: "malformed" });
    }
    const type = message.type;

    if (type === "hello" || type === "reauth") {
      if (type === "hello" && c.state !== "hello")
        return c.close(CLOSE.badRequest, "error", { code: "unexpected" });
      if (type === "reauth" && c.state !== "authed")
        return c.close(CLOSE.badRequest, "error", { code: "unexpected" });
      if (type === "hello") {
        const id = message.deviceId;
        if (typeof id !== "string" || id.length > 64 || message.protocol !== PROTOCOL_VERSION) {
          return c.close(CLOSE.badRequest, "error", { code: "bad_hello" });
        }
        c.deviceId = id;
      }
      // Always issue a challenge, even for unknown ids: existence is not disclosed to
      // anyone who cannot sign it.
      c.nonce = randomBytes(24).toString("base64url");
      // A reauth keeps the connection "authed" (pings continue) until the new proof lands.
      if (type === "hello") c.state = "challenge";
      c.send({ type: "challenge", nonce: c.nonce });
      return;
    }
    if (type === "auth") {
      if (c.state === "hello" || !c.nonce || !c.deviceId)
        return c.close(CLOSE.badRequest, "error", { code: "unexpected" });
      const nonce = c.nonce;
      c.nonce = null;
      const row = await loadNode(c.deviceId).catch(() => null);
      if (c.closed) return;
      const proven =
        row !== null &&
        verifySignature(row.public_key, deviceAuthMessage(c.deviceId, nonce), message.signature);
      if (!row || !proven) return c.close(CLOSE.authFailed, "error", { code: "auth_failed" });
      // Only the key holder learns the device is revoked.
      if (row.revoked_at || !row.admitted) return c.close(CLOSE.revoked, "revoked");
      const previous = live.get(c.deviceId);
      if (c.state === "challenge" && previous && previous !== c)
        previous.close(CLOSE.replaced, "disconnect", { reason: "replaced" });
      if (!c.timers.length) {
        if (c.counted) pending = Math.max(0, pending - 1);
        c.counted = false;
        const interval = setInterval(() => void tick(c), o.pingIntervalMs);
        interval.unref();
        c.timers.push(interval);
      }
      clearTimeout(authTimer.get(c));
      live.set(c.deviceId, c);
      c.state = "authed";
      c.alive = true;
      startSession(c);
      await touch(c.deviceId).catch(() => undefined);
      return;
    }
    if (c.state !== "authed" || !c.deviceId)
      return c.close(CLOSE.badRequest, "error", { code: "unauthenticated" });
    if (type === "pong" || type === "heartbeat") {
      c.alive = true;
      if (t - c.lastTouch >= o.pingIntervalMs / 2) {
        c.lastTouch = t;
        await touch(c.deviceId).catch(() => undefined);
      }
      if (type === "heartbeat") c.send({ type: "pong" });
      return;
    }
    if (type === "capabilities") {
      const caps = message.capabilities;
      if (
        !Array.isArray(caps) ||
        caps.length > 16 ||
        !caps.every((x) => (DEVICE_CAPABILITIES as readonly string[]).includes(x as string))
      ) {
        return c.close(CLOSE.badRequest, "error", { code: "bad_capabilities" });
      }
      // Descriptive only; never an authorization input.
      await deps.db.query(
        "UPDATE devices SET capabilities = $2 WHERE id = $1 AND revoked_at IS NULL",
        [c.deviceId, [...new Set(caps)]],
      );
      return;
    }
    return c.close(CLOSE.badRequest, "error", { code: "unknown_type" });
  }
  const authTimer = new WeakMap<Connection, NodeJS.Timeout>();

  wss.on("connection", (ws) => {
    const c = new Connection(ws);
    pending += 1;
    const timer = setTimeout(() => {
      if (c.state !== "authed") c.close(CLOSE.authFailed, "error", { code: "auth_timeout" });
    }, o.authTimeoutMs);
    timer.unref();
    authTimer.set(c, timer);
    ws.on("message", (data, isBinary) => {
      if (isBinary) return c.close(CLOSE.badRequest, "error", { code: "binary_unsupported" });
      onMessage(c, data.toString("utf8")).catch(() =>
        c.close(CLOSE.badRequest, "error", { code: "internal" }),
      );
    });
    ws.on("error", () => c.cleanup());
    ws.on("close", () => {
      clearTimeout(timer);
      if (c.counted) pending = Math.max(0, pending - 1);
      c.closed = true;
      c.cleanup();
    });
  });

  return {
    /** Routes upgrade requests for the device channel; everything else is left alone. */
    attach(server: Server) {
      server.on("upgrade", (request: IncomingMessage, socket: Duplex, head) => {
        const url = new URL(request.url ?? "/", "http://x");
        if (url.pathname !== DEVICE_CHANNEL_PATH) return;
        // Native clients send no Origin; a browser-originated upgrade is refused.
        if (request.headers.origin || pending >= o.maxPendingConnections) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
      });
    },
    isLive: (deviceId: string) => live.has(deviceId),
    liveCount: () => live.size,
    /** Closes a device's live connection (revocation). */
    closeDevice(deviceId: string, reason: "revoked" | "terminate" = "revoked") {
      const c = live.get(deviceId);
      if (!c) return;
      if (reason === "revoked") c.close(CLOSE.revoked, "revoked");
      else c.ws.terminate();
    },
    /** Terminates every live connection but keeps accepting new ones (a listener restart). */
    dropAll() {
      for (const c of live.values()) c.ws.terminate();
      live.clear();
    },
    close() {
      this.dropAll();
      wss.close();
    },
  };
}
export type DeviceChannel = ReturnType<typeof createDeviceChannel>;
