// LocalComputerPreview (wired): floating, movable, resizable view of the session's local Computer.
//
// 纯投影呈现：动作/目标/光标事实来自宿主维护的 workspace 投影，像素来自 signed Helper 对
// agent 目标窗口的窗口级 SCStream（useLocalComputerStream → workspace_stream）。屏幕级的
// observation 帧只属于 agent 观察通道，绝不作为这里的实时预览。这里没有第二个状态机。
//
// 呈现（紧凑/展开、位置、宽度、隐藏、Stop 后收起）归 miniComputerStore，按会话键控；拖动、
// 缩放、展开都不触碰会话事实与窗口流，因此不会重启画面流、不会丢失帧序号与光标。浮窗经
// portal 挂到 body 并使用固定坐标：拖动不引起聊天重排，transcript 更新也不会重建它。
// 零偷取：渲染本面板不激活任何应用、不移动物理光标、不获取任何租约。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CuaComputerUseSessionView } from "@zcode/services";
import type { UseComputerUseSessionResult } from "@/hooks/useComputerUseSession.js";
import { useLocalComputerStream } from "@/hooks/useLocalComputerStream.js";
import {
  compactPreviewRect,
  expandedPreviewRect,
  type Viewport,
} from "@/computers/localPreviewGeometry.js";
import { useMiniComputerStore } from "@/store/miniComputerStore.js";
import {
  MINI_COMPUTER_STOPPED_DISMISS_MS,
  MiniComputerPanelMounted,
} from "./LocalComputerPreviewWindow.js";

export {
  localCursorStyle,
  MINI_COMPUTER_STOPPED_DISMISS_MS,
  MiniComputerPanelMounted,
  type MiniComputerPanelActions,
  type MiniComputerPanelData,
} from "./LocalComputerPreviewWindow.js";

/** Relevance window: how long a finished workspace stays worth showing/reopening. */
const MINI_COMPUTER_RELEVANCE_MS = 8_000;

/**
 * True while the session's agent-workspace projection is the relevant Computer UI.
 *
 * The composer uses this to suppress the large Computer Use bar for background workspace
 * activity: the mini panel is the canonical surface there, and a second banner would
 * duplicate frame/cursor/Pause/Stop. Native lease activity (reserving/active) always
 * keeps the bar — a prominent safety surface is exactly right during escalation, even
 * when a workspace exists. Pure predicate; rendering or hiding either visual never
 * touches execution state.
 */
export function isAgentWorkspaceActive(
  view: CuaComputerUseSessionView | null | undefined,
  turnRunning: boolean,
  clock: number = Date.now(),
): boolean {
  if (!view?.present) return false;
  // 原生租约（前台/独占）期间永远保留大控制条：这是显式安全面，规则不允许折叠它。
  if (view.lease.state === "active" || view.lease.state === "reserving") return false;
  const workspace = view.workspace;
  if (!workspace || workspace.backendId !== "agent-workspace") return false;
  return (
    turnRunning ||
    view.paused === true ||
    workspace.state !== "idle" ||
    clock - workspace.updatedAt < MINI_COMPUTER_RELEVANCE_MS
  );
}

function readViewport(): Viewport | null {
  return typeof window === "undefined"
    ? null
    : { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Wired component: one shared `useComputerUseSession` poll (hoisted by the composer) feeds
 * both the Computer Use bar and this panel. Presentation (hidden/expanded/position/width/
 * stopped) comes from the session-keyed store; workspace facts come only from the services.
 */
export function MiniComputerPanel(props: {
  session: UseComputerUseSessionResult;
  sessionId: string | null | undefined;
  turnRunning: boolean;
  onStop: () => void;
}) {
  const { session, sessionId, turnRunning, onStop } = props;
  const key = sessionId ?? "";
  const hiddenFlag = useMiniComputerStore((state) => state.hiddenBySession[key] === true);
  const expandedFlag = useMiniComputerStore((state) => state.expandedBySession[key] === true);
  const position = useMiniComputerStore((state) => state.positionBySession[key] ?? null);
  const width = useMiniComputerStore((state) => state.widthBySession[key] ?? null);
  const stoppedAt = useMiniComputerStore((state) => state.stoppedAtBySession[key] ?? null);
  const store = useMiniComputerStore.getState;

  // 1 s clock only for the presentation relevance window; it never drives workspace facts.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  // 浮窗只在客户端挂载后经 portal 渲染；视口变化时重新夹紧位置。
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [anchor, setAnchor] = useState<{ right: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      setViewport(readViewport());
      const box = anchorRef.current?.parentElement?.getBoundingClientRect();
      if (box) setAnchor({ right: box.right, top: box.bottom });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const view = session.session;
  const workspace = view?.present ? (view.workspace ?? null) : null;
  const paused = view?.present ? view.paused : false;
  const leaseActive = view?.present ? view.lease.state === "active" : false;

  // Stop 之后若出现新的 workspace 活动（同一会话开始了新的本地任务），不再沿用旧的「已停止」。
  const stopped =
    stoppedAt !== null &&
    (!workspace || workspace.updatedAt <= stoppedAt + MINI_COMPUTER_STOPPED_DISMISS_MS);
  const dismissedAfterStop =
    stopped && stoppedAt !== null && clock - stoppedAt > MINI_COMPUTER_STOPPED_DISMISS_MS;
  const relevant = isAgentWorkspaceActive(view, turnRunning, clock) && !dismissedAfterStop;
  // 可视需求只在面板可见时存在：隐藏/不相关即停止窗口流（stop），不影响执行。
  const stream = useLocalComputerStream(sessionId, Boolean(workspace) && relevant && !hiddenFlag);

  useEffect(() => {
    if (sessionId && stoppedAt !== null && !stopped) store().clearStopped(sessionId);
  }, [sessionId, stopped, stoppedAt, store]);

  if (!sessionId || !workspace || !relevant) return <span ref={anchorRef} hidden />;

  const rect = viewport
    ? expandedFlag
      ? expandedPreviewRect(stream.aspectRatio, viewport)
      : compactPreviewRect({ position, width, aspectRatio: stream.aspectRatio, viewport, anchor })
    : undefined;

  const panel = (
    <MiniComputerPanelMounted
      data={{
        workspace,
        stream,
        paused,
        leaseActive,
        turnRunning,
        hidden: hiddenFlag,
        expanded: expandedFlag,
        relevant,
        pending: session.pending,
        stopped,
        ...(rect && !hiddenFlag ? { rect } : {}),
      }}
      actions={{
        // × 只改呈现偏好：不停止任务、不暂停执行、不丢弃 workspace 投影。
        onHide: () => store().hide(sessionId),
        onReopen: () => store().reopen(sessionId),
        onSetExpanded: (value) => store().setExpanded(sessionId, value),
        onPause: () => session.pause(),
        onResume: () => session.resume(),
        // 与 Computer Use bar 同一组真实路径：会话回合停止 + 服务端控制停止；随后短暂显示
        // 「已停止」再收起。
        onStop: () => {
          onStop();
          session.stopComputerControl();
          store().markStopped(sessionId, Date.now());
        },
        onMove: (next) => store().setPosition(sessionId, next),
        onResize: (nextWidth, next) => {
          store().setWidth(sessionId, nextWidth);
          store().setPosition(sessionId, next);
        },
      }}
    />
  );

  return (
    <>
      <span ref={anchorRef} hidden />
      {rect && !hiddenFlag && typeof document !== "undefined"
        ? createPortal(panel, document.body)
        : panel}
    </>
  );
}
