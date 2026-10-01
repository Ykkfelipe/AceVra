import type { ComputerView } from "@zcode/shared";

/**
 * Presentation-only derivation for the Computer tab (acevra-agent-computer.md §3.3). Every fact
 * comes from Main's ComputerView, which mirrors the worker; nothing here is authoritative.
 */
export type ComputerStatusKind =
  | "connecting"
  | "offline"
  | "idle"
  | "working"
  | "inControl"
  | "physicalPause"
  | "paused";

export function computerStatusKind(view: ComputerView | null): ComputerStatusKind {
  if (!view || view.connection === "connecting") return "connecting";
  // `not_connected` 只表示隧道尚未建立（没有失败），不能显示成离线。
  if (view.connection === "offline") {
    return view.offlineReason === "not_connected" ? "connecting" : "offline";
  }
  switch (view.control) {
    case "agent":
      return "working";
    case "human":
      return "inControl";
    case "paused":
      return view.job?.yieldReason ? "physicalPause" : "paused";
    default:
      return "idle";
  }
}

export interface ComputerPaneActions {
  takeControl: boolean;
  giveBack: boolean;
  resume: boolean;
  stop: boolean;
}

export function computerPaneActions(view: ComputerView | null): ComputerPaneActions {
  const kind = computerStatusKind(view);
  const online = kind !== "connecting" && kind !== "offline";
  return {
    takeControl: online && kind !== "inControl",
    giveBack: kind === "inControl",
    resume: kind === "physicalPause" || kind === "paused",
    // 面板自己接管产生的 job 由「交还」结束；只有 agent 在用（或被暂停）时才显示 Stop。
    stop: online && view?.job != null && !view.panelOwnsJob,
  };
}

/**
 * The stream subscription exists only while the tab is the visible active tab. The subscription
 * itself retains the tunnel in Main (which reconnects with backoff), so offline does not unsubscribe.
 */
export function shouldStream(computerId: string | null, visible: boolean): boolean {
  return visible && computerId != null;
}
