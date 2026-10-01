import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { DEVICE_CAPABILITIES } from "./devices.js";
import type { SqlExecutor } from "./ports.js";
import { verifySignature } from "./pairing.js";
import { parseTaskMessage } from "./taskProtocol.js";
import type { TaskService } from "./tasks.js";

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
  /** Pre-authentication message budget per window (hello/auth only). */
  preAuthMessageLimit?: number;
  /** Cumulative `task.ack` cadence for node events. */
  ackEvery?: number;
  /** Control-plane reconciliation interval (offers, unknown tasks, expiry). */
  sweepIntervalMs?: number;
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

export function createDeviceChannel(deps: {
  db: SqlExecutor;
  tasks?: TaskService;
  options?: DeviceChannelOptions;
}) {
  const tasks = deps.tasks;
  const o = {
    pingIntervalMs: 20_000,
    sessionTtlMs: 10 * 60_000,
    expiringWarnMs: 60_000,
    authTimeoutMs: 10_000,
    // Task frames carry up to ~8 KiB specs and output chunks (JSON-escaped); still tightly bounded.
    maxPayload: 32_768,
    messageLimit: 400,
    preAuthMessageLimit: 10,
    ackEvery: 16,
    sweepIntervalMs: 5000,
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
    /** Set once the node sent task.sync; offers are only sent after reconciliation. */
    synced = false;
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
      if (this.deviceId && live.get(this.deviceId) === this) {
        live.delete(this.deviceId);
        // Running work becomes "unknown" (never assumed failed); the node reconciles on reconnect.
        void tasks?.markDisconnected(this.deviceId).catch(() => undefined);
      }
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
    const limit = c.state === "authed" ? o.messageLimit : o.preAuthMessageLimit;
    if (++c.window.count > limit)
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
    if (typeof type === "string" && type.startsWith("task.")) {
      const task = tasks ? parseTaskMessage(message) : null;
      if (!task) return c.close(CLOSE.badRequest, "error", { code: "bad_task_message" });
      await handleTask(c, task);
      return;
    }
    return c.close(CLOSE.badRequest, "error", { code: "unknown_type" });
  }
  async function offerNext(c: Connection) {
    if (!tasks || !c.deviceId || c.closed || !c.synced) return;
    const offer = await tasks.dispatchNext(c.deviceId);
    if (offer)
      c.send({
        type: "task.offer",
        taskId: offer.taskId,
        attempt: offer.attempt,
        process: offer.spec,
      });
  }
  /** Every handler acts only for the connection's AUTHENTICATED device id (ownership fence). */
  async function handleTask(c: Connection, m: NonNullable<ReturnType<typeof parseTaskMessage>>) {
    const deviceId = c.deviceId!;
    switch (m.type) {
      case "task.sync": {
        const { cancel } = await tasks!.sync(deviceId, m.active);
        for (const taskId of cancel) c.send({ type: "task.cancel", taskId });
        c.synced = true;
        return void (await offerNext(c));
      }
      case "task.accept": {
        const r = await tasks!.accept(deviceId, m);
        if (r.status === "stale" || r.cancel) c.send({ type: "task.cancel", taskId: m.taskId });
        return;
      }
      case "task.reject":
        await tasks!.reject(deviceId, m);
        return void (await offerNext(c));
      case "task.event": {
        const r = await tasks!.event(deviceId, m);
        if (r.status === "gone")
          c.send({ type: "task.ack", taskId: m.taskId, seq: m.seq, terminal: true });
        else if (r.status === "ok" && m.seq % o.ackEvery === 0)
          c.send({ type: "task.ack", taskId: m.taskId, seq: m.seq });
        return;
      }
      case "task.complete":
      case "task.fail": {
        await tasks!.finish(deviceId, {
          taskId: m.taskId,
          attempt: m.attempt,
          seq: m.seq,
          ok: m.type === "task.complete",
          reason: m.type === "task.fail" ? m.reason : undefined,
          result: m.result,
        });
        c.send({ type: "task.ack", taskId: m.taskId, seq: m.seq, terminal: true });
        return void (await offerNext(c));
      }
    }
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
    // Messages are processed strictly in arrival order: task state transitions (sync before
    // offers, terminal before sync) depend on it.
    let chain: Promise<void> = Promise.resolve();
    ws.on("message", (data, isBinary) => {
      if (isBinary) return c.close(CLOSE.badRequest, "error", { code: "binary_unsupported" });
      const text = data.toString("utf8");
      chain = chain
        .then(() => onMessage(c, text))
        .catch(() => c.close(CLOSE.badRequest, "error", { code: "internal" }));
    });
    ws.on("error", () => c.cleanup());
    ws.on("close", () => {
      clearTimeout(timer);
      if (c.counted) pending = Math.max(0, pending - 1);
      c.closed = true;
      c.cleanup();
    });
  });

  const sweeper = tasks
    ? setInterval(
        () =>
          void tasks
            .sweep()
            .then(() => api.kickAll())
            .catch(() => undefined),
        o.sweepIntervalMs,
      )
    : null;
  sweeper?.unref();

  const api = {
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
    /** Offer the next queued task to a device if it is live and reconciled. */
    async kick(deviceId: string) {
      const c = live.get(deviceId);
      if (c) await offerNext(c).catch(() => undefined);
    },
    async kickAll() {
      for (const c of live.values()) await offerNext(c).catch(() => undefined);
    },
    sendCancel(deviceId: string, taskId: string) {
      live.get(deviceId)?.send({ type: "task.cancel", taskId });
    },
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
      // Each close handler removes its entry and marks its running tasks "unknown".
      for (const c of Array.from(live.values())) c.ws.terminate();
    },
    close() {
      this.dropAll();
      if (sweeper) clearInterval(sweeper);
      wss.close();
    },
  };
  return api;
}
export type DeviceChannel = ReturnType<typeof createDeviceChannel>;
