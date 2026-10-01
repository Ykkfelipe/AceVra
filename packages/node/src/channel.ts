import WebSocket from "ws";
import type { NodeCapability } from "./capabilities.js";
import type { Connection } from "./state.js";

export const deviceAuthMessage = (deviceId: string, nonce: string) =>
  `acevra-device-auth:v1:${deviceId}:${nonce}`;

export interface NodeChannelOptions {
  wsUrl: string;
  deviceId: string;
  sign(message: string): string;
  capabilities: NodeCapability[];
  onStatus(status: {
    connection: Connection;
    lastConnectedAt?: string;
    sessionExpiresAt?: string;
  }): void;
  log?(event: string, facts?: Record<string, string | number | undefined>): void;
  /** Reconnect backoff bounds. */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Consecutive auth failures tolerated before giving up. */
  maxAuthFailures?: number;
  random?: () => number;
}

/**
 * Outbound-only realtime channel: this node dials the control plane; nothing listens on the
 * node. Authenticates with a signed server nonce (no bearer token on disk). Reconnects with
 * jittered backoff after any drop, re-proving the same identity, so reconnects never need a
 * new pairing and never create a new device. A `revoked` message is terminal.
 */
export function createNodeChannel(options: NodeChannelOptions) {
  const min = options.minDelayMs ?? 1000;
  const max = options.maxDelayMs ?? 30_000;
  const random = options.random ?? Math.random;
  let socket: WebSocket | null = null;
  let stopped = false;
  let terminal = false;
  let delay = min;
  let authFailures = 0;
  let timer: NodeJS.Timeout | null = null;
  let lastConnectedAt: string | undefined;

  const set = (connection: Connection, extra: { sessionExpiresAt?: string } = {}) =>
    options.onStatus({ connection, lastConnectedAt, ...extra });

  function connect() {
    if (stopped || terminal) return;
    set("connecting");
    const ws = new WebSocket(options.wsUrl, { handshakeTimeout: 10_000, maxPayload: 4096 });
    socket = ws;
    ws.on("open", () =>
      ws.send(JSON.stringify({ type: "hello", deviceId: options.deviceId, protocol: 1 })),
    );
    ws.on("message", (data) => {
      let message: { type?: string; [k: string]: unknown };
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      switch (message.type) {
        case "challenge":
          ws.send(
            JSON.stringify({
              type: "auth",
              signature: options.sign(deviceAuthMessage(options.deviceId, String(message.nonce))),
            }),
          );
          break;
        case "authenticated":
          authFailures = 0;
          delay = min;
          lastConnectedAt = new Date().toISOString();
          options.log?.("connected");
          set("connected", { sessionExpiresAt: String(message.sessionExpiresAt) });
          ws.send(JSON.stringify({ type: "capabilities", capabilities: options.capabilities }));
          break;
        case "ping":
          ws.send(JSON.stringify({ type: "pong" }));
          break;
        case "session_expiring":
          // Renew by re-proving key possession in-band; no token is ever stored.
          ws.send(JSON.stringify({ type: "reauth" }));
          break;
        case "revoked":
          terminal = true;
          options.log?.("revoked");
          set("revoked");
          ws.close();
          break;
        case "error":
          if (message.code === "auth_failed" && ++authFailures >= (options.maxAuthFailures ?? 3)) {
            terminal = true;
            options.log?.("auth-failed");
            set("auth-failed");
          }
          break;
        default:
          break; // disconnect / unknown: the close handler decides what happens next
      }
    });
    ws.on("error", () => undefined);
    ws.on("close", () => {
      if (socket === ws) socket = null;
      if (stopped || terminal) return;
      set("offline");
      const wait = Math.round(delay * (0.5 + random() * 0.5));
      delay = Math.min(max, delay * 2);
      options.log?.("reconnecting", { inMs: wait });
      timer = setTimeout(connect, wait);
    });
  }

  return {
    start: connect,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket?.terminate();
      set("stopped");
    },
    /** True once the control plane told this node it is revoked or auth is hopeless. */
    isTerminal: () => terminal,
  };
}
