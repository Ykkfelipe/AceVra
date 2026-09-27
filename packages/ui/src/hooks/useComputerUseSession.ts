// CUA-4: task-scoped live Computer Use session state for the open conversation.
//
// Data flow (single owner — the service lease authority):
//
//   poll ──▶ cuaPermissionService.getComputerUseSession(sessionId)
//              │  (service reconciles an active lease against the Helper)
//              ▼
//        session view ──▶ projectComputerUseBar ──▶ bar view
//                          ▲
//   pause()/resume()/stop() write through the SAME service; the next poll reads back the
//   authoritative state — the hook never keeps a second runtime state machine.
//
// Polling policy:
// - no service (remote host) or no task id → no polling at all;
// - poll at a modest 1 s only while the conversation's turn is running or the last known
//   view is still relevant (active/paused lease, action in flight, recent outcome);
// - when relevance ends the loop stops instead of polling forever;
// - every async result is token-fenced: a late response from a previous task id (or a
//   superseded poll) is dropped, and switching tasks clears the retained preview.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CuaComputerUseSessionView, CuaObservationFrameResult } from "@zcode/services";
import { useOptionalServices } from "./useServices.js";
import { projectComputerUseBar, type ComputerUseBarView } from "@/lib/cuaSessionProjection.js";

const ACTIVE_POLL_MS = 1_000;
/** How long a finished outcome stays worth polling after the turn stops running. */
const RELEVANCE_WINDOW_MS = 15_000;

/**
 * Token fence shared by polls and frame fetches: a late response from a previous task (or a
 * superseded request) is dropped instead of overwriting newer UI state.
 */
export function createTokenFence() {
  let latest = 0;
  return {
    next: (): number => {
      latest += 1;
      return latest;
    },
    isCurrent: (token: number): boolean => token === latest,
    invalidate: (): void => {
      latest += 1;
    },
  };
}

/** One fetch per observation id; a new observation supersedes the cached preview. */
export function shouldFetchObservation(
  lastFetchedId: string | null,
  observationId: string | null,
): boolean {
  return observationId !== null && lastFetchedId !== observationId;
}

export interface ComputerUsePreviewState {
  status: "idle" | "loading" | "available" | "unavailable";
  /** `data:` URL of the session's own latest observation frame, when available. */
  dataUrl?: string;
  observationId?: string;
  fetchedAt?: number;
}

export interface UseComputerUseSessionResult {
  session: CuaComputerUseSessionView | null;
  view: ComputerUseBarView;
  preview: ComputerUsePreviewState;
  /** Optimistic command in flight; cleared once the service answered. */
  pending: "pause" | "resume" | "stop" | null;
  pause: () => void;
  resume: () => void;
  /** Service half of Stop; the caller ALSO runs the conversation's own turn stop. */
  stopComputerControl: () => void;
}

export function useComputerUseSession(params: {
  sessionId: string | null | undefined;
  turnRunning: boolean;
  currentTurnId?: string | null;
}): UseComputerUseSessionResult {
  const { sessionId, turnRunning, currentTurnId } = params;
  const services = useOptionalServices();
  const cuaPermissionService = services?.cuaPermissionService;

  const [session, setSession] = useState<CuaComputerUseSessionView | null>(null);
  const [pending, setPending] = useState<"pause" | "resume" | "stop" | null>(null);
  const [preview, setPreview] = useState<ComputerUsePreviewState>({ status: "idle" });
  const [clock, setClock] = useState(() => Date.now());

  // Token fence: any async result whose token is not the latest for this task is ignored.
  const pollFence = useRef(createTokenFence()).current;
  const frameFence = useRef(createTokenFence()).current;
  const fetchedFrameIdRef = useRef<string | null>(null);

  const relevantRef = useRef(false);

  useEffect(() => {
    // Task change / unmount: drop every retained fact and frame of the previous task.
    pollFence.invalidate();
    frameFence.invalidate();
    fetchedFrameIdRef.current = null;
    setSession(null);
    setPreview({ status: "idle" });
    setPending(null);
    relevantRef.current = false;
  }, [sessionId, cuaPermissionService, pollFence, frameFence]);

  useEffect(() => {
    if (!sessionId || !cuaPermissionService) return;
    const token = pollFence.next();
    let cancelled = false;
    const service = cuaPermissionService;

    const pollOnce = async (): Promise<void> => {
      try {
        const view = await service.getComputerUseSession(sessionId);
        if (cancelled || !pollFence.isCurrent(token)) return;
        setSession(view);
        const at = Date.now();
        setClock(at);
        const lastAt = view.present
          ? Math.max(
              view.activity?.completedAt ?? view.activity?.startedAt ?? 0,
              view.observation?.capturedAt ?? 0,
            )
          : 0;
        const relevant =
          view.present &&
          (view.paused ||
            view.lease.state === "active" ||
            view.lease.state === "reserving" ||
            view.lease.state === "releasing" ||
            view.stopMeaningful ||
            at - lastAt < RELEVANCE_WINDOW_MS);
        relevantRef.current = relevant;
      } catch {
        // The service is best-effort for presentation; the next poll retries.
      }
    };

    const loop = async (): Promise<void> => {
      // Poll while the turn runs or the last known state stays relevant; otherwise idle
      // chatting must not hit the host RPC at all. A turnRunning edge restarts this effect
      // (token fence retires the previous loop), which is what resumes polling.
      while (!cancelled && pollFence.isCurrent(token)) {
        await pollOnce();
        if (relevantRef.current || turnRunning) {
          await new Promise((resolve) => setTimeout(resolve, ACTIVE_POLL_MS));
        } else {
          return;
        }
      }
    };
    void loop();
    return () => {
      cancelled = true;
    };
  }, [sessionId, cuaPermissionService, turnRunning, pollFence]);

  // Keep the staleness clock ticking only while a bar is actually shown.
  useEffect(() => {
    if (!session?.present) return;
    const timer = setInterval(() => setClock(Date.now()), ACTIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [session?.present]);

  const fetchFrame = useCallback(
    (observationId: string): void => {
      if (!sessionId || !cuaPermissionService) return;
      if (!shouldFetchObservation(fetchedFrameIdRef.current, observationId)) return;
      fetchedFrameIdRef.current = observationId;
      const token = frameFence.next();
      setPreview({ status: "loading", observationId });
      void cuaPermissionService
        .getComputerUseObservationFrame(sessionId, observationId)
        .then((frame: CuaObservationFrameResult) => {
          if (!frameFence.isCurrent(token)) return;
          if (frame.status === "available" && frame.bytesBase64) {
            setPreview({
              status: "available",
              observationId,
              fetchedAt: Date.now(),
              dataUrl: `data:${frame.mimeType ?? "image/png"};base64,${frame.bytesBase64}`,
            });
          } else {
            setPreview({ status: "unavailable", observationId, fetchedAt: Date.now() });
          }
        })
        .catch(() => {
          if (!frameFence.isCurrent(token)) return;
          setPreview({ status: "unavailable", observationId, fetchedAt: Date.now() });
        });
    },
    [cuaPermissionService, frameFence, sessionId],
  );

  const latestObservationId = session?.present ? (session.observation?.id ?? null) : null;
  useEffect(() => {
    if (!latestObservationId) return;
    // One fetch per observation id; a newer observation supersedes the cached preview.
    if (fetchedFrameIdRef.current !== latestObservationId) fetchFrame(latestObservationId);
  }, [fetchFrame, latestObservationId]);

  const pause = useCallback((): void => {
    if (!cuaPermissionService || pending) return;
    setPending("pause");
    void cuaPermissionService
      .pauseComputerUse()
      .catch(() => undefined)
      .finally(() => setPending(null));
  }, [cuaPermissionService, pending]);

  const resume = useCallback((): void => {
    if (!cuaPermissionService || pending) return;
    setPending("resume");
    void cuaPermissionService
      .resumeComputerUse()
      .catch(() => undefined)
      .finally(() => setPending(null));
  }, [cuaPermissionService, pending]);

  const stopComputerControl = useCallback((): void => {
    if (!cuaPermissionService) return;
    setPending("stop");
    void cuaPermissionService
      .stopComputerControl()
      .catch(() => undefined)
      .finally(() => setPending(null));
  }, [cuaPermissionService]);

  const view = useMemo(
    () =>
      projectComputerUseBar({
        session,
        turnRunning,
        pending,
        now: clock,
        ...(currentTurnId !== undefined ? { currentTurnId } : {}),
      }),
    [clock, currentTurnId, pending, session, turnRunning],
  );

  return {
    session,
    view,
    preview,
    pending,
    pause,
    resume,
    stopComputerControl,
  };
}
