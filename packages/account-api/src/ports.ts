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
