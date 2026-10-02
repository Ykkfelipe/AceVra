// LocalComputerPreview window: the presentational floating window (compact / expanded).
//
// 只渲染传入的会话事实与呈现矩形；拖动/缩放手势在本地跟手、松手才提交，不触碰会话事实与窗口
// 流。展开与紧凑是同一棵元素树（同一个面板元素只换位置与尺寸），不会重新挂载画面。
import {
  CircleCheckIcon,
  GripVerticalIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  Minimize2Icon,
  MonitorPauseIcon,
  MonitorPlayIcon,
  MousePointer2Icon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { useCallback, type ReactNode } from "react";
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
import type { CuaWorkspaceView } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatComputerActionLabel } from "@/lib/computerActionLabel.js";
import type { LocalStreamState } from "@/computers/localComputerStream.js";
import {
  PREVIEW_CHROME_HEIGHT,
  type PreviewPoint,
  type PreviewRect,
} from "@/computers/localPreviewGeometry.js";
import { usePreviewWindowGestures } from "@/computers/usePreviewWindowGestures.js";

const WORKSPACE_STATE_MESSAGE_ID: Record<CuaWorkspaceView["state"], string> = {
  idle: "chat.miniComputer.state.idle",
  observing: "chat.miniComputer.state.observing",
  acting: "chat.miniComputer.state.acting",
  paused: "chat.miniComputer.state.paused",
  failed: "chat.miniComputer.state.failed",
  stale: "chat.miniComputer.state.stale",
};

/** How long the "Stopped" state stays before the preview dismisses itself. */
export const MINI_COMPUTER_STOPPED_DISMISS_MS = 1_500;

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
  /** The user pressed Stop; the preview shows "Stopped" briefly, then dismisses. */
  stopped?: boolean;
  /** Where to draw the floating window (viewport px). Absent → static layout (tests/SSR). */
  rect?: PreviewRect;
}

export interface MiniComputerPanelActions {
  onHide: () => void;
  onReopen: () => void;
  onSetExpanded: (expanded: boolean) => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onMove?: (position: PreviewPoint) => void;
  onResize?: (width: number, position: PreviewPoint) => void;
}

function TitleButton(props: {
  testId: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      data-testid={props.testId}
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={props.label}
      title={props.label}
    >
      {props.children}
    </Button>
  );
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
    stopped = false,
  } = data;
  const noopMove = useCallback(() => undefined, []);
  const gestures = usePreviewWindowGestures({
    rect: data.rect ?? { x: 0, y: 0, width: 0, frameHeight: 0 },
    aspectRatio: stream.aspectRatio,
    enabled: Boolean(data.rect) && !expanded,
    onMove: actions.onMove ?? noopMove,
    onResize: actions.onResize ?? noopMove,
  });

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
  const done = !turnRunning && workspace.state === "idle" && !paused;
  // Truthful caption: product-owned labels only (computerActionLabel), never model text.
  const caption = stopped
    ? intl.formatMessage({ id: "chat.miniComputer.stopped" })
    : paused || workspace.state === "failed" || workspace.state === "stale"
      ? stateLabel
      : workspace.action && !done
        ? formatComputerActionLabel(intl, workspace.action.method, {
            app: workspace.action.targetLabel ?? targetLabel,
          })
        : done
          ? intl.formatMessage({ id: "chat.miniComputer.done" })
          : stateLabel;
  const modeLabel = leaseActive
    ? intl.formatMessage({ id: "chat.miniComputer.mode.exclusive" })
    : intl.formatMessage({ id: "chat.miniComputer.mode.background" });
  const live = stream.status === "live" && !paused && !stopped && !done;

  const liveFrame = stream.stream.frame;
  const frameUrl = liveFrame?.url ?? null;
  const cursorPosition = stream.cursor;
  const placeholderId =
    stream.status === "unavailable"
      ? "chat.miniComputer.frame.unavailable"
      : workspace.target
        ? "chat.miniComputer.frame.waiting"
        : "chat.miniComputer.frame.none";

  const rect = gestures.rect;
  const floating = Boolean(data.rect);
  const style = floating
    ? {
        width: rect.width,
        transform: `translate3d(${rect.x}px, ${rect.y}px, 0)`,
      }
    : undefined;
  const frameStyle = floating ? { height: rect.frameHeight } : undefined;
  const expandLabel = intl.formatMessage({
    id: expanded ? "chat.miniComputer.restore" : "chat.miniComputer.expand",
  });

  return (
    <>
      {expanded && floating ? (
        // 展开时的轻遮罩：点击即还原；同一个面板元素只换位置与尺寸，不重新挂载画面。
        <div
          aria-hidden
          className="fixed inset-0 z-40 bg-black/30"
          onClick={() => actions.onSetExpanded(false)}
        />
      ) : null}
      <div
        data-testid={TID_V4_MINI_COMPUTER}
        data-mini-computer-expanded={expanded ? "true" : "false"}
        data-mini-computer-state={stopped ? "stopped" : workspace.state}
        data-mini-computer-done={done ? "true" : undefined}
        data-mini-computer-dragging={gestures.active ? "true" : undefined}
        role="dialog"
        aria-label={title}
        style={style}
        className={cn(
          "pointer-events-auto flex flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-surface text-foreground shadow-lg",
          floating ? "fixed left-0 top-0 z-40" : expanded ? "w-[80vw] max-w-3xl" : "w-[22rem]",
          floating && !gestures.active && "transition-[transform,width] duration-150 ease-out",
        )}
      >
        <div
          className={cn(
            "flex shrink-0 select-none items-center gap-1.5 pl-1.5 pr-1",
            floating && !expanded && "cursor-grab active:cursor-grabbing",
          )}
          style={{ height: PREVIEW_CHROME_HEIGHT }}
          data-testid={`${TID_V4_MINI_COMPUTER}-titlebar`}
          aria-label={intl.formatMessage({ id: "chat.miniComputer.move" })}
          {...gestures.dragHandlers}
        >
          {floating && !expanded ? (
            <GripVerticalIcon className="size-3.5 shrink-0 text-foreground-subtlest" aria-hidden />
          ) : null}
          {done ? (
            // 完成态用绿色对勾替代状态点（Codex/Claude 式收尾信号）：任务做完时一眼可见。
            <CircleCheckIcon
              data-testid={`${TID_V4_MINI_COMPUTER}-done`}
              aria-hidden
              className="size-3.5 shrink-0 text-success"
            />
          ) : (
            <span
              aria-hidden
              className={cn(
                "size-2 shrink-0 rounded-full",
                live ? "bg-success animate-pulse" : paused ? "bg-warning" : "bg-foreground-subtlest",
              )}
            />
          )}
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-ui-sm font-medium" title={title}>
              {title}
            </span>
            <span
              data-testid={TID_V4_MINI_COMPUTER_CAPTION}
              className="truncate text-ui-xs text-foreground-subtle"
              title={`${caption} · ${modeLabel}`}
            >
              {caption}
            </span>
          </div>
          <span className="sr-only" data-testid={`${TID_V4_MINI_COMPUTER}-mode`}>
            {modeLabel}
          </span>
          {paused ? (
            <TitleButton
              testId={TID_V4_MINI_COMPUTER_PAUSE}
              label={intl.formatMessage({ id: "chat.computerUseBar.resume" })}
              onClick={actions.onResume}
              disabled={pending !== null || stopped}
            >
              <MonitorPlayIcon aria-hidden />
            </TitleButton>
          ) : (
            <TitleButton
              testId={TID_V4_MINI_COMPUTER_PAUSE}
              label={intl.formatMessage({ id: "chat.computerUseBar.pause" })}
              onClick={actions.onPause}
              disabled={pending !== null || stopped || done}
            >
              <MonitorPauseIcon aria-hidden />
            </TitleButton>
          )}
          <TitleButton
            testId={TID_V4_MINI_COMPUTER_STOP}
            label={intl.formatMessage({ id: "chat.computerUseBar.stop" })}
            onClick={actions.onStop}
            disabled={pending === "stop" || stopped}
          >
            <SquareIcon aria-hidden />
          </TitleButton>
          <TitleButton
            testId={TID_V4_MINI_COMPUTER_EXPAND}
            label={expandLabel}
            onClick={() => actions.onSetExpanded(!expanded)}
          >
            {expanded ? <Minimize2Icon aria-hidden /> : <Maximize2Icon aria-hidden />}
          </TitleButton>
          <TitleButton
            testId={TID_V4_MINI_COMPUTER_CLOSE}
            label={intl.formatMessage({ id: "chat.miniComputer.hide" })}
            onClick={actions.onHide}
          >
            <XIcon aria-hidden />
          </TitleButton>
        </div>
        {/* Live, window-scoped: only the AgentWorkspace target window, latest frame only. */}
        <div
          className={cn(
            "relative flex w-full items-center justify-center overflow-hidden bg-black/40 [container-type:size]",
            !floating && (expanded ? "h-[60vh]" : "h-52"),
          )}
          style={frameStyle}
        >
          {frameUrl ? (
            <img
              data-testid={TID_V4_MINI_COMPUTER_FRAME}
              data-frame-seq={liveFrame?.seq}
              data-frame-source={stream.identity}
              data-frame-captured-at={liveFrame?.capturedAt}
              src={frameUrl}
              alt={intl.formatMessage({ id: "chat.miniComputer.frame.alt" })}
              draggable={false}
              className={cn("h-full w-full object-contain", (paused || stopped) && "opacity-60")}
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
            // Logical agent cursor: display-only, positioned inside the captured window.
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
          {floating && !expanded ? (
            <span
              data-testid={`${TID_V4_MINI_COMPUTER}-resize`}
              aria-label={intl.formatMessage({ id: "chat.miniComputer.resize" })}
              role="separator"
              className="absolute bottom-0 right-0 size-4 cursor-nwse-resize touch-none"
              {...gestures.resizeHandlers}
            >
              <span
                aria-hidden
                className="absolute bottom-1 right-1 size-2 rounded-br-sm border-b-2 border-r-2 border-foreground-subtlest"
              />
            </span>
          ) : null}
        </div>
      </div>
    </>
  );
}
