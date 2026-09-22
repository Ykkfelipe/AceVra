import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelClient,
  type IMessagePassingProtocol,
  type ISocket,
} from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";

export interface WebSocketConnectionCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

interface WebSocketConnectionOptions {
  onClose?: (event: WebSocketConnectionCloseEvent) => void;
  onOpenSocket?: (socket: WebSocket) => void;
  /** Development-only lifecycle tracing supplied by the embedding application. */
  debug?: (event: "socket_open" | "first_outbound_frame" | "first_inbound_frame") => void;
  /** Capabilities intentionally absent from a Web replayable attachment. */
  webReplayableCapabilities?: { windowController?: boolean };
}

function wrapBrowserWebSocket(ws: WebSocket, debug?: WebSocketConnectionOptions["debug"]): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  let receivedFirstFrame = false;
  let sentFirstFrame = false;

  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", (e) => {
    if (!receivedFirstFrame) {
      receivedFirstFrame = true;
      debug?.("first_inbound_frame");
    }
    onData.fire(VSBuffer.wrap(new Uint8Array(e.data as ArrayBuffer)));
  });
  ws.addEventListener("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.addEventListener("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === WebSocket.OPEN) {
        if (!sentFirstFrame) {
          sentFirstFrame = true;
          debug?.("first_outbound_frame");
        }
        ws.send(buffer.buffer as Uint8Array<ArrayBuffer>);
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

export function connectViaWebSocket(
  wsUrl: string,
  options?: WebSocketConnectionOptions,
): Promise<IServiceAccessor> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;

    ws.addEventListener("error", () => {
      if (!settled) {
        reject(new Error(`WebSocket connection failed: ${wsUrl}`));
      }
    });
    ws.addEventListener("close", (event) => {
      options?.onClose?.({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });

      if (!settled) {
        reject(
          new Error(
            event.reason
              ? `WebSocket closed before ready: ${event.reason}`
              : `WebSocket closed before ready (${event.code})`,
          ),
        );
      }
    });

    ws.addEventListener("open", () => {
      settled = true;
      options?.onOpenSocket?.(ws);
      options?.debug?.("socket_open");
      const socket = wrapBrowserWebSocket(ws, options?.debug);
      resolve(
        connectViaProtocol(new SocketProtocol(socket), options?.webReplayableCapabilities),
      );
    });
  });
}

export function connectViaProtocol(
  protocol: IMessagePassingProtocol,
  capabilities?: { windowController?: boolean },
): IServiceAccessor {
  const client = new ChannelClient(protocol);
  return new RemoteServiceAccess(client, capabilities);
}
