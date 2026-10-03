import { createClerkClient, verifyToken, type Session } from "@clerk/backend";
import type {
  ClerkUserDirectory,
  HumanIdentityVerifier,
  HumanSessionDirectory,
  HumanSessionRecord,
  SessionLiveness,
} from "./ports.js";

/** A session list is for the user's own security review; a hard ceiling keeps it bounded. */
const MAX_SESSIONS = 100;

export function createClerkIdentityVerifier(options: {
  secretKey: string;
  authorizedParties: string[];
  jwtKey?: string;
}): HumanIdentityVerifier {
  return {
    async verify(bearerToken) {
      try {
        const claims = await verifyToken(bearerToken, {
          secretKey: options.secretKey,
          jwtKey: options.jwtKey,
          ...(options.authorizedParties.length
            ? { authorizedParties: options.authorizedParties }
            : {}),
        });
        if (!claims.sub) return null;
        return {
          clerkUserId: claims.sub,
          ...(typeof claims.sid === "string" ? { sessionId: claims.sid } : {}),
          ...(typeof claims.exp === "number" ? { expiresAt: claims.exp * 1000 } : {}),
        };
      } catch {
        // Expired, forged, wrong key or wrong party all collapse to "unauthenticated".
        return null;
      }
    },
  };
}

export function createClerkUserDirectory(secretKey: string): ClerkUserDirectory {
  const client = createClerkClient({ secretKey });
  return {
    async getUser(clerkUserId) {
      const user = await client.users.getUser(clerkUserId);
      const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
      return {
        displayName: name || user.username || null,
        avatarUrl: user.imageUrl || null,
        verifiedEmails: user.emailAddresses
          .filter((email) => email.verification?.status === "verified")
          .map((email) => email.emailAddress.toLowerCase()),
      };
    },
  };
}

/**
 * Human sessions, as a boundary rather than a mirror.
 *
 * Clerk owns this state — it issued the tokens the control plane verifies — so there
 * is deliberately no database table here. Persisting it would duplicate an authority
 * that can drift, and a webhook-driven revocation table (M3a) is the only case that
 * would justify persistence.
 */
export function createClerkSessionDirectory(secretKey: string): HumanSessionDirectory {
  const client = createClerkClient({ secretKey });
  return createSessionDirectory({
    list: (params) => client.sessions.getSessionList(params),
    get: (id) => client.sessions.getSession(id),
    revoke: (id) => client.sessions.revokeSession(id),
    status: async (id) => {
      const session = await client.sessions.getSession(id);
      return { userId: session.userId, status: session.status };
    },
  });
}

/**
 * The two Clerk calls this needs, narrowed so the ownership fence can be tested
 * without a network or a Clerk instance. `clerk.ts` stays the only module that
 * knows these exist.
 */
export interface ClerkSessionCalls {
  list(params: { userId: string; status: "active"; limit: number }): Promise<{
    data: Session[];
    /** Clerk's total for the query, which may exceed the page we asked for. */
    totalCount?: number;
  }>;
  get(sessionId: string): Promise<{ userId: string }>;
  revoke(sessionId: string): Promise<unknown>;
  /** Present only when the adapter can answer; absent means "cannot tell". */
  status?(sessionId: string): Promise<{ userId: string; status: string }>;
}

export function createSessionDirectory(sessions: ClerkSessionCalls): HumanSessionDirectory {
  const toRecord = (session: Session): HumanSessionRecord => {
    const activity = session.latestActivity;
    return {
      id: session.id,
      // Only active sessions reach here (see the filter below), so this is a fact
      // rather than a restatement of whatever Clerk happened to report.
      status: "active",
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      deviceType: activity?.deviceType ?? null,
      browserName: activity?.browserName ?? null,
      country: activity?.country ?? null,
    };
  };

  return {
    async listActiveSessions(clerkUserId) {
      const page = await sessions.list({
        userId: clerkUserId,
        status: "active",
        limit: MAX_SESSIONS,
      });
      // Filter again on our side rather than trusting the query alone: this list is a
      // security review surface, so an ended, expired or revoked session must never be
      // presented as something the user could act on.
      const records = page.data.filter((s) => s.status === "active").map(toRecord);
      return {
        sessions: records,
        partial: (page.totalCount ?? records.length) > records.length,
      };
    },

    async revokeSession(clerkUserId, sessionId) {
      // Ownership first. `client.sessions.revokeSession` takes a bare id with no user
      // scope, so without this check any authenticated user could end another account's
      // session by id — and a 404 here also keeps us from confirming that the id exists.
      let ownerId: string;
      try {
        ownerId = (await sessions.get(sessionId)).userId;
      } catch {
        return { ok: false, reason: "not_found" };
      }
      if (ownerId !== clerkUserId) return { ok: false, reason: "not_found" };
      await sessions.revoke(sessionId);
      return { ok: true };
    },

    async sessionStatus(clerkUserId, sessionId) {
      // Without a status call the freshness check cannot be answered; say so rather
      // than guessing, so an outage is never read as a revocation.
      if (!sessions.status) return "unavailable";
      try {
        const session = await sessions.status(sessionId);
        // Ownership first: another user's session is not this session, whatever its
        // status says.
        if (session.userId !== clerkUserId) return "not_active";
        return session.status === "active" ? "active" : "not_active";
      } catch (error) {
        return classifyLivenessFailure(error);
      }
    },
  };
}

/**
 * Distinguishes "this session is gone" from "Clerk could not be reached".
 *
 * Only a definitive not-found or unauthorized answer counts as a revocation. A 429, a
 * 5xx, or a network failure is an outage: treating those as revocations would let a
 * Clerk hiccup sign every user out at once.
 */
function classifyLivenessFailure(error: unknown): SessionLiveness {
  const status = (error as { status?: unknown })?.status;
  if (status === 404 || status === 401) return "not_active";
  return "unavailable";
}
