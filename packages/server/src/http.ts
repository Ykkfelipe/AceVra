/* eslint-disable max-lines -- HTTP、WebSocket 与静态资源路由集中注册，保持同一鉴权顺序。 */
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { hostname } from "node:os";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WebSocket } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  LoggingChannelServer,
  type ISocket,
} from "@zcode/rpc";
import {
  ServiceCollection,
  IZCodeAgentService,
  createZCodeAgentConnectionScope,
  IFileService,
  IGitService,
  ISystemService,
  ITerminalService,
  IProviderProvisioningTargetService,
} from "@zcode/services";
import {
  formatLogPrefix,
  formatZodError,
  remoteTargetSchema,
  SERVER_REMOTE_PROTOCOL_VERSION,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  ZCODE_VERSION,
  type ServerRemoteInfo,
  type ServerRemoteWorkspaceInfo,
  resolveCustomForkProductConfig,
} from "@zcode/shared";
import { connectRemote, createRemoteBackend, type RemoteConnection } from "./remote/index.js";
import { createHostCapabilityStore } from "./hostCapability.js";
import {
  attachRelayDeviceSocket,
  consumeRelayConnectionTicketForDevice,
  createRelayAttachment,
  getRelayDevice,
  issuePairingToken,
  issueRelayConnectionTicket,
  listRelayDevices,
  registerRelayDevice,
  relayDebug,
  shortId,
} from "./customForkRelay.js";
import {
  authenticateCustomForkClerk,
  isCustomForkClerkUserAllowed,
} from "./customForkClerkAuth.js";

function wrapWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.buffer);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("zcode-server:http", process.pid), ...args);

export function setupChannelServer(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
) {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  // 用日志中间件包装，统一记录所有 RPC 调用
  const server = new LoggingChannelServer(rawServer, log);
  const agentService = services.getOptional(IZCodeAgentService);
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(agentService, {
        connectionId: `server-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
      })
    : undefined;
  const overrides = new Map<string, unknown>();
  if (connectionScope) {
    overrides.set(IZCodeAgentService.channelName, connectionScope.service);
  }
  // Provisioning 携带跨 Environment 凭据，只允许 Desktop trusted host 使用；普通 Web
  // remote/replayable 客户端即使知道频道名，也不能获得 target 写入接口。
  if (
    clientMode !== "desktop-continuous" &&
    services.getOptional(IProviderProvisioningTargetService)
  ) {
    overrides.set(IProviderProvisioningTargetService.channelName, {
      apply: async () => {
        throw new Error("Provider Provisioning 仅支持受信 Desktop Host");
      },
    });
  }
  services.exposeOnChannelServer(server, overrides);
  socket.onClose(() => {
    void connectionScope?.dispose();
    rawServer.dispose();
  });
}

/** 存储 web 模式下的远程连接，key 为随机 ID */
const remoteConnections = new Map<string, RemoteConnection>();
const customForkTickets = new Map<string, { expiresAt: number; userId: string }>();
const CUSTOM_FORK_TICKET_TTL_MS = 30_000;

function issueCustomForkTicket(userId: string): string {
  const ticket = randomUUID();
  customForkTickets.set(ticket, { userId, expiresAt: Date.now() + CUSTOM_FORK_TICKET_TTL_MS });
  return ticket;
}

function consumeCustomForkTicket(ticket: string | undefined): boolean {
  if (!ticket) return false;
  const record = customForkTickets.get(ticket);
  customForkTickets.delete(ticket);
  return Boolean(record && record.expiresAt > Date.now());
}

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

interface HttpServerOptions {
  serverId?: string;
  name?: string;
  host?: string;
  authRequired?: boolean;
  authToken?: string;
  spaFallback?: boolean;
  staticRoot?: string;
  workspaces?: ServerRemoteWorkspaceInfo[];
}

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function resolveServerId(options: HttpServerOptions): string {
  return (
    options.serverId?.trim() || readTrimmedEnv("ZCODE_SERVER_ID") || hostname() || "zcode-server"
  );
}

function resolveServerWorkspaces(options: HttpServerOptions): ServerRemoteWorkspaceInfo[] {
  if (options.workspaces) {
    return options.workspaces;
  }
  const workspacePath = readTrimmedEnv("ZCODE_SERVER_WORKSPACE") || process.cwd();
  return [
    {
      path: workspacePath,
      label: basename(workspacePath) || workspacePath,
    },
  ];
}

function createServerInfo(options: HttpServerOptions): ServerRemoteInfo {
  return {
    serverId: resolveServerId(options),
    ...(options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME")
      ? { name: options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME") }
      : {}),
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    authRequired: options.authRequired ?? Boolean(readTrimmedEnv("ZCODE_SERVER_TOKEN")),
    workspaces: resolveServerWorkspaces(options),
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
      processResourceTelemetry: true,
    },
  };
}

const zcodeLiteTokenCookieName = "zcode_lite_token";

const staticMimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function hasValidLiteToken(c: Context, token: string): boolean {
  const url = new URL(c.req.url);
  if (url.searchParams.get("token") === token) {
    c.header(
      "Set-Cookie",
      `${zcodeLiteTokenCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`,
    );
    return true;
  }
  return parseCookieHeader(c.req.header("cookie")).get(zcodeLiteTokenCookieName) === token;
}

function isTokenProtectedPath(pathname: string): boolean {
  return pathname === "/ws" || pathname.startsWith("/ws/") || pathname.startsWith("/api/");
}

function isStaticFallbackAllowed(pathname: string): boolean {
  return !isTokenProtectedPath(pathname);
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${sep}`));
}

async function resolveStaticFile(
  staticRoot: string,
  pathname: string,
  spaFallback: boolean,
): Promise<string | null> {
  const root = resolve(staticRoot);
  const normalizedPathname = pathname === "/" ? "/index.html" : pathname;
  const relativePath = decodeURIComponent(normalizedPathname).replace(/^\/+/, "");
  let candidate = resolve(root, relativePath);
  if (!isInsideDirectory(root, candidate)) {
    return null;
  }

  try {
    const candidateStat = await stat(candidate);
    if (candidateStat.isDirectory()) {
      candidate = resolve(candidate, "index.html");
      if (!isInsideDirectory(root, candidate)) {
        return null;
      }
      const indexStat = await stat(candidate);
      return indexStat.isFile() ? candidate : null;
    }
    if (candidateStat.isFile()) {
      return candidate;
    }
  } catch {
    // 静态资源未命中时再进入 SPA fallback，保留真实文件错误的 404 语义。
  }

  if (!spaFallback || !isStaticFallbackAllowed(pathname)) {
    return null;
  }
  const indexFile = resolve(root, "index.html");
  try {
    const indexStat = await stat(indexFile);
    return indexStat.isFile() ? indexFile : null;
  } catch {
    return null;
  }
}

function staticContentType(filePath: string): string {
  return staticMimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function createHttpServer(
  services: ServiceCollection,
  port = 3030,
  options: HttpServerOptions = {},
) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const hostCapabilities = createHostCapabilityStore();

  const authToken = options.authToken?.trim();
  if (authToken) {
    app.use("*", async (c, next) => {
      const pathname = new URL(c.req.url).pathname;
      const validToken = hasValidLiteToken(c, authToken);
      if (!isTokenProtectedPath(pathname) || validToken) {
        await next();
        return;
      }
      return c.json({ error: "Unauthorized" }, 401);
    });
  }

  const customForkRoute = resolveCustomForkProductConfig().remoteRoute;
  const requireCustomForkClerk = async (c: Context, next: () => Promise<void>) => {
    const pathname = new URL(c.req.url).pathname;
    if (
      pathname === customForkRoute ||
      pathname === `${customForkRoute}/` ||
      (!pathname.startsWith(`${customForkRoute}/api/`) && pathname !== `${customForkRoute}/ws`)
    ) {
      await next();
      return;
    }
    const identity = await authenticateCustomForkClerk(c);
    if (!identity) {
      return c.json({ error: "Clerk authentication required" }, 401);
    }
    if (identity.userId !== "local-development" && !isCustomForkClerkUserAllowed(identity.userId)) {
      return c.json({ error: "Clerk user is not authorized for this fork" }, 403);
    }
    await next();
  };
  app.use(`${customForkRoute}/api/*`, requireCustomForkClerk);

  app.get(customForkRoute, (c) => c.redirect(`${customForkRoute}/`));
  app.get(`${customForkRoute}/api/ws-ticket`, async (c) => {
    const identity = await authenticateCustomForkClerk(c);
    if (!identity) return c.json({ error: "Clerk authentication required" }, 401);
    if (identity.userId !== "local-development" && !isCustomForkClerkUserAllowed(identity.userId)) {
      return c.json({ error: "Clerk user is not authorized for this fork" }, 403);
    }
    return c.json({
      ticket: issueCustomForkTicket(identity.userId),
      expiresInMs: CUSTOM_FORK_TICKET_TTL_MS,
    });
  });
  app.get(`${customForkRoute}/api/device`, async (c) => {
    const identity = await authenticateCustomForkClerk(c);
    if (!identity) return c.json({ error: "Clerk authentication required" }, 401);
    if (identity.userId !== "local-development" && !isCustomForkClerkUserAllowed(identity.userId)) {
      return c.json({ error: "Clerk user is not authorized for this fork" }, 403);
    }
    const displayName = process.env.ZCODE_FORK_DEVICE_NAME?.trim() || hostname();
    const deviceId = createHash("sha256")
      .update(`${displayName}:${process.platform}`)
      .digest("hex")
      .slice(0, 16);
    // 在线状态只能来自 relay 注册：relay 已配置但本进程尚无注册记录（刚启动或已断开）时
    // 必须报离线，否则前端显示 ● 却在 /fork/api/relay-ticket 收到 404。
    // 未配置 relay 时这个 server 进程本身就是设备，直接视为在线（直连 /fork/ws 路径）。
    const registration = getRelayDevice(identity.userId, deviceId)?.device;
    const relayConfigured = Boolean(process.env.ZCODE_FORK_RELAY_URL?.trim());
    if (registration) {
      return c.json({
        deviceId,
        displayName,
        online: registration.online,
        lastSeenAt: registration.lastSeenAt,
      });
    }
    // 已配置 relay 但没有注册记录时不编造 lastSeenAt：本进程确实没见过这台设备。
    return relayConfigured
      ? c.json({ deviceId, displayName, online: false })
      : c.json({ deviceId, displayName, online: true, lastSeenAt: new Date().toISOString() });
  });
  app.get(`${customForkRoute}/api/devices`, async (c) => {
    const identity = await authenticateCustomForkClerk(c);
    if (!identity) return c.json({ error: "Clerk authentication required" }, 401);
    if (identity.userId !== "local-development" && !isCustomForkClerkUserAllowed(identity.userId)) {
      return c.json({ error: "Clerk user is not authorized for this fork" }, 403);
    }
    const devices = listRelayDevices(identity.userId);
    relayDebug("devices_listed", { ownerUserId: shortId(identity.userId), count: devices.length });
    return c.json({ devices });
  });
  app.post(`${customForkRoute}/api/pairing-token`, async (c) => {
    const identity = await authenticateCustomForkClerk(c);
    if (!identity) return c.json({ error: "Clerk authentication required" }, 401);
    if (identity.userId !== "local-development" && !isCustomForkClerkUserAllowed(identity.userId)) {
      return c.json({ error: "Clerk user is not authorized for this fork" }, 403);
    }
    return c.json({ token: issuePairingToken(identity.userId), expiresInMs: 60_000 });
  });
  app.post(`${customForkRoute}/api/relay-ticket`, async (c) => {
    const identity = await authenticateCustomForkClerk(c);
    if (!identity) return c.json({ error: "Clerk authentication required" }, 401);
    if (identity.userId !== "local-development" && !isCustomForkClerkUserAllowed(identity.userId)) {
      return c.json({ error: "Clerk user is not authorized for this fork" }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as { deviceId?: string };
    if (!body.deviceId || !getRelayDevice(identity.userId, body.deviceId)?.device.online) {
      relayDebug("relay_ticket_rejected", {
        ownerUserId: shortId(identity.userId),
        reason: "device_offline",
      });
      return c.json({ error: "Device offline" }, 404);
    }
    return c.json({
      ticket: issueRelayConnectionTicket(identity.userId, body.deviceId),
      expiresInMs: 30_000,
    });
  });

  app.get("/api/server-info", (c) => c.json(createServerInfo(options)));
  app.post("/api/rpc-host-capability", (c) => c.json(hostCapabilities.issue()));

  // 普通 `/ws` 永远是 terminal-client；浏览器/任意客户端设置旧 mode header
  // 都不能再把自己提升为 trusted host。
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        setupChannelServer(ws.raw as WebSocket, services, "web-remote-replayable");
      },
    })),
  );

  app.get(
    `${resolveCustomForkProductConfig().remoteRoute}/ws`,
    upgradeWebSocket((c) => ({
      onOpen(_event, ws) {
        if (!consumeCustomForkTicket(new URL(c.req.url).searchParams.get("ticket") ?? undefined)) {
          ws.close(4001, "Invalid or expired connection ticket");
          return;
        }
        setupChannelServer(ws.raw as WebSocket, services, "web-remote-replayable");
      },
    })),
  );

  app.get(
    `${customForkRoute}/relay/device`,
    upgradeWebSocket((c) => ({
      onOpen(_event, ws) {
        const token = c.req.header("x-zcode-device-token");
        if (!token || token !== process.env.ZCODE_FORK_RELAY_DEVICE_TOKEN?.trim()) {
          relayDebug("device_registration_rejected", { reason: "invalid_device_token" });
          ws.close(4003, "Invalid relay device token");
          return;
        }
        const deviceId = c.req.query("deviceId");
        const ownerUserId = c.req.query("ownerUserId");
        const displayName = c.req.query("displayName");
        if (!deviceId || !ownerUserId || !displayName) {
          relayDebug("device_registration_rejected", { reason: "missing_identity" });
          ws.close(4000, "Missing device identity");
          return;
        }
        // attachment socket：只承载某个已调度 attachment 的 RPC 字节，不参与设备心跳，
        // 也不能覆盖 presence 注册（否则会挤掉在线状态与 attach 控制通道）。
        const attachmentId = c.req.query("attachmentId")?.trim();
        if (attachmentId) {
          attachRelayDeviceSocket(attachmentId, deviceId, ws.raw as WebSocket);
          return;
        }
        registerRelayDevice({ deviceId, ownerUserId, displayName }, ws.raw as WebSocket);
      },
    })),
  );

  app.get(
    `${customForkRoute}/relay/ws`,
    upgradeWebSocket((c) => ({
      onOpen(_event, ws) {
        const deviceId = c.req.query("deviceId");
        const relayTicket = c.req.query("ticket");
        const ownerUserId =
          relayTicket && deviceId
            ? consumeRelayConnectionTicketForDevice(relayTicket, deviceId)
            : undefined;
        if (!ownerUserId || !deviceId) {
          ws.close(4001, "Invalid or expired relay ticket");
          return;
        }
        const connection = getRelayDevice(ownerUserId, deviceId);
        if (!connection || !connection.device.online) {
          relayDebug("browser_upgrade_rejected", {
            deviceId: shortId(deviceId),
            reason: "device_offline",
          });
          ws.close(4004, "Device offline");
          return;
        }
        const browser = ws.raw as WebSocket;
        // 每个浏览器独占一次 attachment：Mac 会为该 attachment 新建 channel server，
        // 这样 Initialize 一定发给已连接的浏览器（见 specs/custom-fork-remote.md）。
        const attachmentId = createRelayAttachment({ deviceId, ownerUserId, browser });
        if (!attachmentId) {
          ws.close(4005, "Mac is not accepting relay attachments");
          return;
        }
        relayDebug("browser_bound", {
          deviceId: shortId(deviceId),
          ownerUserId: shortId(ownerUserId),
          attachmentId: shortId(attachmentId),
        });
      },
    })),
  );

  const upgradeTrustedHostWebSocket = upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      setupChannelServer(ws.raw as WebSocket, services, "desktop-continuous");
    },
  }));
  app.use("/ws/host", async (c, next) => {
    const capability = c.req.header(ZCODE_RPC_HOST_CAPABILITY_HEADER);
    if (!hostCapabilities.consume(capability)) {
      return c.json({ error: "Invalid or expired host capability" }, 401);
    }
    await next();
  });
  app.get("/ws/host", upgradeTrustedHostWebSocket);

  // Web 模式下发起远程连接
  app.post("/api/connect-remote", async (c) => {
    const rawBody = await c.req.json();
    const parsedBody = remoteTargetSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return c.json({ error: `Invalid request body: ${formatZodError(parsedBody.error)}` }, 400);
    }
    const body = parsedBody.data;

    try {
      const backend = await createRemoteBackend(body);
      const connection = await connectRemote(backend);
      const id = generateId();
      remoteConnections.set(id, connection);

      return c.json({ id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // 远程连接的 WebSocket 端点，将远程 services 桥接给浏览器
  app.get(
    "/ws/remote/:id",
    upgradeWebSocket((c) => {
      const id = c.req.param("id");
      return {
        onOpen(_event, ws) {
          if (!id) {
            ws.close(4000, "Missing remote connection id");
            return;
          }
          const connection = remoteConnections.get(id);
          if (!connection) {
            ws.close(4004, "Remote connection not found");
            return;
          }
          // 一个连接只给一个 WS 客户端使用，取出后从 Map 移除
          remoteConnections.delete(id);

          // 将远程 services 包装为 ServiceCollection，复用 exposeOnChannelServer 统一注册
          const remoteServices = new ServiceCollection()
            .register(IFileService, connection.services.fileService)
            .register(IGitService, connection.services.gitService)
            .register(ISystemService, connection.services.systemService)
            .register(ITerminalService, connection.services.terminalService);

          setupChannelServer(ws.raw as WebSocket, remoteServices, "web-remote-replayable");
        },
      };
    }),
  );

  if (options.staticRoot?.trim()) {
    const staticRoot = options.staticRoot.trim();
    app.get("*", async (c) => {
      const pathname = new URL(c.req.url).pathname;
      const filePath = await resolveStaticFile(staticRoot, pathname, options.spaFallback ?? true);
      if (!filePath) {
        return c.notFound();
      }
      return c.body(await readFile(filePath), 200, {
        "Cache-Control": filePath.endsWith("index.html")
          ? "no-cache"
          : "public, max-age=31536000, immutable",
        "Content-Type": staticContentType(filePath),
      });
    });
  }

  const server = serve({ fetch: app.fetch, hostname: options.host, port }, () => {
    const address = server.address();
    const listenPort = typeof address === "object" && address ? address.port : port;
    const listenHost = options.host?.trim() || "localhost";
    log(`http://${listenHost}:${listenPort}`);
  });

  injectWebSocket(server);

  return server;
}
