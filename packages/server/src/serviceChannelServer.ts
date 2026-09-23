import { randomUUID } from "node:crypto";
import {
  ChannelServer,
  Emitter,
  LoggingChannelServer,
  SocketProtocol,
  VSBuffer,
  type ISocket,
} from "@zcode/rpc";
import {
  ICredentialService,
  IProviderProvisioningTargetService,
  IProviderSettingsService,
  IZCodeAgentService,
  ServiceCollection,
  createRemoteProviderSettingsCredentialGuard,
  createRendererCredentialDeniedService,
  createZCodeAgentConnectionScope,
} from "@zcode/services";
import { formatLogPrefix } from "@zcode/shared";
import type { WebSocket } from "ws";

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
      if (ws.readyState === ws.OPEN) ws.send(buffer.buffer);
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
  console.log(formatLogPrefix("zcode-server:service-channel", process.pid), ...args);

/** Expose an existing Host service graph over one scoped WebSocket attachment. */
export function setupChannelServer(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
): void {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  const server = new LoggingChannelServer(rawServer, log);
  const agentService = services.getOptional(IZCodeAgentService);
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(agentService, {
        connectionId: `host-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
      })
    : undefined;
  const overrides = new Map<string, unknown>([
    [ICredentialService.channelName, createRendererCredentialDeniedService()],
  ]);
  if (connectionScope) overrides.set(IZCodeAgentService.channelName, connectionScope.service);

  const providerSettings = services.getOptional(IProviderSettingsService);
  if (providerSettings) {
    // WebSocket clients are never the local desktop Renderer: manual provider secrets are local-only.
    overrides.set(
      IProviderSettingsService.channelName,
      createRemoteProviderSettingsCredentialGuard(providerSettings),
    );
  }
  if (clientMode !== "desktop-continuous" && services.getOptional(IProviderProvisioningTargetService)) {
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
