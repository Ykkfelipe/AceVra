/**
 * Accounts & Imports — the sanitized wire contract.
 *
 * SECURITY BOUNDARY. These are the ONLY account shapes that may cross the relay to a
 * browser. Nothing here can carry credential material: no field holds an OAuth access or
 * refresh token, no field holds the contents of `~/.codex/auth.json`, and no field holds a
 * Claude credential. The host adapters are the only components that speak to the local
 * source applications, and they must map into these types before returning.
 *
 * When extending this file, do not add a field whose value originates from a token, a
 * keychain entry, or a credentials file.
 */

/** Which local source application an account bridge talks to. */
export type AccountBridgeSource = "codex" | "claude-code";

/** Harness-side link state. Deliberately distinct from the source app's own login state. */
export type AccountBridgeConnectionState =
  | "not-installed"
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

/** Sanitized identity, derived from the source app's own status API. */
export interface AccountBridgeIdentity {
  /** Account email when the source app reports one. Display-only. */
  readonly email?: string;
  /** Plan identifier as reported by the source app (e.g. Codex `planType`). */
  readonly planType?: string;
  /** Auth method label, e.g. Claude's `authMethod`. Never a token. */
  readonly authMethod?: string;
  /** API provider label, e.g. Claude's `apiProvider`. */
  readonly apiProvider?: string;
}

/** Usage / rate-limit snapshot, only when the source app's supported API supplies it. */
export interface AccountBridgeUsage {
  readonly ordinaryUsageAllowed?: boolean;
  readonly primaryUsedPercent?: number;
  readonly primaryResetsAt?: string;
  readonly secondaryUsedPercent?: number;
  readonly secondaryResetsAt?: string;
}

/** Everything Settings is allowed to render for one source. */
export interface AccountBridgeStatus {
  readonly source: AccountBridgeSource;
  /** Whether the local client was found on this host. */
  readonly installed: boolean;
  /** Version string reported by the local client, when it could be determined. */
  readonly version?: string;
  /** Harness-side bridge state. */
  readonly state: AccountBridgeConnectionState;
  /**
   * Whether the SOURCE application itself reports a signed-in account. Independent of
   * `state`: the user can be signed into Codex while the harness bridge is disconnected.
   */
  readonly sourceSignedIn: boolean;
  readonly identity?: AccountBridgeIdentity;
  readonly usage?: AccountBridgeUsage;
  /** Human-readable failure reason. Must never include command output containing secrets. */
  readonly error?: string;
  /** ISO timestamp of when this snapshot was taken. */
  readonly checkedAt: string;
}

/**
 * Result of an explicit connect action.
 *
 * Note what is absent: the Codex `authUrl` is NOT part of this type. The OAuth URL is
 * opened by the Mac host, because Codex's callback targets localhost on that machine. The
 * URL must never be sent to a remote browser, and `loginId` is an opaque correlation handle
 * that carries no credential.
 */
export interface AccountBridgeConnectResult {
  readonly source: AccountBridgeSource;
  readonly started: boolean;
  /** Opaque correlation id for an in-flight login, when the source app supplies one. */
  readonly loginId?: string;
  /** True once the source app reported completion. */
  readonly completed?: boolean;
  readonly error?: string;
  /** Status snapshot after the attempt. */
  readonly status: AccountBridgeStatus;
}
