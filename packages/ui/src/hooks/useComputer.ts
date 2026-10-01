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
import { usePlatform } from "./usePlatform.js";

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
  useEffect(() => {
    if (!computers || !computerId || !streaming) return;
    const unsubscribe = computers.subscribeFrames(
      computerId,
      { interactive },
      (next: ComputerFrame) => {
        const url = URL.createObjectURL(
          new Blob([next.jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
        );
        const previous = urlRef.current;
        urlRef.current = url;
        setFrame({
          url,
          seq: next.seq,
          screenWidth: next.screenWidth,
          screenHeight: next.screenHeight,
          cursorX: next.cursorX,
          cursorY: next.cursorY,
        });
        if (previous) URL.revokeObjectURL(previous);
      },
    );
    return unsubscribe;
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

  return { available: computers != null, view, frame, run, sendInput };
}
