import { hostname } from "node:os";
import { resolve } from "node:path";
import { ensureNodeRoot, resolveNodePaths } from "./dataRoot.js";
import { createNodeChannel } from "./channel.js";
import { deriveNodeCapabilities, type NodeCapability } from "./capabilities.js";
import { createShellService } from "./shell/executor.js";
import { createTaskRunner } from "./taskRunner.js";
import { loadOrCreateIdentity } from "./identity.js";
import { createLogger } from "./log.js";
import { pairNode } from "./pair.js";
import {
  clearNode,
  readState,
  readStatus,
  writeState,
  writeStatus,
  type NodeState,
} from "./state.js";
import { resolveEndpoints } from "./transport.js";

export interface CliIO {
  stdout?: { write(value: string): void };
  stderr?: { write(value: string): void };
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  pollMs?: number;
  /** Test hook: reconnect backoff bounds. */
  channel?: { minDelayMs?: number; maxDelayMs?: number };
}

const USAGE = `AceVra Node

Usage:
  acevra node connect --api <https-url> [--name <display name>] [--allow-root <dir>]...
  acevra node status
  acevra node disconnect`;

const PLATFORMS = ["darwin", "win32", "linux"] as const;

function friendlyHostname(): string {
  const cleaned = hostname()
    .replace(/\.(local|lan|home)$/i, "")
    .replace(/[^\p{L}\p{N} _.'’-]/gu, "")
    .trim()
    .slice(0, 60);
  return cleaned || "AceVra Node";
}
const flags = (args: string[], name: string) =>
  args.flatMap((arg, i) => (arg === name && args[i + 1] ? [args[i + 1]!] : []));
const flag = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const abbreviate = (id?: string) => (id ? `${id.slice(0, 8)}…` : "—");

export async function main(argv: string[], io: CliIO = {}): Promise<number> {
  const out = (line = "") => (io.stdout ?? process.stdout).write(`${line}\n`);
  const err = (line: string) => (io.stderr ?? process.stderr).write(`${line}\n`);
  const env = io.env ?? process.env;
  const [group, command, ...rest] = argv;
  if (group !== "node" || !command) {
    err(USAGE);
    return 2;
  }
  const paths = resolveNodePaths(env);
  try {
    if (command === "status") return await status(paths, out);
    if (command === "disconnect") return await disconnect(paths, out);
    if (command === "connect") return await connect(paths, rest, { io, env, out, err });
  } catch (error) {
    err(error instanceof Error ? error.message : "Unexpected error");
    return 1;
  }
  err(USAGE);
  return 2;
}

async function connect(
  paths: ReturnType<typeof resolveNodePaths>,
  args: string[],
  ctx: { io: CliIO; env: NodeJS.ProcessEnv; out: (l?: string) => void; err: (l: string) => void },
): Promise<number> {
  if (!PLATFORMS.includes(process.platform as (typeof PLATFORMS)[number])) {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }
  await ensureNodeRoot(paths);
  let state = await readState(paths);
  const api = flag(args, "--api") ?? state?.apiBaseUrl ?? ctx.env.ACEVRA_API_BASE_URL;
  if (!api) throw new Error("Specify the control plane with --api <https-url>.");
  const { httpBase, wsUrl } = resolveEndpoints(api, ctx.env);
  if (state && state.apiBaseUrl !== httpBase) {
    throw new Error(
      "This node is bound to a different control plane. Run `acevra node disconnect` first.",
    );
  }
  const identity = await loadOrCreateIdentity(paths);
  const log = createLogger(paths);
  state ??= {
    apiBaseUrl: httpBase,
    displayName: (flag(args, "--name") ?? friendlyHostname()).slice(0, 60),
    platform: process.platform as NodeState["platform"],
  };
  // Shell: enabled only by explicit allowed roots and EARNED by a passing self-test.
  const roots = [
    ...new Set([
      ...(state.shellRoots ?? []),
      ...flags(args, "--allow-root").map((r) => resolve(r)),
    ]),
  ];
  if (roots.length !== (state.shellRoots ?? []).length) {
    state = { ...state, shellRoots: roots };
    await writeState(paths, state);
  }
  const shell = createShellService({ roots });
  const shellReady = roots.length > 0 && (await shell.ready());
  if (roots.length > 0 && !shellReady)
    ctx.err("Shell service failed its self-test; shell will not be advertised.");
  const capabilities: NodeCapability[] = deriveNodeCapabilities([
    { capability: "shell", available: () => shellReady },
  ]);
  if (!state.deviceId) {
    state = await pairNode({
      paths,
      identity,
      state,
      capabilities,
      httpBase,
      fetch: ctx.io.fetch,
      log,
      signal: ctx.io.signal,
      pollMs: ctx.io.pollMs,
      onCode: (code, expiresAt) => {
        ctx.out("AceVra Node pairing");
        ctx.out();
        ctx.out(`  Code: ${code}`);
        ctx.out(`  Expires: ${expiresAt}`);
        ctx.out();
        ctx.out("In AceVra, open Account → Devices → Pair a node, enter the code, then Approve.");
        ctx.out("Waiting for approval…");
      },
    });
    ctx.out("Paired. Connecting…");
  }
  const holder: { link: () => ReturnType<typeof channel.link> } = { link: () => null };
  const runner = createTaskRunner({
    shell,
    shellReady: () => shellReady,
    link: () => holder.link(),
    log: (event, facts) => void log(event, facts),
  });
  const channel = createNodeChannel({
    runner,
    wsUrl,
    deviceId: state.deviceId!,
    sign: identity.sign,
    capabilities,
    ...ctx.io.channel,
    log: (event, facts) => void log(event, facts),
    onStatus: (s) => {
      lastStatus = { ...s, capabilities };
      void writeStatus(paths, lastStatus);
    },
  });
  holder.link = () => channel.link();
  // Re-stamp status so `acevra node status` can tell a live process from a stale file.
  let lastStatus: Parameters<typeof writeStatus>[1] = { connection: "connecting" };
  const stamp = setInterval(() => void writeStatus(paths, lastStatus), 30_000);
  stamp.unref();
  channel.start();
  await new Promise<void>((resolve) => {
    // Not unref'd: this interval keeps the process alive (and notices a terminal revoke).
    const watch = setInterval(() => channel.isTerminal() && finish(), 500);
    const finish = () => {
      clearInterval(watch);
      resolve();
    };
    ctx.io.signal?.addEventListener("abort", finish, { once: true });
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
  const terminal = channel.isTerminal();
  clearInterval(stamp);
  runner.shutdown();
  channel.stop();
  await writeStatus(paths, { connection: terminal ? "revoked" : "stopped" });
  return terminal ? 3 : 0;
}

async function status(paths: ReturnType<typeof resolveNodePaths>, out: (l?: string) => void) {
  const state = await readState(paths);
  out("AceVra Node");
  out();
  if (!state) {
    out("Status: Not set up. Run `acevra node connect --api <url>`.");
    return 0;
  }
  const live = await readStatus(paths);
  // A stale file (or a recycled pid) must not read as running: require a fresh stamp too.
  let running = false;
  if (live && isFresh(live)) {
    try {
      process.kill(live.pid, 0);
      running = true;
    } catch {
      running = false;
    }
  }
  const caps = running ? (live?.capabilities ?? []) : [];
  out(`Device: ${state.displayName}`);
  out(`Account: ${state.deviceId ? "paired" : state.pairing ? "pairing pending" : "not paired"}`);
  out(`Device ID: ${abbreviate(state.deviceId)}`);
  out(
    `Capabilities: ${caps.length ? caps.join(", ") : running ? "none yet" : "unknown (node not running)"}`,
  );
  out(
    `Shell roots: ${state.shellRoots?.length ? state.shellRoots.join("; ") : "none (shell disabled)"}`,
  );
  const connection = !state.deviceId
    ? "Not paired"
    : !running
      ? "Not running"
      : label(live!.connection);
  out(`Control plane: ${connection}`);
  if (live?.lastConnectedAt) out(`Last connected: ${live.lastConnectedAt}`);
  return 0;
}
/** A status file counts as a live process only while fresh and not a recorded final state. */
const isFresh = (live: { updatedAt: string; connection: string }) =>
  Date.now() - Date.parse(live.updatedAt) < 90_000 &&
  live.connection !== "stopped" &&
  live.connection !== "revoked";
const label = (c: string) =>
  ({
    connected: "Connected",
    connecting: "Connecting",
    offline: "Reconnecting",
    revoked: "Revoked",
    "auth-failed": "Authentication failed",
    stopped: "Stopped",
  })[c] ?? c;

async function disconnect(paths: ReturnType<typeof resolveNodePaths>, out: (l?: string) => void) {
  const live = await readStatus(paths);
  if (live && isFresh(live)) {
    try {
      process.kill(live.pid, 0);
      throw new Error("The node is still running. Stop it (Ctrl+C) before disconnecting.");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("The node")) throw error;
    }
  }
  await clearNode(paths);
  out("This node's local identity and pairing were removed.");
  out("To remove it from your account, revoke it in AceVra → Account → Devices.");
  return 0;
}
