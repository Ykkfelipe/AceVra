import {
  parseAccountSessions,
  type AccountSessionRevokeResult,
  type AccountSessionsView,
} from "@zcode/shared";

type Call = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; json: Record<string, any> | null } | null>;

const UNAVAILABLE: AccountSessionsView = { sessions: [], unavailable: true };

/**
 * Main-side client for human login sessions.
 *
 * A session is a login, not a device: this shares the account HTTP transport with the
 * device registry purely to reuse its bearer handling, and deliberately holds no
 * session state of its own — Clerk is the authority for what a session is.
 *
 * Reusing `call()` also keeps M2's behaviour intact for free: a 401 from a session
 * route reaches `onUnauthorized` exactly as a 401 from a device route does, so the
 * authoritative re-auth path is unchanged.
 */
export function createAccountSessions(call: Call | null) {
  return {
    async list(): Promise<AccountSessionsView> {
      // Only a 200 with a valid body is a list. Transport failure, a rejected session
      // and an unreadable body are all "we could not check", never the reassuring
      // "you have no other sessions" — and never a fabricated empty one.
      if (!call) return UNAVAILABLE;
      const result = await call("GET", "/v1/sessions");
      if (result?.status !== 200) return UNAVAILABLE;
      return parseAccountSessions(result.json) ?? UNAVAILABLE;
    },

    async revoke(sessionId: string): Promise<AccountSessionRevokeResult> {
      if (!call) return { status: "unavailable" };
      const result = await call("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/revoke`);
      if (result?.status === 200) return { status: "revoked" };
      // The backend does not distinguish "no such session" from "not yours", so the
      // UI must not either.
      if (result?.status === 404) return { status: "not_found" };
      return { status: "unavailable" };
    },
  };
}

export type AccountSessions = ReturnType<typeof createAccountSessions>;
