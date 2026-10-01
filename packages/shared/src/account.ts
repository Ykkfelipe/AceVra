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

/** Desktop-only account commands. Optional on IPlatformService (Web has none). */
export interface IAccountPlatform {
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
  /** Registered devices for the signed-in account (empty unless ready). */
  listDevices(): Promise<AccountDevicesView>;
  renameDevice(id: string, displayName: string): Promise<AccountDevicesView>;
  revokeDevice(id: string): Promise<AccountDevicesView>;
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
  DeviceRename: "acevra-account:device-rename",
  DeviceRevoke: "acevra-account:device-revoke",
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
