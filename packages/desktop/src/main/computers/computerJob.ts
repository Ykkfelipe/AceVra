import { SSH_TARGET_PREFIX, type ComputerControl, type ComputerJobView } from "@zcode/shared";

/** Worker job facts → presentation (acevra-agent-computer.md §5). Nothing here decides state. */
export const PANEL_CONTROLLER = "acevra-mac:panel";
export const SESSION_CONTROLLER_PREFIX = "acevra-mac:session:";
export const HEARTBEAT_MS = 30_000;
export const SESSION_IDLE_MS = 10 * 60_000;
export const JOB_POLL_MS = 2_000;
const TERMINAL_JOB_STATES = new Set(["done", "error", "stopped", "idle"]);
export const PAUSED_REASONS = new Set([
  "paused",
  "pause_requested",
  "human_control",
  "user_active",
  "manual_control_inactive",
]);

export const targetIdFor = (computerId: string) => `${SSH_TARGET_PREFIX}${computerId}`;
export const computerIdOf = (targetId: string) =>
  targetId.startsWith(SSH_TARGET_PREFIX) ? targetId.slice(SSH_TARGET_PREFIX.length) : null;

export const isActiveJob = (job: Record<string, any> | null): job is Record<string, any> =>
  Boolean(job?.job_id) && !TERMINAL_JOB_STATES.has(String(job?.state));

export function deriveControl(job: Record<string, any> | null): ComputerControl {
  if (!isActiveJob(job)) return "idle";
  if (job.state === "human_control") return "human";
  if (job.state === "running" && !job.yield) return "agent";
  return "paused";
}

export function toJobView(job: Record<string, any> | null): ComputerJobView | null {
  if (!isActiveJob(job)) return null;
  const yieldInfo = job.yield && typeof job.yield === "object" ? job.yield : null;
  return {
    jobId: String(job.job_id),
    state: String(job.state),
    mode: typeof job.mode === "string" ? job.mode : null,
    controller: typeof job.controller === "string" ? job.controller : null,
    yieldReason: typeof yieldInfo?.reason === "string" ? yieldInfo.reason : null,
  };
}
