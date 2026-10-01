// CUA-4: compact Computer Use session bar mounted directly above the composer.
//
// Pure presentation over `useComputerUseSession` (which projects the service read model).
// No runtime state machine lives here: Pause/Resume write through the service, Stop composes
// the conversation's own turn stop with the existing `stopComputerControl()` operation, and
// "stopped" is only presented once the authority confirms the lease is terminal AND the turn
// is no longer running. The preview is the session's own latest authorized observation —
// fetched once per observation id, labelled as a snapshot, never animated, never a stream.
import { useEffect, useState } from "react";
import {
  LoaderCircleIcon,
  MonitorPauseIcon,
  MonitorPlayIcon,
  MousePointerClickIcon,
  SquareIcon,
} from "lucide-react";
import {
  TID_V4_COMPUTER_USE_BAR,
  TID_V4_COMPUTER_USE_BAR_PAUSE,
  TID_V4_COMPUTER_USE_BAR_PREVIEW,
  TID_V4_COMPUTER_USE_BAR_STOP,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { UseComputerUseSessionResult } from "@/hooks/useComputerUseSession.js";
import {
  resolveComputerUseShownState,
  stopConfirmed,
  type ComputerUseUiState,
} from "@/lib/cuaSessionProjection.js";

/** i18n message id per projected state. */
const STATE_MESSAGE_ID: Record<ComputerUseUiState, string> = {
  idle: "chat.computerUseBar.state.idle",
  observing: "chat.computerUseBar.state.observing",
  backgroundAction: "chat.computerUseBar.state.backgroundAction",
  waitingForForeground: "chat.computerUseBar.state.waitingForForeground",
  exclusiveActive: "chat.computerUseBar.state.exclusiveActive",
  yieldedToUser: "chat.computerUseBar.state.yieldedToUser",
  paused: "chat.computerUseBar.state.paused",
  stopping: "chat.computerUseBar.state.stopping",
  stopped: "chat.computerUseBar.state.stopped",
  failed: "chat.computerUseBar.state.failed",
};

const MODE_MESSAGE_ID: Record<string, string> = {
  observe: "chat.computerUseBar.mode.observe",
  background: "chat.computerUseBar.mode.background",
  control: "chat.computerUseBar.mode.control",
  foreground: "chat.computerUseBar.mode.foreground",
};

export interface ComputerUseBarProps {
  /**
   * The shared `useComputerUseSession` poll hoisted by the composer. M3: the mini Computer
   * panel reads the same poll — one poller feeds both projections.
   */
  session: UseComputerUseSessionResult;
  /** Low-latency turn running authority (composer snapshot `control.canStop`). */
  turnRunning: boolean;
  /** The conversation's existing turn stop command. */
  onStop: () => void;
}

export function ComputerUseBar(props: ComputerUseBarProps) {
  const { session, turnRunning, onStop } = props;
  if (!session.view.visible) return null;
  return <ComputerUseBarMounted session={session} turnRunning={turnRunning} onStop={onStop} />;
}

/** Exported for deterministic render tests; the outer component owns the data wiring. */
export function ComputerUseBarMounted(props: {
  session: UseComputerUseSessionResult;
  turnRunning: boolean;
  onStop: () => void;
}) {
  const { session, turnRunning, onStop } = props;
  const { intl } = useZCodeIntl();
  const { view, preview } = session;
  // Stop confirmation: STOPPING stays shown until BOTH existing truths settle — the turn is
  // no longer running AND the authority reports the control stopped. A click alone never
  // produces "stopped".
  const [stopRequested, setStopRequested] = useState(false);
  useEffect(() => {
    // A click alone never produces "stopped": retire the pending confirmation only when the
    // turn stopped and the authority reports the lease terminal.
    if (stopRequested && stopConfirmed(view.state, turnRunning)) setStopRequested(false);
  }, [stopRequested, turnRunning, view.state]);

  const stopping =
    resolveComputerUseShownState(view.state, stopRequested, session.pending === "stop") ===
    "stopping";
  const shownState: ComputerUseUiState = resolveComputerUseShownState(
    view.state,
    stopRequested,
    session.pending === "stop",
  );

  const stateLabel = intl.formatMessage({ id: STATE_MESSAGE_ID[shownState] });
  const modeId = view.mode ? MODE_MESSAGE_ID[view.mode] : undefined;
  const modeLabel = modeId ? intl.formatMessage({ id: modeId }) : null;

  const targetLabel = [
    view.targetApp,
    view.targetWindow && view.targetWindow !== view.targetApp ? view.targetWindow : null,
  ]
    .filter(Boolean)
    .join(" — ");

  const ageSeconds = view.observation
    ? Math.max(0, Math.round((Date.now() - view.observation.capturedAt) / 1000))
    : null;
  const ageLabel =
    ageSeconds !== null
      ? intl.formatMessage({ id: "chat.computerUseBar.preview.age" }, { seconds: ageSeconds })
      : null;

  const handleStop = (): void => {
    if (stopping) return;
    setStopRequested(true);
    // Reuse BOTH existing truths: the conversation turn stop and the service control stop.
    onStop();
    session.stopComputerControl();
  };

  return (
    <div
      data-testid={TID_V4_COMPUTER_USE_BAR}
      data-cua-state={shownState}
      data-cua-stale={view.observationStale ? "true" : "false"}
      className="mb-2 flex w-full items-center gap-2 rounded-lg border border-[var(--color-border)] bg-surface px-3 py-2 text-ui-base text-foreground"
    >
      <MousePointerClickIcon className="size-4 shrink-0 opacity-70" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-medium">
            {intl.formatMessage({ id: "chat.computerUseBar.title" })}
          </span>
          {targetLabel ? (
            <span className="truncate opacity-80" title={targetLabel}>
              {targetLabel}
            </span>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-2 opacity-80">
          <span data-testid={`${TID_V4_COMPUTER_USE_BAR}-state`}>{stateLabel}</span>
          {modeLabel ? <span aria-hidden>·</span> : null}
          {modeLabel ? <span>{modeLabel}</span> : null}
          {view.effectUnverified ? (
            <span className="text-[var(--color-warning)]">
              {intl.formatMessage({ id: "chat.computerUseBar.effect.unverified" })}
            </span>
          ) : null}
        </div>
        {shownState === "yieldedToUser" ? (
          <div className="opacity-80">
            {intl.formatMessage({ id: "chat.computerUseBar.yieldNotice" })}
          </div>
        ) : null}
      </div>
      {view.observation && preview.status === "available" && preview.dataUrl ? (
        // Snapshot, not live video: one authorized frame per observation id, with its age.
        <img
          data-testid={TID_V4_COMPUTER_USE_BAR_PREVIEW}
          src={preview.dataUrl}
          alt={intl.formatMessage({ id: "chat.computerUseBar.preview.alt" })}
          title={[
            intl.formatMessage({ id: "chat.computerUseBar.preview.snapshot" }),
            ageLabel,
            view.observationStale
              ? intl.formatMessage({ id: "chat.computerUseBar.preview.stale" })
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          className={
            "h-9 w-16 shrink-0 rounded-md border border-[var(--color-border)] object-cover" +
            (view.observationStale ? " opacity-50" : "")
          }
        />
      ) : view.observation && preview.status === "loading" ? (
        <LoaderCircleIcon className="size-4 shrink-0 animate-spin opacity-50" aria-hidden />
      ) : null}
      {view.observationStale ? (
        <span className="shrink-0 opacity-70">
          {intl.formatMessage({ id: "chat.computerUseBar.preview.stale" })}
        </span>
      ) : null}
      {view.pauseAvailable ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={TID_V4_COMPUTER_USE_BAR_PAUSE}
          onClick={session.pause}
          disabled={session.pending !== null || shownState === "stopping"}
          aria-label={intl.formatMessage({ id: "chat.computerUseBar.pause" })}
        >
          <MonitorPauseIcon className="size-3.5" aria-hidden />
          {intl.formatMessage({ id: "chat.computerUseBar.pause" })}
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={TID_V4_COMPUTER_USE_BAR_PAUSE}
          onClick={session.resume}
          disabled={session.pending !== null}
          aria-label={intl.formatMessage({ id: "chat.computerUseBar.resume" })}
        >
          <MonitorPlayIcon className="size-3.5" aria-hidden />
          {intl.formatMessage({ id: "chat.computerUseBar.resume" })}
        </Button>
      )}
      {view.stopMeaningful ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={TID_V4_COMPUTER_USE_BAR_STOP}
          onClick={handleStop}
          disabled={stopping}
          aria-label={intl.formatMessage({ id: "chat.computerUseBar.stop" })}
        >
          {stopping ? (
            <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <SquareIcon className="size-3.5" aria-hidden />
          )}
          {intl.formatMessage({ id: "chat.computerUseBar.stop" })}
        </Button>
      ) : null}
    </div>
  );
}
