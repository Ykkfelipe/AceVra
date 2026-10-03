/** Ports for the AceVra Account control plane (M2A). Adapters live beside them. */

export interface VerifiedHumanIdentity {
  clerkUserId: string;
  sessionId?: string;
}

/** Verifies a Clerk session token. Resolves null for any invalid token. */
export interface HumanIdentityVerifier {
  verify(bearerToken: string): Promise<VerifiedHumanIdentity | null>;
}

export interface ClerkUserProfile {
  displayName: string | null;
  avatarUrl: string | null;
  /** Only emails Clerk reports as verified. Client-supplied claims never appear here. */
  verifiedEmails: string[];
}

export interface ClerkUserDirectory {
  getUser(clerkUserId: string): Promise<ClerkUserProfile>;
}

/**
 * Clerk's own session status vocabulary. A human session is NOT an AceVra device:
 * this describes logins, while `devices` describes machines this account controls.
 */
export type HumanSessionStatus =
  | "active"
  | "pending"
  | "ended"
  | "abandoned"
  | "expired"
  | "removed"
  | "replaced"
  | "revoked";

/**
 * A login session belonging to one Clerk user. Every field is something Clerk
 * reports; nothing here is synthesised by AceVra. Activity fields are nullable
 * because Clerk only records them once a client reports activity.
 *
 * Deliberately excluded: the originating IP address, Clerk's internal client id and
 * the impersonation actor. None is needed to identify a session to its owner, and
 * the first is personal data AceVra has no reason to pass to the client.
 */
export interface HumanSessionRecord {
  id: string;
  status: HumanSessionStatus;
  /** Unix milliseconds, as Clerk reports them. */
  createdAt: number;
  lastActiveAt: number;
  deviceType: string | null;
  browserName: string | null;
  country: string | null;
}

/**
 * Human-session lifecycle. Clerk is the authority — it issued the tokens this
 * control plane verifies — so this is a thin boundary over it, not a second source
 * of truth. No database table mirrors this state.
 */
export interface HumanSessionDirectory {
  /** Active sessions belonging to this user. Never accepts a caller-supplied user. */
  listActiveSessions(clerkUserId: string): Promise<HumanSessionRecord[]>;
  /**
   * Revokes a session only if it belongs to `clerkUserId`, resolving `not_found`
   * otherwise. Clerk's own revoke takes a bare session id with no user scope, so
   * the ownership check has to happen here or any authenticated user could end
   * another's session by id.
   */
  revokeSession(
    clerkUserId: string,
    sessionId: string,
  ): Promise<{ ok: true } | { ok: false; reason: "not_found" }>;
}

export interface SqlResult<T> {
  rows: T[];
}
export interface SqlExecutor {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<SqlResult<T>>;
  /** Runs a multi-statement script (migrations only; no parameters). */
  exec(script: string): Promise<void>;
  /** Runs fn atomically; fn receives an executor bound to the transaction. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

export interface AccountRecord {
  id: string;
  clerkUserId: string;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

export type AdmissionDecision =
  | { admitted: true }
  | { admitted: false; reason: "not_approved" | "revoked" };
