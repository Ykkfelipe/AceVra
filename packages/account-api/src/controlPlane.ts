import { createAccountApp } from "./app.js";
import { createAccountService } from "./accounts.js";
import { createDeviceChannel, type DeviceChannelOptions } from "./deviceChannel.js";
import { createDeviceService } from "./devices.js";
import { createPairingService } from "./pairing.js";
import { createSessionFreshness } from "./sessionFreshness.js";
import type {
  ClerkUserDirectory,
  HumanIdentityVerifier,
  HumanSessionDirectory,
  SqlExecutor,
} from "./ports.js";
import { createTaskService, type TaskServiceOptions } from "./tasks.js";

export interface ControlPlaneDeps {
  db: SqlExecutor;
  verifier: HumanIdentityVerifier;
  directory: ClerkUserDirectory;
  /** Human login sessions; omit to expose no session listing. */
  sessions?: HumanSessionDirectory;
  /**
   * Revocation freshness TTL. Omit or 0 to disable the check, which restores M3
   * behaviour: a signed token is accepted until its own expiry.
   */
  sessionFreshnessSeconds?: number;
  clock?: () => number;
  channel?: DeviceChannelOptions;
  tasks?: TaskServiceOptions;
  presenceWindowMs?: number;
  nodeGraceMs?: number;
  rateLimit?: { limit: number; windowMs: number };
  clientKey?: (request: Request) => string;
  log?: (line: string) => void;
}

/**
 * The one place the control plane is wired together (HTTP app, device channel, queue,
 * liveness). The production server and the test harness both use it, so tests exercise the
 * real wiring rather than a copy of it.
 */
export function createControlPlane(deps: ControlPlaneDeps) {
  const clock = deps.clock ?? Date.now;
  // The queue needs liveness from the channel; the channel needs the queue for dispatch.
  let channelRef: ReturnType<typeof createDeviceChannel> | null = null;
  const isLive = (id: string) => channelRef?.isLive(id) ?? false;
  const tasks = createTaskService(deps.db, clock, {
    isLive,
    nodeGraceMs: deps.nodeGraceMs,
    ...deps.tasks,
  });
  // Built only when a session directory and a positive TTL are present: without
  // either there is nothing to revalidate against, and a check that cannot answer
  // must not pretend to.
  const freshnessTtlMs = (deps.sessionFreshnessSeconds ?? 0) * 1000;
  const freshness =
    deps.sessions && freshnessTtlMs > 0
      ? createSessionFreshness({
          ttlMs: freshnessTtlMs,
          clock,
          check: (clerkUserId, sessionId) => deps.sessions!.sessionStatus(clerkUserId, sessionId),
        })
      : undefined;
  const channel = createDeviceChannel({ db: deps.db, tasks, options: deps.channel });
  channelRef = channel;
  const app = createAccountApp({
    verifier: deps.verifier,
    accounts: createAccountService({ db: deps.db, directory: deps.directory }),
    devices: createDeviceService(deps.db, clock, {
      isLive,
      presenceWindowMs: deps.presenceWindowMs,
      nodeGraceMs: deps.nodeGraceMs,
    }),
    pairings: createPairingService(deps.db, clock),
    sessions: deps.sessions,
    freshness,
    tasks,
    onDeviceRevoked: (id) => channel.closeDevice(id, "revoked"),
    onTaskQueued: (id) => void channel.kick(id),
    onTaskCancel: (deviceId, taskId) => channel.sendCancel(deviceId, taskId),
    rateLimit: deps.rateLimit,
    clientKey: deps.clientKey,
    log: deps.log,
  });
  return { app, channel, tasks };
}
