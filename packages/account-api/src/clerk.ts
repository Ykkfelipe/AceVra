import { createClerkClient, verifyToken } from "@clerk/backend";
import type { ClerkUserDirectory, HumanIdentityVerifier } from "./ports.js";

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
