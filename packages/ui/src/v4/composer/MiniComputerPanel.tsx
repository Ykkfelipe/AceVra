// M3: persistent floating mini Computer panel (picture-in-picture) over the conversation.
//
// 纯投影呈现：动作/目标/光标事实来自宿主维护的 workspace 投影，像素来自 signed Helper 对
// agent 目标窗口的窗口级 SCStream（useLocalComputerStream → workspace_stream）。屏幕级的
// observation 帧只属于 agent 观察通道，绝不作为这里的实时预览。这里没有第二个状态机，也
// 没有计时器合成的动作。
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
import { formatComputerActionLabel } from "@/lib/computerActionLabel.js";
import type { UseComputerUseSessionResult } from "@/hooks/useComputerUseSession.js";
import { useLocalComputerStream } from "@/hooks/useLocalComputerStream.js";
import type { LocalStreamState } from "@/computers/localComputerStream.js";
import { useMiniComputerStore } from "@/store/miniComputerStore.js";

const WORKSPACE_STATE_MESSAGE_ID: Record<CuaWorkspaceView["state"], string> = {
  idle: "chat.miniComputer.state.idle",
  observing: "chat.miniComputer.state.observing",
  acting: "chat.miniComputer.state.acting",
  paused: "chat.miniComputer.state.paused",
  failed: "chat.miniComputer.state.failed",
  stale: "chat.miniComputer.state.stale",
};

/**
 * Places the logical cursor over an `object-contain` frame: the displayed frame is
 * min(100cqw, ar·100cqh) wide and min(100cqh, 100cqw/ar) tall, centred in the frame area.
 */
export function localCursorStyle(
  position: { left: number; top: number },
  aspectRatio: number,
): { left: string; top: string } {
  const fx = (position.left / 100 - 0.5).toFixed(4);
  const fy = (position.top / 100 - 0.5).toFixed(4);
  const ar = aspectRatio.toFixed(4);
  return {
    left: `calc(50cqw + ${fx} * min(100cqw, ${ar} * 100cqh))`,
    top: `calc(50cqh + ${fy} * min(100cqh, 100cqw / ${ar}))`,
  };
}

export interface MiniComputerPanelData {
  workspace: CuaWorkspaceView;
  /** Window-scoped live stream of the agent's target window (never a screen observation). */
  stream: LocalStreamState;
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
    workspace: polledWorkspace,
    stream,
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

  // 流读取（~12 Hz）随帧带回同一时刻的投影，比 1 s 会话轮询更新；没有时回落到轮询投影。
  const workspace = stream.workspace ?? polledWorkspace;
  const targetLabel = workspace.target?.app ?? null;
  const title = targetLabel ?? intl.formatMessage({ id: "chat.miniComputer.title" });
  const stateLabel = intl.formatMessage({ id: WORKSPACE_STATE_MESSAGE_ID[workspace.state] });

  // Truthful caption: 与 transcript 共用同一套 product-owned Computer 动作标签
  // （computerActionLabel），不采用模型自述文本。目标名作为旁边 chip 一样由投影给出。
  const captionParts = workspace.action
    ? [
        formatComputerActionLabel(intl, workspace.action.method, {
          app: workspace.action.targetLabel ?? targetLabel,
        }),
      ]
    : [];
  const done = !turnRunning && workspace.state === "idle" && !paused;
  const caption =
    captionParts.length > 0
      ? captionParts.join(" · ")
      : done
        ? intl.formatMessage({ id: "chat.miniComputer.done" })
        : stateLabel;

  // Mode: background is the workspace default; "Exclusive control" only for a real lease.
  const modeLabel = leaseActive
    ? intl.formatMessage({ id: "chat.miniComputer.mode.exclusive" })
    : workspace.backendId === "agent-workspace"
      ? intl.formatMessage({ id: "chat.miniComputer.mode.background" })
      : null;

  const liveFrame = stream.stream.frame;
  const frameUrl = liveFrame?.url ?? null;
  const cursorPosition = stream.cursor;
  const placeholderId =
    stream.status === "unavailable"
      ? "chat.miniComputer.frame.unavailable"
      : workspace.target
        ? "chat.miniComputer.frame.waiting"
        : "chat.miniComputer.frame.none";

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
      {/* Live, window-scoped: only the AgentWorkspace target window, latest frame only. */}
      <div className="relative flex min-h-0 w-full flex-1 items-center justify-center bg-black/40 [container-type:size]">
        {frameUrl ? (
          <img
            data-testid={TID_V4_MINI_COMPUTER_FRAME}
            data-frame-seq={liveFrame?.seq}
            data-frame-source={stream.identity}
            data-frame-captured-at={liveFrame?.capturedAt}
            src={frameUrl}
            alt={intl.formatMessage({ id: "chat.miniComputer.frame.alt" })}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <div className="flex flex-col items-center gap-1 p-4 text-ui-sm text-foreground-subtle">
            {stream.status === "waiting" && workspace.target ? (
              <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
            ) : null}
            <span>{intl.formatMessage({ id: placeholderId })}</span>
          </div>
        )}
        {frameUrl && cursorPosition && stream.aspectRatio ? (
          // Logical agent cursor: display-only, positioned inside the captured window. The frame
          // is letterboxed (object-contain), so the offset is computed against the displayed
          // frame box via container query units, keeping it aligned across resizes.
          <span
            data-testid={TID_V4_MINI_COMPUTER_CURSOR}
            data-cursor-left={cursorPosition.left.toFixed(1)}
            data-cursor-top={cursorPosition.top.toFixed(1)}
            className="pointer-events-none absolute text-foreground drop-shadow"
            style={localCursorStyle(cursorPosition, stream.aspectRatio)}
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
  // 可视需求只在面板可见时存在：隐藏/不相关即停止窗口流（stop），不影响执行。
  const stream = useLocalComputerStream(sessionId, Boolean(workspace) && relevant && !hiddenFlag);

  if (!sessionId || !workspace || !relevant) return null;

  return (
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
