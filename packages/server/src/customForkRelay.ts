import { randomBytes, randomUUID } from "node:crypto";
import type { WebSocket } from "ws";

export interface ForkRelayDevice {
  deviceId: string;
  displayName: string;
  ownerUserId: string;
  online: boolean;
  lastSeenAt: string;
  connectionId?: string;
}

interface DeviceConnection {
  device: ForkRelayDevice;
  socket: WebSocket;
}

interface PairingRecord {
  tokenHash: string;
  ownerUserId: string;
  expiresAt: number;
}

/**
 * 一次浏览器 attachment。
 * `ChannelServer` 的 `ResponseType.Initialize` 只在构造时发送一次，`ChannelClient`
 * 收到它之前不会写出任何请求帧；因此每个浏览器都必须对应一个独立的 device 连接
 * 与 channel server，否则浏览器会永远停在 Uninitialized（只看到静态外壳）。
 */
interface RelayAttachment {
  attachmentId: string;
  deviceId: string;
  ownerUserId: string;
  browser: WebSocket;
  createdAt: number;
  deviceSocket?: WebSocket;
  detach?: () => void;
  setupTimer?: NodeJS.Timeout;
}

type RelayFrame = Buffer | ArrayBuffer | Buffer[];

const ATTACHMENT_SETUP_TIMEOUT_MS = 10_000;
/** 浏览器连接关闭：客户端会重新发起，不能让 Mac 侧继续持有 channel server。 */
const ATTACHMENT_BROWSER_CLOSED = 4006;
/** 浏览器已连接但 Mac 未在期限内 attach。 */
const ATTACHMENT_SETUP_TIMEOUT = 4008;

const devices = new Map<string, DeviceConnection>();
const pairings = new Map<string, PairingRecord>();
const attachments = new Map<string, RelayAttachment>();
const connectionTickets = new Map<
  string,
  { ownerUserId: string; deviceId: string; expiresAt: number }
>();

/** 开发期诊断日志：只输出脱敏、缩写 ID，且仅在 ZCODE_FORK_RELAY_DEBUG=1 时启用。 */
export const relayDebug = (event: string, fields: Record<string, unknown> = {}) => {
  if (process.env.ZCODE_FORK_RELAY_DEBUG !== "1") return;
  console.info("[fork-relay]", event, fields);
};

export const shortId = (value: string | undefined) => (value ? `${value.slice(0, 8)}…` : undefined);

const rawDataSize = (data: RelayFrame) =>
  data instanceof ArrayBuffer
    ? data.byteLength
    : Array.isArray(data)
      ? data.reduce((total, part) => total + part.length, 0)
      : data.length;

function hash(value: string): string {
  return Buffer.from(value).toString("base64url");
}

export function registerRelayDevice(
  device: Omit<ForkRelayDevice, "online" | "lastSeenAt">,
  socket: WebSocket,
) {
  const record: ForkRelayDevice = {
    ...device,
    online: true,
    lastSeenAt: new Date().toISOString(),
    connectionId: randomUUID(),
  };
  devices.get(device.deviceId)?.socket.close(4000, "Replaced by newer device connection");
  devices.set(device.deviceId, { device: record, socket });
  relayDebug("device_registered", {
    deviceId: shortId(device.deviceId),
    ownerUserId: shortId(device.ownerUserId),
    connectionId: shortId(record.connectionId),
  });
  const heartbeat = () => {
    const current = devices.get(device.deviceId);
    if (current?.socket === socket) {
      current.device.online = true;
      current.device.lastSeenAt = new Date().toISOString();
      relayDebug("device_heartbeat", { deviceId: shortId(device.deviceId) });
    }
  };
  socket.on("pong", heartbeat);
  const pingTimer = setInterval(() => {
    if (socket.readyState === socket.OPEN) socket.ping();
  }, 15_000);
  socket.on("close", () => {
    clearInterval(pingTimer);
    const current = devices.get(device.deviceId);
    if (current?.socket === socket) {
      current.device.online = false;
      current.device.lastSeenAt = new Date().toISOString();
      devices.set(device.deviceId, { device: current.device, socket });
      relayDebug("device_offline", { deviceId: shortId(device.deviceId) });
    }
    // 设备下线后它持有的 attachment socket 也已失效；浏览器必须立刻失败，
    // 而不是留在一个永远收不到响应的 pipe 上。
    disposeDeviceAttachments(device.deviceId, "device_offline");
  });
  return record;
}

export function listRelayDevices(ownerUserId: string): ForkRelayDevice[] {
  return [...devices.values()]
    .filter(({ device }) => device.ownerUserId === ownerUserId)
    .map(({ device }) => ({ ...device }));
}

export function getRelayDevice(
  ownerUserId: string,
  deviceId: string,
): DeviceConnection | undefined {
  const connection = devices.get(deviceId);
  return connection?.device.ownerUserId === ownerUserId ? connection : undefined;
}

export function issuePairingToken(ownerUserId: string): string {
  const token = randomBytes(32).toString("base64url");
  pairings.set(hash(token), {
    tokenHash: hash(token),
    ownerUserId,
    expiresAt: Date.now() + 60_000,
  });
  return token;
}

export function consumePairingToken(token: string, ownerUserId: string): boolean {
  const key = hash(token);
  const record = pairings.get(key);
  pairings.delete(key);
  return Boolean(record && record.ownerUserId === ownerUserId && record.expiresAt > Date.now());
}

export function issueRelayConnectionTicket(ownerUserId: string, deviceId: string): string {
  const token = randomBytes(32).toString("base64url");
  connectionTickets.set(hash(token), { ownerUserId, deviceId, expiresAt: Date.now() + 30_000 });
  relayDebug("relay_ticket_issued", {
    ownerUserId: shortId(ownerUserId),
    deviceId: shortId(deviceId),
  });
  return token;
}

export function consumeRelayConnectionTicket(
  token: string,
  ownerUserId: string,
  deviceId: string,
): boolean {
  const key = hash(token);
  const record = connectionTickets.get(key);
  connectionTickets.delete(key);
  return Boolean(
    record &&
    record.ownerUserId === ownerUserId &&
    record.deviceId === deviceId &&
    record.expiresAt > Date.now(),
  );
}

export function consumeRelayConnectionTicketForDevice(
  token: string,
  deviceId: string,
): string | undefined {
  const key = hash(token);
  const record = connectionTickets.get(key);
  connectionTickets.delete(key);
  const reason = !record
    ? "missing_or_replayed"
    : record.deviceId !== deviceId
      ? "device_mismatch"
      : record.expiresAt <= Date.now()
        ? "expired"
        : undefined;
  relayDebug(reason ? "relay_ticket_rejected" : "relay_ticket_consumed", {
    deviceId: shortId(deviceId),
    ...(reason ? { reason } : { ownerUserId: shortId(record?.ownerUserId) }),
  });
  return reason ? undefined : record?.ownerUserId;
}

/**
 * 向设备的 presence/control socket 发送 JSON 控制帧。
 * presence socket 只承载控制帧（attach/detach），RPC 字节只走 attachment socket。
 */
function sendDeviceControl(deviceId: string, message: Record<string, unknown>): boolean {
  const connection = devices.get(deviceId);
  if (!connection || connection.socket.readyState !== connection.socket.OPEN) return false;
  connection.socket.send(JSON.stringify(message));
  return true;
}

/** 释放一个 attachment：摘掉 pipe、通知 Mac detach、关闭浏览器与 attachment socket。 */
export function disposeRelayAttachment(attachmentId: string, reason: string): void {
  const attachment = attachments.get(attachmentId);
  if (!attachment) return;
  attachments.delete(attachmentId);
  if (attachment.setupTimer) clearTimeout(attachment.setupTimer);
  // 先摘监听再关闭：既避免关闭过程中继续转发，也避免 device socket 上累积监听器。
  attachment.detach?.();
  const { browser, deviceSocket } = attachment;
  if (deviceSocket) {
    sendDeviceControl(attachment.deviceId, { type: "detach", attachmentId });
    if (deviceSocket.readyState === deviceSocket.OPEN) {
      deviceSocket.close(1000, "Attachment detached");
    }
  }
  if (browser.readyState === browser.OPEN) {
    browser.close(ATTACHMENT_BROWSER_CLOSED, "Attachment closed");
  }
  relayDebug("attachment_disposed", {
    attachmentId: shortId(attachmentId),
    deviceId: shortId(attachment.deviceId),
    reason,
    paired: Boolean(deviceSocket),
  });
}

function disposeDeviceAttachments(deviceId: string, reason: string): void {
  // 先固定 key 列表再释放：disposeRelayAttachment 会删除 map 条目。
  const attachmentIds = Array.from(attachments.keys()).filter(
    (attachmentId) => attachments.get(attachmentId)?.deviceId === deviceId,
  );
  for (const attachmentId of attachmentIds) {
    disposeRelayAttachment(attachmentId, reason);
  }
}

/**
 * 浏览器侧建立 attachment 并通知 Mac 开一条专用 device 连接。
 * 返回 undefined 表示没有可用 Mac，调用方必须关闭浏览器 socket。
 */
export function createRelayAttachment(options: {
  deviceId: string;
  ownerUserId: string;
  browser: WebSocket;
}): string | undefined {
  const { deviceId, ownerUserId, browser } = options;
  const connection = devices.get(deviceId);
  if (!connection || !connection.device.online) {
    relayDebug("attachment_rejected", { deviceId: shortId(deviceId), reason: "device_offline" });
    return undefined;
  }
  const attachmentId = randomUUID();
  const attachment: RelayAttachment = {
    attachmentId,
    deviceId,
    ownerUserId,
    browser,
    createdAt: Date.now(),
  };
  attachments.set(attachmentId, attachment);
  attachment.setupTimer = setTimeout(() => {
    const current = attachments.get(attachmentId);
    if (current && !current.deviceSocket && current.browser.readyState === current.browser.OPEN) {
      current.browser.close(ATTACHMENT_SETUP_TIMEOUT, "Mac attachment setup timed out");
    }
    disposeRelayAttachment(attachmentId, "setup_timeout");
  }, ATTACHMENT_SETUP_TIMEOUT_MS);
  browser.on("close", () => disposeRelayAttachment(attachmentId, "browser_closed"));
  browser.on("error", () => disposeRelayAttachment(attachmentId, "browser_error"));
  if (!sendDeviceControl(deviceId, { type: "attach", attachmentId })) {
    disposeRelayAttachment(attachmentId, "device_control_unavailable");
    return undefined;
  }
  relayDebug("attachment_created", {
    attachmentId: shortId(attachmentId),
    deviceId: shortId(deviceId),
    ownerUserId: shortId(ownerUserId),
  });
  return attachmentId;
}

/**
 * Mac 侧的 attachment socket：校验后与浏览器 socket 对接成双向 pipe。
 * 只有在这一步之后 Mac 才创建 channel server，因此它的 Initialize 必然发给已连接的浏览器。
 */
export function attachRelayDeviceSocket(
  attachmentId: string,
  deviceId: string,
  socket: WebSocket,
): boolean {
  const attachment = attachments.get(attachmentId);
  const reject = (reason: string) => {
    relayDebug("attachment_socket_rejected", {
      attachmentId: shortId(attachmentId),
      deviceId: shortId(deviceId),
      reason,
    });
    socket.close(4004, `Attachment rejected: ${reason}`);
    return false;
  };
  if (!attachment) return reject("unknown_attachment");
  if (attachment.deviceId !== deviceId) return reject("device_mismatch");
  if (attachment.deviceSocket) return reject("already_attached");
  if (attachment.browser.readyState !== attachment.browser.OPEN) return reject("browser_gone");

  if (attachment.setupTimer) {
    clearTimeout(attachment.setupTimer);
    attachment.setupTimer = undefined;
  }
  const browser = attachment.browser;
  attachment.deviceSocket = socket;
  let browserFrames = 0;
  let deviceFrames = 0;
  const browserToDevice = (data: RelayFrame) => {
    if (browserFrames++ === 0) {
      relayDebug("first_browser_to_mac_frame", {
        attachmentId: shortId(attachmentId),
        bytes: rawDataSize(data),
      });
    }
    if (socket.readyState === socket.OPEN) socket.send(data);
  };
  const deviceToBrowser = (data: RelayFrame) => {
    if (deviceFrames++ === 0) {
      relayDebug("first_mac_to_browser_frame", {
        attachmentId: shortId(attachmentId),
        bytes: rawDataSize(data),
      });
    }
    if (browser.readyState === browser.OPEN) browser.send(data);
  };
  browser.on("message", browserToDevice);
  socket.on("message", deviceToBrowser);
  attachment.detach = () => {
    browser.off("message", browserToDevice);
    socket.off("message", deviceToBrowser);
  };
  socket.on("close", () => disposeRelayAttachment(attachmentId, "device_socket_closed"));
  relayDebug("attachment_paired", {
    attachmentId: shortId(attachmentId),
    deviceId: shortId(deviceId),
  });
  return true;
}
