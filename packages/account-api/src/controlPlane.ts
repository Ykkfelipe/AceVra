import { createAccountApp } from "./app.js";
import { createAccountService } from "./accounts.js";
import { createDeviceChannel, type DeviceChannelOptions } from "./deviceChannel.js";
import { createDeviceService } from "./devices.js";
import { createPairingService } from "./pairing.js";
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
