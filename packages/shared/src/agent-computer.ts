/**
 * SSH computers (packages/desktop/specs/acevra-agent-computer.md): a computer the user reaches
 * with their own SSH config, running the AceVra computer worker. Main owns tunnels, the worker
 * token (memory only) and the stream socket; the worker owns job / lease / pause / yield.
 * The renderer only presents what Main reports.
 */

/** Stored locally (userData). Never contains a credential. */
export interface SshComputerConfig {
  /** Stable local id; the execution target id is `ssh:<id>`. */
  id: string;
  /** User-given name ("Dell"). */
  name: string;
  /** Host alias from ~/.ssh/config (or user@host). */
  hostAlias: string;
  /** Worker port on the remote loopback (default 8765). */
  workerPort: number;
}

export const SSH_TARGET_PREFIX = "ssh:";
export const DEFAULT_WORKER_PORT = 8765;

export type ComputerConnection = "connecting" | "online" | "offline";

/** Worker job facts as reported by the worker (never derived on the Mac). */
export interface ComputerJobView {
  jobId: string;
  state: string;
  mode: string | null;
  controller: string | null;
  /** Set when physical input on the computer paused the agent. */
  yieldReason: string | null;
}

/** Who drives the computer right now (derived from the worker's job state). */
export type ComputerControl = "agent" | "human" | "paused" | "idle";

export interface ComputerView {
  computerId: string;
  name: string;
  connection: ComputerConnection;
  /** Short machine reason for offline (`ssh_failed`, `auth_failed`, `worker_unreachable`, …). */
  offlineReason: string | null;
  job: ComputerJobView | null;
  control: ComputerControl;
  /** True when the current job belongs to the panel's own take-control (no agent behind it). */
  panelOwnsJob: boolean;
  /** Last agent action name (`click`, `type`, …) for the i18n activity line. */
  lastAction: string | null;
  screen: { width: number; height: number } | null;
}

/** One JPEG frame from the worker's view socket. */
export interface ComputerFrame {
  computerId: string;
  seq: number;
  /** JPEG pixel size (may be downscaled). */
  width: number;
  height: number;
  /** Remote screen size: input coordinates are in this space. */
  screenWidth: number;
  screenHeight: number;
  cursorX: number;
  cursorY: number;
  jpeg: Uint8Array;
}

/** Human input sent from the Computer tab while in control (worker `/ws/view` `ev`). */
export type ComputerInputEvent =
  | { kind: "move"; x: number; y: number }
  | { kind: "down" | "up"; x: number; y: number; button: "left" | "right" | "middle" }
  | { kind: "dblclick"; x: number; y: number; button: "left" }
  | { kind: "scroll"; x: number; y: number; dy: number }
  | { kind: "keydown" | "keyup"; key: string }
  | { kind: "text"; text: string }
  | { kind: "release" };

export type ComputerTestResult =
  | { ok: true; screen: { width: number; height: number }; version: string | null }
  | { ok: false; reason: string };

export type ComputerCommandResult = { ok: true } | { ok: false; reason: string };

/** One raw keyboard event forwarded by Main while remote keyboard capture is active (spec §3.3). */
export interface CapturedKeyEvent {
  type: "keydown" | "keyup";
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isAutoRepeat: boolean;
}

/** Desktop-only. Optional on IPlatformService (Web has none). */
export interface IComputersPlatform {
  list(): Promise<SshComputerConfig[]>;
  /** Checks SSH + worker health without saving. */
  test(input: { hostAlias: string; workerPort: number }): Promise<ComputerTestResult>;
  add(input: Omit<SshComputerConfig, "id">): Promise<SshComputerConfig[]>;
  remove(id: string): Promise<SshComputerConfig[]>;
  getView(id: string): Promise<ComputerView | null>;
  onViewChanged(callback: (view: ComputerView) => void): () => void;
  /** Ref-counted in Main; the stream runs only while at least one subscription exists. */
  subscribeFrames(
    id: string,
    options: { interactive: boolean },
    callback: (frame: ComputerFrame) => void,
  ): () => void;
  takeControl(id: string): Promise<ComputerCommandResult>;
  giveBack(id: string): Promise<ComputerCommandResult>;
  resume(id: string): Promise<ComputerCommandResult>;
  stop(id: string): Promise<ComputerCommandResult>;
  sendInput(id: string, events: ComputerInputEvent[]): void;
  /**
   * Remote keyboard capture (spec §3.3 layer 1): while active, Main intercepts every key event on
   * this renderer's webContents via `before-input-event` (so Electron menu accelerators such as
   * Cmd+Q / Cmd+W cannot fire) and forwards them via `onCapturedKey`.
   */
  setKeyCapture(active: boolean): void;
  onCapturedKey(callback: (event: CapturedKeyEvent) => void): () => void;
  /** First agent Computer action of a conversation on this computer. */
  onSessionStarted(
    callback: (notice: { sessionId: string; computerId: string }) => void,
  ): () => void;
}

export const ComputerChannels = {
  List: "acevra-computers:list",
  Test: "acevra-computers:test",
  Add: "acevra-computers:add",
  Remove: "acevra-computers:remove",
  GetView: "acevra-computers:get-view",
  Subscribe: "acevra-computers:subscribe",
  Unsubscribe: "acevra-computers:unsubscribe",
  TakeControl: "acevra-computers:take-control",
  GiveBack: "acevra-computers:give-back",
  Resume: "acevra-computers:resume",
  Stop: "acevra-computers:stop",
  Input: "acevra-computers:input",
  /** renderer → main: enable/disable before-input-event keyboard interception while in control. */
  KeyCapture: "acevra-computers:key-capture",
  /** main → renderer: a key event intercepted in Main (menu accelerators suppressed). */
  CapturedKey: "acevra-computers:captured-key",
  /** main → renderer */
  ViewChanged: "acevra-computers:view-changed",
  Frame: "acevra-computers:frame",
  SessionStarted: "acevra-computers:session-started",
} as const;
