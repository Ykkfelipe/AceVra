// M3: persistent floating mini Computer panel (picture-in-picture) over the conversation.
//
// 纯投影呈现：一切事实来自宿主维护的 workspace 投影（session view 的 `workspace` 段），
// 这里没有第二个状态机、没有计时器合成的动作、也没有任何捕获路径——轮询只读快照，
// 帧像素只按 frameId 取一次（复用 useComputerUseSession 的受控帧读取）。
//
// 零偷取：渲染本面板不激活任何应用、不移动物理光标、不获取任何租约。后台语义通过
// "Working in background" 呈现；只有原生租约真正 active 时才出现 "Exclusive control"。
// × 只隐藏面板（呈现偏好，miniComputerStore），绝不停止任务/暂停执行；展开是同一
// workspace 的另一种呈现，不是第二个会话。
import {
  LoaderCircleIcon,
  Maximize2Icon,
  Minimize2Icon,
  MonitorPauseIcon,
  MonitorPlayIcon,
  MousePointer2Icon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  TID_V4_MINI_COMPUTER,
  TID_V4_MINI_COMPUTER_CAPTION,
  TID_V4_MINI_COMPUTER_CLOSE,
  TID_V4_MINI_COMPUTER_CURSOR,
  TID_V4_MINI_COMPUTER_EXPAND,
  TID_V4_MINI_COMPUTER_FRAME,
  TID_V4_MINI_COMPUTER_PAUSE,
  TID_V4_MINI_COMPUTER_REOPEN,
  TID_V4_MINI_COMPUTER_STOP,
} from "@zcode/shared";
import type { CuaComputerUseSessionView, CuaWorkspaceView } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  ComputerUsePreviewState,
  UseComputerUseSessionResult,
} from "@/hooks/useComputerUseSession.js";
import { useMiniComputerStore } from "@/store/miniComputerStore.js";

const WORKSPACE_STATE_MESSAGE_ID: Record<CuaWorkspaceView["state"], string> = {
  idle: "chat.miniComputer.state.idle",
  observing: "chat.miniComputer.state.observing",
  acting: "chat.miniComputer.state.acting",
  paused: "chat.miniComputer.state.paused",
  failed: "chat.miniComputer.state.failed",
  stale: "chat.miniComputer.state.stale",
};

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** Logical cursor position inside the frame, in percent of the captured frame size. */
export function workspaceCursorPercent(
  cursor: { x: number | null; y: number | null },
  dimensions: { width: number; height: number } | null | undefined,
): { left: number; top: number } | null {
  if (!dimensions || !Number.isFinite(dimensions.width) || !Number.isFinite(dimensions.height)) {
    // 没有可靠的帧尺寸就无法诚实地投影坐标：宁可少显示，也不猜。
    return null;
  }
  if (cursor.x === null || cursor.y === null) return null;
  return {
    left: clampPercent((cursor.x / dimensions.width) * 100),
    top: clampPercent((cursor.y / dimensions.height) * 100),
  };
}

export interface MiniComputerPanelData {
  workspace: CuaWorkspaceView;
  preview: ComputerUsePreviewState;
  /** Real admission pause from the lease authority (never a UI-only state). */
  paused: boolean;
  /** True only while the native exclusive lease is actually active (escalation). */
  leaseActive: boolean;
  turnRunning: boolean;
  /** Presentational preferences from miniComputerStore, keyed by session. */
  hidden: boolean;
  expanded: boolean;
  /** Whether the workspace is still worth a reopen affordance. */
  relevant: boolean;
  /** Optimistic command in flight from the real service path. */
  pending: "pause" | "resume" | "stop" | null;
}

export interface MiniComputerPanelActions {
  onHide: () => void;
  onReopen: () => void;
  onSetExpanded: (expanded: boolean) => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

/**
 * Exported for deterministic render tests; the wired component owns store/service wiring.
 */
export function MiniComputerPanelMounted(props: {
  data: MiniComputerPanelData;
  actions: MiniComputerPanelActions;
}) {
  const { data, actions } = props;
  const { intl } = useZCodeIntl();
  const {
    workspace,
    preview,
    paused,
    leaseActive,
    turnRunning,
    hidden,
    expanded,
    relevant,
    pending,
  } = data;

  if (hidden) {
    if (!relevant) return null;
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid={TID_V4_MINI_COMPUTER_REOPEN}
        onClick={actions.onReopen}
        className="pointer-events-auto shadow-lg"
        aria-label={intl.formatMessage({ id: "chat.miniComputer.reopen" })}
      >
        <MousePointer2Icon className="size-3.5" aria-hidden />
        {intl.formatMessage({ id: "chat.miniComputer.reopen" })}
      </Button>
    );
  }

  const targetLabel = workspace.target?.app ?? null;
  const title = targetLabel ?? intl.formatMessage({ id: "chat.miniComputer.title" });
  const stateLabel = intl.formatMessage({ id: WORKSPACE_STATE_MESSAGE_ID[workspace.state] });

  // Truthful caption: the projection's own action fact; a finished task shows the completion
  // mark only once the turn stopped and nothing is in flight.
  const actionLabel = workspace.action
    ? [
        workspace.action.label,
        workspace.action.targetLabel && workspace.action.targetLabel !== targetLabel
          ? workspace.action.targetLabel
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  const done = !turnRunning && workspace.state === "idle" && !paused;
  const caption =
    actionLabel ?? (done ? intl.formatMessage({ id: "chat.miniComputer.done" }) : stateLabel);

  // Mode: background is the workspace default; "Exclusive control" only for a real lease.
  const modeLabel = leaseActive
    ? intl.formatMessage({ id: "chat.miniComputer.mode.exclusive" })
    : workspace.backendId === "agent-workspace"
      ? intl.formatMessage({ id: "chat.miniComputer.mode.background" })
      : null;

  const frame = workspace.frame;
  const frameUrl = preview.status === "available" ? (preview.dataUrl ?? null) : null;
  const cursorPosition = workspace.cursor
    ? workspaceCursorPercent(workspace.cursor, frame?.dimensions)
    : null;

  const body = (
    <>
      <div className="flex items-center gap-1 border-b border-[var(--color-border)] px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-ui-sm font-medium" title={title}>
          {title}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid={TID_V4_MINI_COMPUTER_EXPAND}
          onClick={() => actions.onSetExpanded(!expanded)}
          aria-label={
            expanded
              ? intl.formatMessage({ id: "chat.miniComputer.exitExpand" })
              : intl.formatMessage({ id: "chat.miniComputer.expand" })
          }
        >
          {expanded ? (
            <Minimize2Icon className="size-3.5" aria-hidden />
          ) : (
            <Maximize2Icon className="size-3.5" aria-hidden />
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid={TID_V4_MINI_COMPUTER_CLOSE}
          onClick={actions.onHide}
          aria-label={intl.formatMessage({ id: "chat.miniComputer.hide" })}
        >
          <XIcon className="size-3.5" aria-hidden />
        </Button>
      </div>
      {/* Snapshot, not a stream: the projection's latest frame, one fetch per frameId. */}
      <div className="relative flex min-h-0 w-full flex-1 items-center justify-center bg-black/40">
        {frameUrl ? (
          <img
            data-testid={TID_V4_MINI_COMPUTER_FRAME}
            data-frame-id={frame?.frameId}
            src={frameUrl}
            alt={intl.formatMessage({ id: "chat.miniComputer.frame.alt" })}
            className={
              "max-h-full max-w-full object-contain" +
              (frame?.freshness === "stale" ? " opacity-50" : "")
            }
          />
        ) : (
          <div className="flex flex-col items-center gap-1 p-4 text-ui-sm text-foreground-subtle">
            {preview.status === "loading" ? (
              <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
            ) : null}
            <span>{intl.formatMessage({ id: "chat.miniComputer.frame.none" })}</span>
          </div>
        )}
        {frameUrl && cursorPosition && workspace.cursor ? (
          // Logical agent cursor: display-only projection inside the workspace frame.
          <span
            data-testid={TID_V4_MINI_COMPUTER_CURSOR}
            data-cursor-x={workspace.cursor.x ?? undefined}
            data-cursor-y={workspace.cursor.y ?? undefined}
            className="pointer-events-none absolute text-foreground drop-shadow"
            style={{ left: `${cursorPosition.left}%`, top: `${cursorPosition.top}%` }}
          >
            <MousePointer2Icon className="size-4 -translate-x-0.5 -translate-y-0.5 fill-current" />
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2 border-t border-[var(--color-border)] px-3 py-1.5">
        <div className="flex min-w-0 flex-1 flex-col">
          <span
            data-testid={TID_V4_MINI_COMPUTER_CAPTION}
            className="truncate text-ui-sm"
            title={caption}
          >
            {caption}
          </span>
          <span className="flex min-w-0 items-center gap-2 text-ui-xs text-foreground-subtle">
            <span data-testid={`${TID_V4_MINI_COMPUTER}-state`}>{stateLabel}</span>
            {modeLabel ? (
              <>
                <span aria-hidden>·</span>
                <span data-testid={`${TID_V4_MINI_COMPUTER}-mode`}>{modeLabel}</span>
              </>
            ) : null}
            {frame?.freshness === "superseded" ? (
              <span data-testid={`${TID_V4_MINI_COMPUTER}-freshness`} className="truncate">
                {intl.formatMessage({ id: "chat.miniComputer.freshness.superseded" })}
              </span>
            ) : null}
          </span>
        </div>
        {paused ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={TID_V4_MINI_COMPUTER_PAUSE}
            onClick={actions.onResume}
            disabled={pending !== null}
            aria-label={intl.formatMessage({ id: "chat.computerUseBar.resume" })}
          >
            <MonitorPlayIcon className="size-3.5" aria-hidden />
            {intl.formatMessage({ id: "chat.computerUseBar.resume" })}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={TID_V4_MINI_COMPUTER_PAUSE}
            onClick={actions.onPause}
            disabled={pending !== null}
            aria-label={intl.formatMessage({ id: "chat.computerUseBar.pause" })}
          >
            <MonitorPauseIcon className="size-3.5" aria-hidden />
            {intl.formatMessage({ id: "chat.computerUseBar.pause" })}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={TID_V4_MINI_COMPUTER_STOP}
          onClick={actions.onStop}
          disabled={pending === "stop"}
          aria-label={intl.formatMessage({ id: "chat.computerUseBar.stop" })}
        >
          <SquareIcon className="size-3.5" aria-hidden />
          {intl.formatMessage({ id: "chat.computerUseBar.stop" })}
        </Button>
      </div>
    </>
  );

  if (expanded) {
    // 另一种呈现，同一 workspace：同一投影、同一帧、同一投影光标，不是第二个会话。
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
        <div
          data-testid={TID_V4_MINI_COMPUTER}
          data-mini-computer-expanded="true"
          data-mini-computer-state={workspace.state}
          className="flex h-[80vh] w-[80vw] max-w-3xl flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-surface shadow-lg"
        >
          {body}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid={TID_V4_MINI_COMPUTER}
      data-mini-computer-expanded="false"
      data-mini-computer-state={workspace.state}
      className="pointer-events-auto flex h-64 w-[22rem] flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-surface text-foreground shadow-lg"
    >
      {body}
    </div>
  );
}

/** Relevance window: how long a finished workspace stays worth showing/reopening. */
const MINI_COMPUTER_RELEVANCE_MS = 15_000;

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

/**
 * Wired component: one shared `useComputerUseSession` poll (hoisted by the composer) feeds
 * both the Computer Use bar and this panel — a second poller would double the host RPC and
 * the Helper reconciliation for no benefit. Presentation preferences (hidden/expanded) come
 * from the session-keyed store; workspace facts come only from the service projection.
 */
export function MiniComputerPanel(props: {
  session: UseComputerUseSessionResult;
  sessionId: string | null | undefined;
  turnRunning: boolean;
  onStop: () => void;
}) {
  const { session, sessionId, turnRunning, onStop } = props;
  const hiddenFlag = useMiniComputerStore((state) =>
    sessionId ? state.hiddenBySession[sessionId] === true : false,
  );
  const expandedFlag = useMiniComputerStore((state) =>
    sessionId ? state.expandedBySession[sessionId] === true : false,
  );
  const hide = useMiniComputerStore((state) => state.hide);
  const reopen = useMiniComputerStore((state) => state.reopen);
  const setExpanded = useMiniComputerStore((state) => state.setExpanded);

  // 1 s clock only for the presentation relevance window; it never drives workspace facts.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const view = session.session;
  const workspace = view?.present ? (view.workspace ?? null) : null;
  const paused = view?.present ? view.paused : false;
  const leaseActive = view?.present ? view.lease.state === "active" : false;

  const relevant = isAgentWorkspaceActive(view, turnRunning, clock);

  if (!sessionId || !workspace || !relevant) return null;

  return (
    <MiniComputerPanelMounted
      data={{
        workspace,
        preview: session.preview,
        paused,
        leaseActive,
        turnRunning,
        hidden: hiddenFlag,
        expanded: expandedFlag,
        relevant,
        pending: session.pending,
      }}
      actions={{
        // × 只改呈现偏好：不停止任务、不暂停执行、不丢弃 workspace 投影。
        onHide: () => hide(sessionId),
        onReopen: () => reopen(sessionId),
        onSetExpanded: (value) => setExpanded(sessionId, value),
        onPause: () => session.pause(),
        onResume: () => session.resume(),
        // 与 Computer Use bar 同一组真实路径：会话回合停止 + 服务端控制停止。
        onStop: () => {
          onStop();
          session.stopComputerControl();
        },
      }}
    />
  );
}
