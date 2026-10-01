import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { SSH_BASE_OPTIONS, classifySshFailure, type SpawnFn } from "./sshCommand.js";

export type TunnelState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "online"; port: number }
  | { kind: "offline"; reason: string };

const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 300;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

export function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

export function tunnelArgs(hostAlias: string, localPort: number, workerPort: number): string[] {
  return [
    "-N",
    "-L",
    `127.0.0.1:${localPort}:127.0.0.1:${workerPort}`,
    "-o",
    "ExitOnForwardFailure=yes",
    ...SSH_BASE_OPTIONS,
    hostAlias,
  ];
}

/**
 * One `ssh -N -L` forward to a computer's worker loopback port (process infrastructure only).
 * `ensure()` starts it and resolves once `/health` answers through the forward; while retained,
 * an exit reconnects with backoff 1→30 s. `release()` stops it.
 */
export function createSshTunnel(deps: {
  hostAlias: string;
  workerPort: number;
  spawn: SpawnFn;
  fetch: typeof fetch;
  pickPort?: () => Promise<number>;
  onState?: (state: TunnelState) => void;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}) {
  const setTimer = deps.setTimer ?? setTimeout;
  let state: TunnelState = { kind: "idle" };
  let child: ChildProcess | null = null;
  let retained = false;
  let attempt = 0;
  let starting: Promise<TunnelState> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const setState = (next: TunnelState) => {
    state = next;
    deps.onState?.(next);
  };

  async function waitReady(port: number, proc: ChildProcess): Promise<boolean> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline && child === proc && proc.exitCode === null) {
      const ok = await deps
        .fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) })
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) return true;
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
    return false;
  }

  async function start(): Promise<TunnelState> {
    setState({ kind: "connecting" });
    const port = await (deps.pickPort ?? freeLocalPort)().catch(() => 0);
    if (!port) {
      setState({ kind: "offline", reason: "no_local_port" });
      return state;
    }
    let stderr = "";
    let proc: ChildProcess;
    try {
      proc = deps.spawn("ssh", tunnelArgs(deps.hostAlias, port, deps.workerPort), {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch {
      setState({ kind: "offline", reason: "spawn_failed" });
      return state;
    }
    child = proc;
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString("utf8");
    });
    proc.on("error", () => undefined);
    proc.on("exit", () => {
      if (child !== proc) return;
      child = null;
      setState({ kind: "offline", reason: stderr ? classifySshFailure(stderr) : "tunnel_closed" });
      scheduleReconnect();
    });
    if (await waitReady(port, proc)) {
      attempt = 0;
      setState({ kind: "online", port });
    } else if (child === proc) {
      // 隧道起来了但 worker 不应答：关掉这条转发，交给重连退避，避免半开的转发被当作在线。
      child = null;
      proc.kill();
      setState({ kind: "offline", reason: "worker_unreachable" });
      scheduleReconnect();
    }
    return state;
  }

  function scheduleReconnect() {
    if (!retained || retryTimer) return;
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
    attempt += 1;
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (retained && !child && !starting) void ensure();
    }, delay);
  }

  function ensure(): Promise<TunnelState> {
    retained = true;
    if (state.kind === "online" && child) return Promise.resolve(state);
    if (!starting) {
      starting = start().finally(() => {
        starting = null;
      });
    }
    return starting;
  }

  return {
    ensure,
    state: () => state,
    release() {
      retained = false;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      const proc = child;
      child = null;
      proc?.kill();
      attempt = 0;
      setState({ kind: "idle" });
    },
  };
}
export type SshTunnel = ReturnType<typeof createSshTunnel>;
