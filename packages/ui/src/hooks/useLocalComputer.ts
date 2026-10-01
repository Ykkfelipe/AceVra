import { useCallback, useEffect, useRef, useState } from "react";
import type { ComputerCommandResult, ComputerInputEvent, ComputerView } from "@zcode/shared";
import {
  acceptFrame,
  createFrameStreamState,
  createStreamSampler,
  type StreamCursor,
} from "@/computers/computerFrameStream.js";
import type { LiveFrame } from "./useComputer.js";
import { useOptionalServices } from "./useServices.js";
import { logger } from "@/logger.js";

export const LOCAL_COMPUTER_ID = "local-mac";
const READ_INTERVAL_MS = 80;
const ACTIVITY: Record<string, string> = {
  observe: "screenshot",
  workspace_click: "click",
  workspace_type_text: "type",
  workspace_scroll: "scroll",
};

/** Local source adapter: host owns capture and admission; only newest visual pixels are retained. */
export function useLocalComputer(sessionId: string | null, enabled: boolean) {
  const service = useOptionalServices()?.cuaPermissionService;
  const [view, setView] = useState<ComputerView | null>(null);
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const cursorRef = useRef<StreamCursor | null>(null);
  const cursorVersionRef = useRef(0);
  const commands = useRef<Promise<unknown> | null>(null);
  const sourceGeneration = useRef("");
  const [reason, setReason] = useState<string | null>(null);
  useEffect(() => {
    setView(null);
    setFrame(null);
    cursorRef.current = null;
    sourceGeneration.current = "";
    if (!enabled || !sessionId || !service) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let state = createFrameStreamState<LiveFrame>();
    let generation = "";
    const sampler = createStreamSampler();
    const read = async () => {
      const start = performance.now();
      try {
        if (commands.current) return;
        const next = await service.getComputerWorkspaceStream(sessionId, {
          operation: "read",
          afterSeq: state.frame?.seq ?? 0,
        });
        if (!active) return;
        const identity = `${next.generation}:${next.pid}:${next.windowId}`;
        if (identity !== generation || next.status !== "available") {
          state = createFrameStreamState();
          setFrame(null);
          cursorRef.current = null;
          generation = identity;
        }
        sourceGeneration.current = identity;
        const workspace = next.workspace;
        const working = workspace?.state === "acting" || workspace?.state === "observing";
        setReason(next.reason ?? null);
        setView({
          computerId: LOCAL_COMPUTER_ID,
          sourceKind: "local-mac",
          sourceId: next.sourceId,
          executionTargetId: next.executionTargetId,
          name: workspace?.target?.app ?? "",
          connection:
            next.status === "available"
              ? "online"
              : next.reason === "waiting_for_screen"
                ? "connecting"
                : "offline",
          offlineReason: next.reason ?? null,
          control: next.userControl ? "human" : next.paused ? "paused" : working ? "agent" : "idle",
          panelOwnsJob: false,
          job: workspace
            ? {
                jobId: workspace.workspaceId,
                state: workspace.state,
                mode: "background",
                controller: next.userControl ? "human" : "agent",
                yieldReason: null,
              }
            : null,
          lastAction: workspace?.action ? (ACTIVITY[workspace.action.method] ?? null) : null,
          screen:
            next.pointWidth && next.pointHeight
              ? { width: next.pointWidth, height: next.pointHeight }
              : null,
        });
        const cursor = workspace?.cursor;
        if (cursor?.x != null && cursor.y != null && next.originX != null && next.originY != null) {
          cursorRef.current = {
            seq: cursor.updatedAt,
            x: cursor.x - next.originX,
            y: cursor.y - next.originY,
          };
          cursorVersionRef.current += 1;
        }
        if (
          next.status === "available" &&
          next.jpeg &&
          next.seq != null &&
          next.pointWidth &&
          next.pointHeight
        ) {
          const candidate = {
            seq: next.seq,
            capturedAt: next.capturedAt,
            url: `data:image/jpeg;base64,${next.jpeg}`,
            screenWidth: next.pointWidth,
            screenHeight: next.pointHeight,
            cursorX: cursorRef.current?.x ?? 0,
            cursorY: cursorRef.current?.y ?? 0,
          };
          const withCursor = { ...candidate, cursorVisible: cursorRef.current !== null };
          const accepted = acceptFrame(state, withCursor);
          if (accepted.frame !== state.frame) {
            setFrame(withCursor);
            sampler.onFrame(next.capturedAt ? Date.now() - next.capturedAt : null);
          }
          state = accepted;
        }
        const metrics = sampler.sample();
        if (metrics)
          logger.debug("[computers] local stream", {
            ...metrics,
            generation,
            seq: state.frame?.seq,
          });
      } catch {
        if (active) {
          setFrame(null);
          setReason("capture_unavailable");
          setView((previous) =>
            previous
              ? { ...previous, connection: "offline", offlineReason: "capture_unavailable" }
              : null,
          );
        }
      } finally {
        if (active)
          timer = setTimeout(
            () => void read(),
            Math.max(0, READ_INTERVAL_MS - (performance.now() - start)),
          );
      }
    };
    void read();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      void service
        .getComputerWorkspaceStream(sessionId, { operation: "stop" })
        .catch(() => undefined);
    };
  }, [enabled, service, sessionId]);
  const run = useCallback(
    async (
      command: "takeControl" | "giveBack" | "resume" | "stop",
    ): Promise<ComputerCommandResult> => {
      if (!service || !sessionId || commands.current) return { ok: false, reason: "unavailable" };
      const pending =
        command === "resume"
          ? service.resumeComputerUse()
          : service.getComputerWorkspaceStream(sessionId, {
              operation:
                command === "takeControl"
                  ? "take_control"
                  : command === "giveBack"
                    ? "give_back"
                    : "stop_agent",
            });
      commands.current = pending;
      try {
        const result = await pending;
        if ("status" in result && result.status === "unavailable" && command === "takeControl")
          return {
            ok: false,
            reason: "reason" in result ? (result.reason ?? "unavailable") : "unavailable",
          };
        return { ok: true };
      } catch {
        return { ok: false, reason: "unavailable" };
      } finally {
        commands.current = null;
      }
    },
    [service, sessionId],
  );
  const sendInput = useCallback((_events: ComputerInputEvent[]) => {}, []);
  return {
    available: !!service,
    view,
    frame,
    run,
    sendInput,
    cursorRef,
    cursorVersionRef,
    inputSupported: false,
    reason,
  };
}
