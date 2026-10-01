/**
 * AceVra Account contract (M2A). Account state is independent of provider state:
 * nothing here references a model provider, credential or local conversation.
 */

/** `authenticated` = a Clerk session exists but AceVra admission is not yet confirmed. */
export type AccountPhase =
  | "signedOut"
  | "authenticating"
  | "authenticated"
  | "admissionChecking"
  | "ready"
  | "denied"
  | "offline";

export type AccountDetail = "not_admitted" | "unreachable" | "session_rejected" | "failed";

export interface AccountProfile {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface AccountView {
  /** False when this build has no Clerk key/API URL: local mode only, sign-in disabled. */
  configured: boolean;
  /** Local profile preference; never account authority. */
  choice: "undecided" | "local";
  phase: AccountPhase;
  /** Present in `ready`; kept as a clearly stale hint in `offline`. Never authorizes. */
  profile?: AccountProfile;
  detail?: AccountDetail;
  /** Present and false when the session won't be remembered after quitting. */
  rememberSession?: false;
}

export const SIGNED_OUT_VIEW: AccountView = {
  configured: false,
  choice: "undecided",
  phase: "signedOut",
};

export type AccountDeviceCapability =
  | "computerUse"
  | "shell"
  | "files"
  | "git"
  | "longTasks"
  | "minecraft";

/** Descriptive device facts only; never a credential, installation id or owner id. */
export interface AccountDevice {
  id: string;
  type: "desktop" | "node";
  platform: "darwin" | "win32" | "linux";
  displayName: string;
  capabilities: AccountDeviceCapability[];
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  presence: "online" | "offline" | "revoked";
}

export interface AccountDevicesView {
  /** How THIS installation relates to the account's device registry. */
  registration: "none" | "registered" | "conflict" | "revoked" | "unavailable";
  thisDeviceId: string | null;
  devices: AccountDevice[];
}

/** What the human sees when they enter a node's pairing code. Never includes keys or secrets. */
export interface AccountPairingPreview {
  id: string;
  displayName: string;
  platform: "darwin" | "win32" | "linux";
  capabilities: AccountDeviceCapability[];
  createdAt: string;
  expiresAt: string;
}
export type AccountPairingLookupResult =
  | { status: "found"; pairing: AccountPairingPreview }
  | { status: "not_found" | "too_many_attempts" | "unavailable" };
export type AccountPairingDecisionResult = {
  status: "approved" | "rejected" | "unavailable" | "not_pending";
};

/**
 * Where a task can run. Derived from Devices (plus this desktop's local runner); routing never
 * hardcodes machine names. Cloud is intentionally absent until it can actually run something.
 */
export interface ExecutionTarget {
  id: string;
  type: "desktop" | "node";
  displayName: string;
  online: boolean;
  capabilities: AccountDeviceCapability[];
  isThisDevice: boolean;
  /** Can a process task be started on it right now? */
  available: boolean;
  unavailableReason?: "offline" | "no_shell_service" | "remote_desktop_unsupported";
}

export type TaskState =
  | "queued"
  | "dispatching"
  | "running"
  | "running_unknown"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

/** Same shape for local, node (and later cloud) execution. */
export interface TaskView {
  id: string;
  targetId: string;
  state: TaskState;
  process: { executable: string; args: string[]; cwd: string; timeoutMs: number };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: Record<string, unknown> | null;
  lastSequence: number;
}
export interface TaskEvent {
  sequence: number;
  type: string;
  ts: string;
  payload: Record<string, unknown>;
}
export interface ProcessRequest {
  executable: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}
export type StartProcessResult =
  | { ok: true; taskId: string; targetId: string }
  | {
      ok: false;
      reason:
        | "invalid_request"
        | "target_unavailable"
        | "target_not_found"
        | "unavailable"
        | "not_signed_in";
    };

/**
 * The sanctioned way for the main agent (or UI) to run a process on an execution target.
 * It returns a task handle immediately and never blocks on the process: progress is read
 * separately from TaskEvents.
 */
export interface IRemoteProcessService {
  listTargets(): Promise<ExecutionTarget[]>;
  startRemoteProcess(input: {
    targetId: string;
    process: ProcessRequest;
    idempotencyKey?: string;
  }): Promise<StartProcessResult>;
  listTasks(): Promise<TaskView[]>;
  getTaskEvents(taskId: string, after: number): Promise<TaskEvent[]>;
  cancelTask(taskId: string, force?: boolean): Promise<TaskView | null>;
}

/** Desktop-only account commands. Optional on IPlatformService (Web has none). */
export interface IAccountPlatform extends IRemoteProcessService {
  getView(): Promise<AccountView>;
  onViewChanged(callback: (view: AccountView) => void): () => void;
  /** Opens the Clerk sign-in surface. Resolves when started, not when authenticated. */
  signIn(): Promise<void>;
  /** Ends the Clerk human session and clears the projection. Local data is untouched. */
  signOut(): Promise<void>;
  /** Re-checks admission for an existing session (explicit retry after offline). */
  refresh(): Promise<void>;
  /** Records "Continue locally". */
  chooseLocal(): Promise<void>;
  /** Look up a node's pending pairing by its short code (the only discovery path). */
  lookupPairing(code: string): Promise<AccountPairingLookupResult>;
  decidePairing(id: string, decision: "approve" | "reject"): Promise<AccountPairingDecisionResult>;
  /** Registered devices for the signed-in account (empty unless ready). */
  listDevices(): Promise<AccountDevicesView>;
  renameDevice(id: string, displayName: string): Promise<AccountDevicesView>;
  revokeDevice(id: string): Promise<AccountDevicesView>;
  /** Engineering-only raw process runner UI; never true in packaged builds. */
  engineeringTools(): Promise<boolean>;
}

/** Runtime validation of the backend `/v1/me` body; anything else is a failure. */
export function parseAccountProfile(body: unknown): AccountProfile | null {
  if (typeof body !== "object" || body === null) return null;
  const { account, admission } = body as {
    account?: Record<string, unknown>;
    admission?: Record<string, unknown>;
  };
  if (admission?.status !== "approved" || typeof account?.id !== "string" || !account.id) {
    return null;
  }
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    id: account.id,
    displayName: text(account.displayName),
    avatarUrl: text(account.avatarUrl),
  };
}

/** Electron IPC channels for the account feature (Desktop main ↔ renderers). */
export const AccountChannels = {
  /** main renderer → main */
  GetView: "acevra-account:get-view",
  SignIn: "acevra-account:sign-in",
  SignOut: "acevra-account:sign-out",
  Refresh: "acevra-account:refresh",
  ChooseLocal: "acevra-account:choose-local",
  DevicesList: "acevra-account:devices-list",
  TargetsList: "acevra-account:targets-list",
  TaskStart: "acevra-account:task-start",
  TasksList: "acevra-account:tasks-list",
  TaskEvents: "acevra-account:task-events",
  TaskCancel: "acevra-account:task-cancel",
  PairingLookup: "acevra-account:pairing-lookup",
  PairingDecide: "acevra-account:pairing-decide",
  DeviceRename: "acevra-account:device-rename",
  DeviceRevoke: "acevra-account:device-revoke",
  EngineeringTools: "acevra-account:engineering-tools",
  /** main → main renderer */
  ViewChanged: "acevra-account:view-changed",
  /** account window → main */
  WindowGetConfig: "acevra-account:window-get-config",
  WindowSession: "acevra-account:window-session",
  WindowReply: "acevra-account:window-reply",
  /** main → account window */
  WindowRequest: "acevra-account:window-request",
} as const;

export const ACCOUNT_RENDERER_SCHEME = "acevra-account";
export const ACCOUNT_RENDERER_HOST = "renderer";
export const ACCOUNT_RENDERER_ORIGIN = `${ACCOUNT_RENDERER_SCHEME}://${ACCOUNT_RENDERER_HOST}`;
