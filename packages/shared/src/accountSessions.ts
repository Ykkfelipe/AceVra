import type { AccountSession, AccountSessionRevokeResult } from "./account.js";

/**
 * Presentation for human login sessions.
 *
 * Pure functions on purpose: the wording is localised in the UI, but "which session
 * is this", "how long ago" and "what did Clerk actually tell us" are facts, and they
 * are decided here where they can be tested without a DOM.
 */

export interface AccountSessionSplit {
  current: AccountSession | null;
  others: AccountSession[];
}

/**
 * Splits the list into the session this client is using and everything else.
 *
 * The current session is whatever the backend marked, so at most one can be current.
 * If none is marked — for example a token with no `sid` claim — nothing is promoted to
 * current: showing "This device" for a session we cannot prove is worse than showing
 * none.
 */
export function splitAccountSessions(sessions: readonly AccountSession[]): AccountSessionSplit {
  const current = sessions.find((session) => session.current) ?? null;
  return { current, others: sessions.filter((session) => !session.current) };
}

export type AccountSessionActivity =
  | { kind: "justNow" }
  | { kind: "minutes"; value: number }
  | { kind: "hours"; value: number }
  | { kind: "days"; value: number }
  | { kind: "unknown" };

/**
 * How long ago a session was last active, bucketed for localisation.
 *
 * Buckets rather than a formatted string so the UI owns the wording and the test owns
 * the arithmetic. A missing or nonsensical timestamp reads as `unknown` — it is never
 * rendered as "just now", which would claim an activity fact that was not reported.
 */
export function accountSessionActivity(
  session: Pick<AccountSession, "lastActiveAt">,
  now: number,
): AccountSessionActivity {
  const elapsed = now - session.lastActiveAt;
  // A future timestamp is a clock skew or a bad value, not activity.
  if (!Number.isFinite(elapsed) || elapsed < 0) return { kind: "unknown" };
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return { kind: "justNow" };
  if (minutes < 60) return { kind: "minutes", value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { kind: "hours", value: hours };
  return { kind: "days", value: Math.floor(hours / 24) };
}

/**
 * A short, honest description of where a session was last seen.
 *
 * Built only from what Clerk reported. When it reported nothing, this is `null` and
 * the UI omits it — an invented "Unknown device" or a guessed OS would be worse than
 * saying nothing about a session the user is being asked to judge.
 */
export function accountSessionDevice(session: Pick<AccountSession, "deviceType" | "browserName">) {
  const parts = [session.deviceType, session.browserName].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Maps a revoke outcome to what the UI should say.
 *
 * `not_found` deliberately carries no distinction between "no such session" and "not
 * yours" — the backend does not disclose which, and the UI must not imply it does.
 */
export function describeAccountSessionRevoke(
  result: AccountSessionRevokeResult,
  text: (id: string, fallback: string) => string,
): { ok: boolean; message: string } {
  switch (result.status) {
    case "revoked":
      return { ok: true, message: text("sessions.revoked", "Signed out.") };
    case "not_found":
      return {
        ok: false,
        message: text(
          "sessions.revokeNotFound",
          "That session is no longer listed. Nothing to do.",
        ),
      };
    default:
      return {
        ok: false,
        message: text(
          "sessions.revokeUnavailable",
          "Couldn't end that session. Check your connection and try again.",
        ),
      };
  }
}
