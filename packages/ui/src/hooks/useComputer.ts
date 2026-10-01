import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CapturedKeyEvent,
  ComputerCommandResult,
  ComputerFrame,
  ComputerInputEvent,
  ComputerView,
  IComputersPlatform,
  SshComputerConfig,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  acceptCursor,
  acceptFrame,
  createFrameStreamState,
  createStreamSampler,
  type StreamCursor,
} from "@/computers/computerFrameStream.js";
import { usePlatform } from "./usePlatform.js";
import { useOptionalServices } from "./useServices.js";
import { LOCAL_COMPUTER_ID, useLocalComputer } from "./useLocalComputer.js";

export function useComputersPlatform(): IComputersPlatform | null {
  return usePlatform().computers ?? null;
}

/**
 * 远程键盘捕获 layer 1（spec §3.3）：激活期间 Main 在 before-input-event 里拦截该窗口的
 * 全部按键（连同 Electron 菜单 accelerator，如 Cmd+Q / Cmd+W），经 onCapturedKey 转回；
 * 卸载/失活时自动关闭，保证本地逃生通道永远可用。
 */
export function useRemoteKeyboardCapture(
  active: boolean,
  onEvent: (event: CapturedKeyEvent) => void,
) {
  const computers = useComputersPlatform();
  const latest = useRef(onEvent);
  latest.current = onEvent;
  useEffect(() => {
    if (!computers?.setKeyCapture || !computers.onCapturedKey || !active) return;
    computers.setKeyCapture(true);
    const off = computers.onCapturedKey((event) => latest.current(event));
    return () => {
      computers.setKeyCapture(false);
      off();
    };
  }, [computers, active]);
}

/** Saved SSH computers (Settings → Computers). */
export function useSshComputers() {
  const computers = useComputersPlatform();
  const [list, setList] = useState<SshComputerConfig[] | null>(null);
  const refresh = useCallback(async () => {
    setList((await computers?.list().catch(() => [])) ?? []);
  }, [computers]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { computers, list, setList, refresh };
}

/**
 * Main announces the first agent RemoteComputer action of a conversation once; when that
 * conversation is the one on screen, the Computer tab opens on that computer.
 */
export function useComputerSessionAutoOpen(
  activeSessionId: string | null,
  openComputer: (computerId: string) => void,
) {
  const computers = useComputersPlatform();
  const latest = useRef({ activeSessionId, openComputer });
  const service = useOptionalServices()?.cuaPermissionService;
  useEffect(() => {
    if (!service || !activeSessionId) return;
    let active = true;
    let opened = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const view = await service.getComputerUseSession(activeSessionId);
        if (
          active &&
          !opened &&
          view.present &&
          view.workspace?.backendId === "agent-workspace" &&
          view.workspace.target
        ) {
          opened = true;
          latest.current.openComputer(LOCAL_COMPUTER_ID);
        }
      } catch {
        // 服务正在重连时不自动打开来源；下一次读取仍由当前会话决定。
      } finally {
        if (active && !opened) timer = setTimeout(() => void read(), 1_000);
      }
    };
    void read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [activeSessionId, service]);
  latest.current = { activeSessionId, openComputer };
  useEffect(() => {
    if (!computers) return;
    return computers.onSessionStarted((notice) => {
      if (notice.sessionId && notice.sessionId === latest.current.activeSessionId) {
        latest.current.openComputer(notice.computerId);
      }
    });
  }, [computers]);
}

export interface LiveFrame {
  capturedAt?: number;
  cursorVisible?: boolean;
  url: string;
  seq: number;
  screenWidth: number;
  screenHeight: number;
  cursorX: number;
  cursorY: number;
}

/**
 * The Computer tab's view of one computer. `streaming` drives the ref-counted frame subscription
 * in Main: no subscription (and no socket) unless the tab is the visible active tab.
 */
export function useComputer(
  computerId: string | null,
  options: { streaming: boolean; interactive: boolean; sessionId?: string | null },
) {
  const local = useLocalComputer(
    options.sessionId ?? null,
    computerId === LOCAL_COMPUTER_ID && options.streaming,
  );
  const remote = useRemoteComputer(computerId === LOCAL_COMPUTER_ID ? null : computerId, options);
  return computerId === LOCAL_COMPUTER_ID
    ? local
    : { ...remote, available: remote.available || local.available, inputSupported: true };
}

function useRemoteComputer(
  computerId: string | null,
  options: { streaming: boolean; interactive: boolean },
) {
  const computers = useComputersPlatform();
  const [view, setView] = useState<ComputerView | null>(null);
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    setView(null);
    if (!computers || !computerId) return;
    let active = true;
    void computers.getView(computerId).then((next) => {
      if (active && next) setView(next);
    });
    const unsubscribe = computers.onViewChanged((next) => {
      if (next.computerId === computerId) setView(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [computers, computerId]);

  const { streaming, interactive } = options;
  // ComputerFrameStream 消费端（spec §4.5）：seq 单调，旧/乱序帧直接丢弃（计数，不排队）；
  // 光标走独立轻量流，写入 ref 供 overlay 直接改 DOM，避免高频 React 重渲染。
  const streamRef = useRef(createFrameStreamState<LiveFrame & { capturedAt?: number }>());
  const cursorRef = useRef<StreamCursor | null>(null);
  const cursorVersionRef = useRef(0);
  useEffect(() => {
    streamRef.current = createFrameStreamState();
    cursorRef.current = null;
    setFrame(null);
  }, [computerId, streaming]);
  useEffect(() => {
    if (!computers || !computerId || !streaming) return;
    const sampler = createStreamSampler();
    const unsubscribe = computers.subscribeFrames(
      computerId,
      {
        interactive,
        onCursor: (cursor) => {
          streamRef.current = acceptCursor(streamRef.current, cursor);
          cursorRef.current = cursor;
          cursorVersionRef.current += 1;
          sampler.onCursor();
        },
      },
      (next: ComputerFrame) => {
        const url = URL.createObjectURL(
          new Blob([next.jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
        );
        const previous = urlRef.current;
        const previousFrame = streamRef.current.frame;
        const accepted = acceptFrame(streamRef.current, {
          ...next,
          url,
          screenWidth: next.screenWidth,
          screenHeight: next.screenHeight,
        });
        streamRef.current = accepted;
        // 以对象身份判定：被拒的帧不进入展示（含乱序/重复 seq），立即释放其 blob。
        if (accepted.frame !== previousFrame) {
          urlRef.current = url;
          setFrame({
            capturedAt: next.capturedAt,
            url,
            seq: next.seq,
            screenWidth: next.screenWidth,
            screenHeight: next.screenHeight,
            cursorX: next.cursorX,
            cursorY: next.cursorY,
          });
          if (previous) URL.revokeObjectURL(previous);
        } else if (previous !== url) {
          // 被拒收的帧立即释放，不进入展示（最新帧语义）。
          URL.revokeObjectURL(url);
        }
        sampler.onFrame(next.capturedAt ? Math.max(0, Date.now() - next.capturedAt) : null);
        const metrics = sampler.sample();
        if (metrics) {
          // 开发指标（spec §4.5）：只进 debug 日志，不做产品 UI。
          logger.debug(
            `[computers] stream fps=${metrics.fps} cursor/s=${metrics.cursorPerSec} ` +
              `latency p50=${metrics.latencyP50Ms ?? "?"}ms p95=${metrics.latencyP95Ms ?? "?"}ms ` +
              `dropped=${streamRef.current.counters.dropped}`,
          );
        }
      },
    );
    return () => {
      unsubscribe();
    };
  }, [computers, computerId, streaming, interactive]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    },
    [computerId],
  );

  const run = useCallback(
    async (
      command: "takeControl" | "giveBack" | "resume" | "stop",
    ): Promise<ComputerCommandResult> => {
      if (!computers || !computerId) return { ok: false, reason: "unavailable" };
      return computers[command](computerId).catch(() => ({ ok: false, reason: "internal" }));
    },
    [computers, computerId],
  );

  const sendInput = useCallback(
    (events: ComputerInputEvent[]) => {
      if (computers && computerId && events.length > 0) computers.sendInput(computerId, events);
    },
    [computers, computerId],
  );

  return {
    available: computers != null,
    view,
    frame,
    run,
    sendInput,
    /** 最新光标位置（cursor 事件流）；overlay 通过 cursorVersionRef 感知变化直接改 DOM。 */
    cursorRef,
    cursorVersionRef,
  };
}
