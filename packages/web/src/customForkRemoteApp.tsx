import { useCallback, useEffect, useRef, useState } from "react";
import { Clerk } from "@clerk/clerk-js";
import { connectViaWebSocket } from "@zcode/client";
import type { IPlatformService, ServerRemoteInfo } from "@zcode/shared";
import { resolveCustomForkProductConfig } from "@zcode/shared";
import { AppErrorBoundary, Root, ZCodeIntlProvider } from "@zcode/ui";

type ConnectionState =
  | "authentication-required"
  | "relay-unavailable"
  | "offline"
  | "connecting"
  | "online"
  | "reconnecting"
  | "restored";

interface ForkDevice {
  deviceId: string;
  displayName: string;
  online: boolean;
  lastSeenAt?: string;
}

interface ConnectedFork {
  generation: number;
  services: Awaited<ReturnType<typeof connectViaWebSocket>>;
  device?: ForkDevice;
  initialWorkspaceAbsPath?: string;
  initialWorkspaceIdentity?: string;
}

const RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000] as const;

function wsOrigin(): string {
  return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
}

function connectionCopy(state: ConnectionState): { label: string; detail: string } {
  switch (state) {
    case "authentication-required":
      return { label: "Authentication required", detail: "Sign in to connect to your Mac." };
    case "relay-unavailable":
      return { label: "Relay unavailable", detail: "Retrying the remote connection…" };
    case "offline":
      return { label: "Mac offline", detail: "Waiting for the Mac relay to return…" };
    case "connecting":
      return { label: "Connecting to Mac", detail: "Opening a secure remote session…" };
    case "reconnecting":
      return { label: "Reconnecting", detail: "Your task stays selected while we reconnect…" };
    case "restored":
      return { label: "Connection restored", detail: "Your Mac is online again." };
    case "online":
      return { label: "Mac online", detail: "Remote session connected." };
  }
}

function ForkConnectionBanner({ state, device }: { state: ConnectionState; device?: ForkDevice }) {
  const copy = connectionCopy(state);
  return (
    <div className={`fork-connection-banner fork-connection-banner--${state}`} role="status">
      <span className="fork-connection-banner__dot" aria-hidden="true" />
      <span className="fork-connection-banner__body">
        <strong>{copy.label}</strong>
        <span>{device?.displayName ? `${device.displayName} · ${copy.detail}` : copy.detail}</span>
      </span>
    </div>
  );
}

export function CustomForkRemoteApp({ platform }: { platform: IPlatformService }) {
  const [connection, setConnection] = useState<ConnectedFork | null>(null);
  const [state, setState] = useState<ConnectionState>("connecting");
  const [device, setDevice] = useState<ForkDevice>();
  const generationRef = useRef(0);
  const retryRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const clerkRef = useRef<Clerk | undefined>(undefined);
  const wasOnlineRef = useRef(false);

  const connect = useCallback(async () => {
    const generation = ++generationRef.current;
    window.clearTimeout(timerRef.current);
    setState(wasOnlineRef.current ? "reconnecting" : "connecting");

    const scheduleRetry = (nextState: ConnectionState) => {
      if (generation !== generationRef.current) return;
      setState(nextState);
      const delay = RETRY_DELAYS_MS[Math.min(retryRef.current, RETRY_DELAYS_MS.length - 1)];
      retryRef.current += 1;
      timerRef.current = window.setTimeout(() => void connect(), delay);
    };

    try {
      let token: string | undefined;
      const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
      if (publishableKey) {
        const clerk = clerkRef.current ?? new Clerk(publishableKey);
        clerkRef.current = clerk;
        if (!clerk.loaded) await clerk.load();
        if (!clerk.user) {
          setState("authentication-required");
          return;
        }
        token = (await clerk.session?.getToken()) ?? undefined;
      }

      const route = resolveCustomForkProductConfig().remoteRoute;
      const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
      const [ticketResponse, deviceResponse, serverInfoResponse] = await Promise.all([
        fetch(`${route}/api/ws-ticket`, { headers, cache: "no-store" }),
        fetch(`${route}/api/device`, { headers, cache: "no-store" }),
        fetch("/api/server-info", { cache: "no-store" }),
      ]);
      if (ticketResponse.status === 401 || deviceResponse.status === 401) {
        setState("authentication-required");
        return;
      }
      if (!ticketResponse.ok || !deviceResponse.ok) {
        scheduleRetry("relay-unavailable");
        return;
      }

      const directTicket = ((await ticketResponse.json()) as { ticket?: string }).ticket;
      const nextDevice = (await deviceResponse.json()) as ForkDevice;
      const serverInfo = serverInfoResponse.ok
        ? ((await serverInfoResponse.json()) as Partial<ServerRemoteInfo>)
        : undefined;
      const workspace = serverInfo?.workspaces?.[0];
      setDevice(nextDevice);

      let relayTicket: string | undefined;
      if (nextDevice.online) {
        const response = await fetch(`${route}/api/relay-ticket`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ deviceId: nextDevice.deviceId }),
          cache: "no-store",
        });
        if (response.ok) relayTicket = ((await response.json()) as { ticket?: string }).ticket;
      }

      // relay ticket 获取失败时保留 Phase 5 的直连退路；每次尝试都使用新的单次 ticket。
      const url = relayTicket
        ? `${wsOrigin()}${route}/relay/ws?deviceId=${encodeURIComponent(nextDevice.deviceId)}&ticket=${encodeURIComponent(relayTicket)}`
        : `${wsOrigin()}${route}/ws${directTicket ? `?ticket=${encodeURIComponent(directTicket)}` : ""}`;
      if (!nextDevice.online) setState("offline");
      const services = await connectViaWebSocket(url, {
        webReplayableCapabilities: { windowController: false },
        onOpenSocket: (socket) => {
          if (generation === generationRef.current) socketRef.current = socket;
        },
        onClose: () => {
          if (generation === generationRef.current) scheduleRetry("reconnecting");
        },
      });
      if (generation !== generationRef.current) return;
      const restored = wasOnlineRef.current;
      wasOnlineRef.current = true;
      retryRef.current = 0;
      setConnection({
        generation,
        services,
        device: nextDevice,
        initialWorkspaceAbsPath: workspace?.path,
        initialWorkspaceIdentity: workspace?.workspaceIdentity,
      });
      setState(restored ? "restored" : nextDevice.online ? "online" : "offline");
      if (restored) {
        timerRef.current = window.setTimeout(() => setState("online"), 2_500);
      }
    } catch {
      scheduleRetry(wasOnlineRef.current ? "reconnecting" : "relay-unavailable");
    }
  }, []);

  useEffect(() => {
    document.documentElement.classList.add("fork-remote-route");
    void connect();
    return () => {
      document.documentElement.classList.remove("fork-remote-route");
      generationRef.current += 1;
      window.clearTimeout(timerRef.current);
      socketRef.current?.close();
    };
  }, [connect]);

  if (state === "authentication-required") {
    return (
      <main className="fork-auth-shell">
        <section className="fork-auth-card">
          <h1 className="text-ui-lg font-semibold">ZCode Fork Dev</h1>
          <p className="text-ui-base text-foreground-subtle">Sign in to connect to this Mac.</p>
          <button
            type="button"
            className="rounded-lg bg-primary px-4 py-2 text-ui-base text-primary-foreground"
            onClick={() => void clerkRef.current?.redirectToSignIn({ redirectUrl: window.location.href })}
          >
            Sign in with Clerk
          </button>
        </section>
      </main>
    );
  }

  return (
    <div className="fork-remote-shell">
      <ForkConnectionBanner state={state} device={device} />
      <div className="fork-remote-shell__app" aria-busy={!connection}>
        {connection ? (
          <AppErrorBoundary key={connection.generation}>
            <ZCodeIntlProvider
              settingService={connection.services.settingService}
              broadcastService={connection.services.broadcastService}
            >
              <Root
                services={connection.services}
                platform={platform}
                initialWorkspaceAbsPath={connection.initialWorkspaceAbsPath}
                initialWorkspaceIdentity={connection.initialWorkspaceIdentity}
                preferDirectoryBrowser
                supportsEmbeddedBrowser={false}
                allowRemoteWorkspace={false}
                showWorkspaceWhileOnboardingLoading
              />
            </ZCodeIntlProvider>
          </AppErrorBoundary>
        ) : (
          <div className="fork-remote-shell__loading">{connectionCopy(state).detail}</div>
        )}
      </div>
    </div>
  );
}
