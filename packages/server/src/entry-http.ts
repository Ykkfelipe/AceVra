import { createLocalServices, getAppConfigDir } from "@zcode/services/node";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "./bundledZCodeBuiltinProviderConfig.js";
import { createHttpServer, setupChannelServer } from "./http.js";
import { WebSocket } from "ws";
import { createHash } from "node:crypto";
import { hostname } from "node:os";

/** 开发期诊断日志：只输出脱敏、缩写 ID，且仅在 ZCODE_FORK_RELAY_DEBUG=1 时启用。 */
const relayDebug = (event: string, fields: Record<string, unknown> = {}) => {
  if (process.env.ZCODE_FORK_RELAY_DEBUG !== "1") return;
  console.info("[fork-relay]", event, fields);
};

const shortId = (value: string | undefined) => (value ? `${value.slice(0, 8)}…` : undefined);

interface RelayControlFrame {
  type?: string;
  attachmentId?: string;
}

function parseRelayControlFrame(data: unknown): RelayControlFrame | undefined {
  try {
    const parsed: unknown = JSON.parse(String(data));
    return parsed && typeof parsed === "object" ? (parsed as RelayControlFrame) : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledZCodeBuiltinProviderConfig(),
  });
  const port = Number(process.env["PORT"]) || 3030;
  const host = process.env["ZCODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || undefined;
  const staticRoot = process.env["ZCODE_WEB_STATIC_ROOT"]?.trim() || undefined;
  const authToken = process.env["ZCODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  const services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: Boolean(authToken),
  });

  createHttpServer(services, port, {
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
  });

  const relayUrl = process.env.ZCODE_FORK_RELAY_URL?.trim();
  const relayToken = process.env.ZCODE_FORK_RELAY_DEVICE_TOKEN?.trim();
  const ownerUserId = process.env.ZCODE_FORK_ALLOWED_CLERK_USER_IDS?.split(",")[0]?.trim();
  if (relayUrl && relayToken && ownerUserId) {
    const displayName = process.env.ZCODE_FORK_DEVICE_NAME?.trim() || hostname();
    const deviceId = createHash("sha256")
      .update(`${displayName}:${process.platform}`)
      .digest("hex")
      .slice(0, 16);
    const relayOrigin = relayUrl.replace(/\/$/u, "");
    const deviceQuery = `deviceId=${encodeURIComponent(deviceId)}&ownerUserId=${encodeURIComponent(ownerUserId)}&displayName=${encodeURIComponent(displayName)}`;
    /** attachmentId → attachment socket。每个浏览器对应一条独立连接。 */
    const attachments = new Map<string, WebSocket>();

    /**
     * 每个浏览器 attachment 一条独立连接。channel server 必须在这里创建：
     * 它的 Initialize 只在构造时发送一次，必须发在浏览器连接建立之后，
     * 否则客户端的 ChannelClient 永远停在 Uninitialized，不会写出任何请求帧。
     */
    const connectAttachment = (attachmentId: string) => {
      if (attachments.has(attachmentId)) return;
      const socket = new WebSocket(
        `${relayOrigin}/fork/relay/device?${deviceQuery}&attachmentId=${encodeURIComponent(attachmentId)}`,
        { headers: { "x-zcode-device-token": relayToken } },
      );
      attachments.set(attachmentId, socket);
      socket.once("open", () => {
        relayDebug("mac_attachment_opened", { attachmentId: shortId(attachmentId) });
        setupChannelServer(socket, services, "web-remote-replayable");
      });
      const forget = (event: string, fields: Record<string, unknown>) => {
        attachments.delete(attachmentId);
        relayDebug(event, { attachmentId: shortId(attachmentId), ...fields });
      };
      socket.once("close", (code, reason) =>
        forget("mac_attachment_closed", { code, reason: reason.toString() }),
      );
      socket.once("error", (error) => {
        forget("mac_attachment_error", { message: error.message });
        socket.close();
      });
    };

    const closeAttachments = (reason: string) => {
      for (const [attachmentId, socket] of attachments) {
        attachments.delete(attachmentId);
        relayDebug("mac_attachment_dropped", { attachmentId: shortId(attachmentId), reason });
        socket.close();
      }
    };

    const connectPresence = () => {
      relayDebug("mac_connecting", { deviceId: shortId(deviceId), relayUrl });
      const socket = new WebSocket(`${relayOrigin}/fork/relay/device?${deviceQuery}`, {
        headers: { "x-zcode-device-token": relayToken },
      });
      socket.once("open", () => {
        relayDebug("mac_connected", { deviceId: shortId(deviceId) });
      });
      // presence socket 只承载控制帧；RPC 字节走 attachment socket。
      socket.on("message", (data) => {
        const frame = parseRelayControlFrame(data);
        if (!frame?.type || !frame.attachmentId) {
          relayDebug("mac_control_unparsed", { raw: String(data).slice(0, 120) });
          return;
        }
        if (frame.type === "attach") {
          connectAttachment(frame.attachmentId);
          return;
        }
        if (frame.type === "detach") {
          const attachment = attachments.get(frame.attachmentId);
          attachments.delete(frame.attachmentId);
          relayDebug("mac_attachment_detached", { attachmentId: shortId(frame.attachmentId) });
          attachment?.close();
          return;
        }
        relayDebug("mac_control_unknown", { type: frame.type });
      });
      socket.once("close", (code, reason) => {
        relayDebug("mac_closed", { code, reason: reason.toString() });
        // presence 断开代表本机在 relay 侧下线，本地 attachment 也必须一起结束。
        closeAttachments("presence_closed");
        setTimeout(connectPresence, 2_000);
      });
      socket.once("error", (error) => {
        relayDebug("mac_error", { message: error.message });
        socket.close();
      });
    };
    connectPresence();
  }
}

void main().catch((error: unknown) => {
  console.error("[zcode-server:http] startup failed", error);
  process.exitCode = 1;
});
