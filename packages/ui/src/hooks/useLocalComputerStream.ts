// LocalComputerPreview stream source: the AgentWorkspace target window, live.
//
// 单一所有者：像素归 signed Helper 的窗口级 SCStream，目标/光标归宿主 workspace 投影；本 hook
// 只做呈现侧的 latest-frame 消费。经 cuaPermissionService RPC 读取（宿主 → hardened session
// → Helper），renderer 从不直接触达 Helper 传输。
//
// Read loop: one request in flight; the next read starts READ_INTERVAL_MS after the previous one
// started (≈12 fps ceiling, matching the Helper's capture interval) and passes `afterSeq` so an
// unchanged frame costs no bytes. Disabling (hidden panel, unmount, session switch) stops the
// loop and releases the visual demand with `stop`; late responses are token-fenced.
import { useEffect, useRef, useState } from "react";
import { createStreamSampler } from "@/computers/computerFrameStream.js";
import {
  createLocalStreamState,
  reduceLocalStream,
  type LocalStreamState,
} from "@/computers/localComputerStream.js";
import { logger } from "@/logger.js";
import { useOptionalServices } from "./useServices.js";

const READ_INTERVAL_MS = 80;
const RETRY_INTERVAL_MS = 500;

export function useLocalComputerStream(
  sessionId: string | null | undefined,
  enabled: boolean,
): LocalStreamState {
  const service = useOptionalServices()?.cuaPermissionService;
  const [state, setState] = useState<LocalStreamState>(createLocalStreamState);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const initial = createLocalStreamState();
    stateRef.current = initial;
    setState(initial);
    if (!enabled || !sessionId || !service) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sampler = createStreamSampler();
    const read = async () => {
      const started = performance.now();
      let delay = READ_INTERVAL_MS;
      try {
        const previous = stateRef.current;
        const next = await service.getComputerWorkspaceStream(sessionId, {
          operation: "read",
          afterSeq: previous.stream.frame?.seq ?? 0,
        });
        if (!active) return;
        const reduced = reduceLocalStream(previous, next);
        if (reduced !== previous) {
          if (reduced.stream.frame && reduced.stream.frame !== previous.stream.frame) {
            sampler.onFrame(reduced.stream.counters.lastLatencyMs);
          }
          stateRef.current = reduced;
          setState(reduced);
        }
        if (reduced.status !== "live") delay = RETRY_INTERVAL_MS;
        const metrics = sampler.sample();
        if (metrics) {
          logger.debug("[computer] local preview stream", {
            ...metrics,
            dropped: reduced.stream.counters.dropped,
          });
        }
      } catch {
        if (!active) return;
        const unavailable = {
          ...createLocalStreamState(),
          status: "unavailable" as const,
          reason: "capture_unavailable",
        };
        stateRef.current = unavailable;
        setState(unavailable);
        delay = RETRY_INTERVAL_MS;
      } finally {
        if (active) {
          timer = setTimeout(() => void read(), Math.max(0, delay - (performance.now() - started)));
        }
      }
    };
    void read();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      void service.getComputerWorkspaceStream(sessionId, { operation: "stop" }).catch(() => {});
    };
  }, [enabled, service, sessionId]);

  return state;
}
