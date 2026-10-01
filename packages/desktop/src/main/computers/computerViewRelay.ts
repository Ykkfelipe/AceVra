import type { ComputerInputEvent } from "@zcode/shared";
import {
  CONTROL_PROFILE,
  WATCH_PROFILE,
  createComputerViewStream,
  type ComputerViewStream,
  type OpenViewSocket,
  type ViewFrameMeta,
} from "./computerViewStream.js";
import { JOB_POLL_MS } from "./computerJob.js";
import type { WorkerClient } from "./workerClient.js";

export interface FrameSink {
  interactive: boolean;
  onFrame: (meta: ViewFrameMeta, jpeg: Buffer) => void;
}

/** What the relay needs from its computer entry (the service owns connection and job facts). */
export interface ViewRelayHost {
  connect(): Promise<WorkerClient | null>;
  isHumanControl(): boolean;
  applyJob(job: Record<string, unknown> | null): void;
  refreshJob(): Promise<void>;
  onScreen(screen: { width: number; height: number }): void;
}

/**
 * Ref-counted view stream for one computer: the `/ws/view` socket exists only while at least one
 * visible Computer tab subscribes, so the worker's capture runs only while someone watches.
 */
export function createViewRelay(host: ViewRelayHost, openSocket: OpenViewSocket) {
  const sinks = new Set<FrameSink>();
  let stream: ComputerViewStream | null = null;
  let jobPoll: ReturnType<typeof setInterval> | null = null;
  let reopenTimer: ReturnType<typeof setTimeout> | null = null;

  const profile = () =>
    host.isHumanControl() || [...sinks].some((sink) => sink.interactive)
      ? CONTROL_PROFILE
      : WATCH_PROFILE;

  function open() {
    if (stream || sinks.size === 0) return;
    void host.connect().then((client) => {
      if (!client || stream || sinks.size === 0) return;
      stream = createComputerViewStream({
        url: client.viewSocketUrl(),
        token: client.token(),
        open: openSocket,
        profile: profile(),
        onFrame: (meta, jpeg) => {
          host.onScreen({ width: meta.sw, height: meta.sh });
          for (const sink of sinks) sink.onFrame(meta, jpeg);
        },
        onState: (job) => host.applyJob(job),
        onClose: () => {
          stream = null;
          // 仍有可见 tab：短暂延迟后重连（隧道断开时 connect 会走退避）。
          if (sinks.size > 0 && !reopenTimer) {
            reopenTimer = setTimeout(() => {
              reopenTimer = null;
              open();
            }, 1_000);
          }
        },
      });
      if (!jobPoll) jobPoll = setInterval(() => void host.refreshJob(), JOB_POLL_MS);
    });
  }

  function closeStream() {
    stream?.close();
    stream = null;
  }

  function closeIfUnused() {
    if (sinks.size > 0) return;
    closeStream();
    if (jobPoll) clearInterval(jobPoll);
    jobPoll = null;
    if (reopenTimer) clearTimeout(reopenTimer);
    reopenTimer = null;
  }

  return {
    add(sink: FrameSink) {
      sinks.add(sink);
      stream?.setProfile(profile());
      open();
    },
    remove(sink: FrameSink) {
      sinks.delete(sink);
      stream?.setProfile(profile());
      closeIfUnused();
    },
    /** Tunnel came back: reopen for any remaining viewers. */
    reopen: open,
    /** Tunnel went down: drop the socket without scheduling a reconnect (the tunnel retries). */
    closeStream,
    refreshProfile() {
      stream?.setProfile(profile());
    },
    sendInput(jobId: string, events: ComputerInputEvent[]) {
      stream?.sendInput(jobId, events);
    },
    hasStream: () => stream !== null,
    close() {
      sinks.clear();
      closeIfUnused();
    },
  };
}
export type ViewRelay = ReturnType<typeof createViewRelay>;
