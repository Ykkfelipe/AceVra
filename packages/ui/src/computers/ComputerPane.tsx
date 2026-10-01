import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import {
  HandIcon,
  Maximize2Icon,
  Minimize2Icon,
  MonitorIcon,
  PlayIcon,
  SquareIcon,
  Undo2Icon,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useComputer, useSshComputers } from "@/hooks/useComputer.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  createMoveThrottle,
  isGiveBackChord,
  mapKeyEvent,
  mapPointToRemote,
  mapRemoteToView,
  mouseButtonName,
  wheelClicks,
} from "./computerInput.js";
import {
  computerPaneActions,
  computerStatusKind,
  shouldStream,
  type ComputerStatusKind,
} from "./computerPaneModel.js";

const MOVE_HZ = 40;

interface ComputerPaneProps {
  computerId: string | null;
  /** Visible active tab of a visible side pane: the only time the stream runs. */
  visible: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onSelectComputer: (computerId: string) => void;
}

const STATUS_TONE: Record<ComputerStatusKind, string> = {
  connecting: "bg-foreground-subtle",
  offline: "bg-destructive",
  idle: "bg-foreground-subtle",
  working: "bg-success",
  inControl: "bg-primary",
  physicalPause: "bg-warning",
  paused: "bg-warning",
};

const KNOWN_OFFLINE = new Set([
  "auth_failed",
  "host_unknown",
  "unreachable",
  "worker_unreachable",
  "forward_failed",
]);
const KNOWN_ACTIVITY = new Set(["screenshot", "click", "move", "drag", "scroll", "type", "key"]);

/**
 * Computer tab (acevra-agent-computer.md §3.3): live screen of one SSH computer, status, activity,
 * Take control / Give back, Resume, Stop and Expand. Presentation only — the worker owns control.
 */
export function ComputerPane(props: ComputerPaneProps) {
  const { computerId, visible, expanded, onToggleExpand, onSelectComputer } = props;
  const { intl } = useZCodeIntl();
  const t = useCallback(
    (id: string, values?: Record<string, string>) =>
      intl.formatMessage({ id: `computers.panel.${id}` }, values),
    [intl],
  );
  const { list } = useSshComputers();
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const streaming = shouldStream(computerId, visible);
  // 先拿到 view 才知道是否处于接管；接管时切到高帧率交互档位。
  const [interactive, setInteractive] = useState(false);
  const { available, view, frame, run, sendInput } = useComputer(computerId, {
    streaming,
    interactive,
  });
  const kind = computerStatusKind(view);
  const actions = computerPaneActions(view);
  const inControl = kind === "inControl";
  useEffect(() => setInteractive(inControl), [inControl]);

  useEffect(() => {
    const only = list?.length === 1 ? list[0] : undefined;
    if (computerId || !only) return;
    onSelectComputer(only.id);
  }, [computerId, list, onSelectComputer]);

  const name = view?.name ?? list?.find((item) => item.id === computerId)?.name ?? "";
  const runCommand = useCallback(
    async (command: "takeControl" | "giveBack" | "resume" | "stop") => {
      setBusy(true);
      setNote(null);
      const result = await run(command);
      setBusy(false);
      if (!result.ok) {
        logger.warn(`[computers] ${command} failed: ${result.reason}`);
        setNote(t("commandFailed", { reason: result.reason }));
      }
      return result;
    },
    [run, t],
  );

  const surfaceRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const throttle = useMemo(
    () => createMoveThrottle(MOVE_HZ, (event) => sendInput([event])),
    [sendInput],
  );
  const toRemote = useCallback(
    (clientX: number, clientY: number) => {
      const image = imageRef.current;
      if (!image || !frame) return null;
      const rect = image.getBoundingClientRect();
      return mapPointToRemote(
        { x: clientX - rect.left, y: clientY - rect.top },
        { width: rect.width, height: rect.height },
        { width: frame.screenWidth, height: frame.screenHeight },
      );
    },
    [frame],
  );

  const capturing = inControl && focused;
  const giveBack = useCallback(() => {
    throttle.cancel();
    sendInput([{ kind: "release" }]);
    void runCommand("giveBack");
  }, [runCommand, sendInput, throttle]);

  // 接管且聚焦时在 window 捕获阶段拦截按键：被转发的按键绝不触发 AceVra 自身快捷键。
  useEffect(() => {
    if (!capturing) return;
    const handle = (event: KeyboardEvent) => {
      if (document.activeElement !== surfaceRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "keydown" && isGiveBackChord(event)) {
        giveBack();
        return;
      }
      sendInput(mapKeyEvent(event, event.type === "keydown" ? "down" : "up"));
    };
    window.addEventListener("keydown", handle, true);
    window.addEventListener("keyup", handle, true);
    return () => {
      window.removeEventListener("keydown", handle, true);
      window.removeEventListener("keyup", handle, true);
    };
  }, [capturing, giveBack, sendInput]);

  const onPointerMove = (event: ReactPointerEvent) => {
    if (!inControl) return;
    const point = toRemote(event.clientX, event.clientY);
    if (point) throttle.move(point);
  };
  const onPointerButton = (event: ReactPointerEvent, phase: "down" | "up") => {
    if (!inControl) return;
    const button = mouseButtonName(event.button);
    const point = toRemote(event.clientX, event.clientY);
    if (!button || !point) return;
    if (phase === "down") surfaceRef.current?.focus();
    throttle.flush();
    sendInput([{ kind: phase, x: point.x, y: point.y, button }]);
  };
  const onWheel = (event: ReactWheelEvent) => {
    if (!inControl) return;
    const point = toRemote(event.clientX, event.clientY);
    const dy = wheelClicks(event.deltaY, event.deltaMode);
    if (point && dy !== 0) sendInput([{ kind: "scroll", x: point.x, y: point.y, dy }]);
  };
  const swallowKey = (event: ReactKeyboardEvent) => {
    if (capturing) event.preventDefault();
  };

  if (!available) {
    return <PaneMessage text={t("unavailable")} />;
  }
  if (!computerId) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background" data-testid="computer-pane">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
          <MonitorIcon className="size-4 text-foreground-subtle" aria-hidden="true" />
          <h2 className="text-ui-base font-semibold text-foreground">{t("tabTitle")}</h2>
        </div>
        <div className="space-y-2 px-4 py-4">
          {list && list.length === 0 ? (
            <p className="text-ui-base text-foreground-subtle">{t("none")}</p>
          ) : (
            <>
              <p className="text-ui-base text-foreground-subtle">{t("choose")}</p>
              {(list ?? []).map((item) => (
                <Button key={item.id} variant="outline" onClick={() => onSelectComputer(item.id)}>
                  <MonitorIcon data-icon="inline-start" />
                  {item.name}
                </Button>
              ))}
            </>
          )}
        </div>
      </div>
    );
  }

  const statusText =
    kind === "offline"
      ? t("status.offline", {
          name,
          reason: t(
            `offline.${KNOWN_OFFLINE.has(view?.offlineReason ?? "") ? view?.offlineReason : "other"}`,
          ),
        })
      : t(`status.${kind}`, { name });
  const activity =
    kind === "working" && view?.lastAction
      ? t(`activity.${KNOWN_ACTIVITY.has(view.lastAction) ? view.lastAction : "other"}`)
      : null;
  const cursor =
    frame && imageRef.current
      ? mapRemoteToView(
          { x: frame.cursorX, y: frame.cursorY },
          { width: imageRef.current.clientWidth, height: imageRef.current.clientHeight },
          { width: frame.screenWidth, height: frame.screenHeight },
        )
      : null;

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="computer-pane"
      data-computer-status={kind}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span
          className={cn("size-2 shrink-0 rounded-full", STATUS_TONE[kind])}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-ui-base font-medium text-foreground"
            data-testid="computer-status"
          >
            {statusText}
          </div>
          {activity || note ? (
            <div
              className="truncate text-ui-xs text-foreground-subtle"
              data-testid="computer-activity"
            >
              {note ?? activity}
            </div>
          ) : null}
        </div>
        {actions.resume ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void runCommand("resume")}
          >
            <PlayIcon data-icon="inline-start" />
            {t("resume")}
          </Button>
        ) : null}
        {actions.takeControl ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            data-testid="computer-take-control"
            onClick={() =>
              void runCommand("takeControl").then(
                (result) => result.ok && surfaceRef.current?.focus(),
              )
            }
          >
            <HandIcon data-icon="inline-start" />
            {t("takeControl")}
          </Button>
        ) : null}
        {actions.giveBack ? (
          <Button
            size="sm"
            variant="default"
            disabled={busy}
            data-testid="computer-give-back"
            onClick={giveBack}
          >
            <Undo2Icon data-icon="inline-start" />
            {t("giveBack")}
          </Button>
        ) : null}
        {actions.stop ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            data-testid="computer-stop"
            onClick={() => void runCommand("stop")}
          >
            <SquareIcon data-icon="inline-start" />
            {t("stop")}
          </Button>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t(expanded ? "collapse" : "expand")}
          title={t(expanded ? "collapse" : "expand")}
          data-testid="computer-expand"
          onClick={onToggleExpand}
        >
          {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
        </Button>
      </div>
      <div
        ref={surfaceRef}
        role="application"
        aria-label={t("screenLabel", { name })}
        tabIndex={inControl ? 0 : -1}
        data-testid="computer-screen"
        className={cn(
          "relative min-h-0 flex-1 bg-black outline-none",
          inControl ? "cursor-none" : "cursor-default",
          capturing && "ring-2 ring-inset ring-primary",
        )}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          // 失焦时释放远端仍按住的键/鼠标，避免 Ctrl/Alt 卡住。
          if (inControl) sendInput([{ kind: "release" }]);
        }}
        onPointerMove={onPointerMove}
        onPointerDown={(event) => onPointerButton(event, "down")}
        onPointerUp={(event) => onPointerButton(event, "up")}
        onWheel={onWheel}
        onKeyDown={swallowKey}
        onContextMenu={(event) => inControl && event.preventDefault()}
      >
        {frame ? (
          <img
            ref={imageRef}
            src={frame.url}
            alt=""
            draggable={false}
            className="pointer-events-none absolute inset-0 size-full select-none object-contain"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-ui-base text-white/60">
            {kind === "offline" ? statusText : t("waitingForScreen")}
          </div>
        )}
        {cursor && imageRef.current ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black bg-white"
            style={{
              left: imageRef.current.offsetLeft + cursor.x,
              top: imageRef.current.offsetTop + cursor.y,
            }}
          />
        ) : null}
        {inControl && !focused ? (
          <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-md bg-black/70 px-2 py-1 text-ui-xs text-white">
            {t("clickToControl")}
          </div>
        ) : null}
        {capturing ? (
          <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-md bg-black/70 px-2 py-1 text-ui-xs text-white">
            {t("giveBackHint")}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PaneMessage({ text }: { text: string }) {
  return (
    <div
      className="flex h-full items-center justify-center px-4 text-ui-base text-foreground-subtle"
      data-testid="computer-pane"
    >
      {text}
    </div>
  );
}
