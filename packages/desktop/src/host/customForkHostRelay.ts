import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { WebSocket } from "ws";
import type { ServiceCollection } from "@zcode/services";
import { setupChannelServer } from "@zcode/server/service-channel";

interface RelayControlFrame {
  readonly type?: string;
  readonly attachmentId?: string;
}

export interface CustomForkHostRelayOptions {
  readonly services: ServiceCollection;
  readonly env?: Record<string, string | undefined>;
  readonly onLog?: (message: string, fields?: Record<string, unknown>) => void;
}

/** Electron utility Host owns its relay presence and every replayable service attachment. */
export function startCustomForkHostRelay(
  options: CustomForkHostRelayOptions,
): { dispose(): void } | null {
  const env = options.env ?? process.env;
  if (env.ZCODE_FORK_DEV?.trim() !== "1") return null;

  const relayBase = env.ZCODE_FORK_RELAY_URL?.trim();
  const deviceToken = env.ZCODE_FORK_RELAY_DEVICE_TOKEN?.trim();
  const ownerUserId = env.ZCODE_FORK_ALLOWED_CLERK_USER_IDS?.split(",")[0]?.trim();
  if (!relayBase || !deviceToken || !ownerUserId) {
    options.onLog?.("AceVra relay is not configured; local Host remains available");
    return null;
  }

  const relayUrl = new URL("/fork/relay/device", relayBase);
  if (relayUrl.protocol !== "ws:" && relayUrl.protocol !== "wss:") {
    options.onLog?.("AceVra relay URL must use ws or wss");
    return null;
  }
  const displayName = env.ZCODE_FORK_DEVICE_NAME?.trim() || hostname();
  const deviceId = createHash("sha256")
    .update(`${displayName}:${process.platform}`)
    .digest("hex")
    .slice(0, 16);
  const baseQuery = new URLSearchParams({
    deviceId,
    ownerUserId,
    displayName,
  });
  const attachments = new Map<string, WebSocket>();
  let disposed = false;
  let generation = 0;
  let presence: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const clearAttachments = () => {
    for (const socket of attachments.values()) socket.close();
    attachments.clear();
  };

  const connectAttachment = (attachmentId: string, currentGeneration: number) => {
    if (disposed || currentGeneration !== generation || attachments.has(attachmentId)) return;
    const url = new URL(relayUrl);
    url.search = baseQuery.toString();
    url.searchParams.set("attachmentId", attachmentId);
    const socket = new WebSocket(url, { headers: { "x-zcode-device-token": deviceToken } });
    attachments.set(attachmentId, socket);
    socket.once("open", () => {
      if (
        disposed ||
        currentGeneration !== generation ||
        attachments.get(attachmentId) !== socket
      ) {
        socket.close();
        return;
      }
      setupChannelServer(socket, options.services, "web-remote-replayable");
      options.onLog?.("AceVra browser attachment connected", { attachmentId });
    });
    const forget = () => {
      if (attachments.get(attachmentId) === socket) attachments.delete(attachmentId);
    };
    socket.once("close", forget);
    socket.once("error", forget);
  };

  const connectPresence = () => {
    if (disposed) return;
    const currentGeneration = ++generation;
    const url = new URL(relayUrl);
    url.search = baseQuery.toString();
    const socket = new WebSocket(url, { headers: { "x-zcode-device-token": deviceToken } });
    presence = socket;
    socket.once("open", () => {
      if (presence !== socket || currentGeneration !== generation) return socket.close();
      options.onLog?.("AceVra Host connected to relay", { deviceId });
    });
    socket.on("message", (raw: Buffer | ArrayBuffer) => {
      if (presence !== socket || currentGeneration !== generation) return;
      let frame: RelayControlFrame | undefined;
      try {
        const parsed: unknown = JSON.parse(String(raw));
        if (parsed && typeof parsed === "object") frame = parsed as RelayControlFrame;
      } catch {
        return;
      }
      if (!frame?.attachmentId) return;
      if (frame.type === "attach") connectAttachment(frame.attachmentId, currentGeneration);
      if (frame.type === "detach") attachments.get(frame.attachmentId)?.close();
    });
    const reconnect = () => {
      if (presence !== socket || disposed || currentGeneration !== generation) return;
      presence = null;
      clearAttachments();
      options.onLog?.("AceVra relay disconnected; retrying");
      reconnectTimer = setTimeout(connectPresence, 2_000);
      reconnectTimer.unref?.();
    };
    socket.once("close", reconnect);
    socket.once("error", () => socket.close());
  };

  connectPresence();
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      clearAttachments();
      presence?.close();
      presence = null;
      options.onLog?.("AceVra Host relay disposed");
    },
  };
}
