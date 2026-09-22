import { verifyToken } from "@clerk/backend";
import type { Context } from "hono";

export interface CustomForkClerkIdentity {
  userId: string;
  sessionId?: string;
}

function readBearerToken(c: Context): string | undefined {
  const header = c.req.header("authorization")?.trim();
  return header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
}

function isLocalDevelopment(c: Context): boolean {
  const hostname = new URL(c.req.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function allowedUserIds(): Set<string> {
  return new Set(
    (process.env.ZCODE_FORK_ALLOWED_CLERK_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function isCustomForkClerkUserAllowed(userId: string): boolean {
  return allowedUserIds().has(userId);
}

export async function authenticateCustomForkClerk(
  c: Context,
): Promise<CustomForkClerkIdentity | null> {
  const token = readBearerToken(c) ?? new URL(c.req.url).searchParams.get("token")?.trim();
  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  if (token && secretKey) {
    try {
      const claims = await verifyToken(token, {
        secretKey,
        authorizedParties: (process.env.ZCODE_FORK_CLERK_AUTHORIZED_PARTIES ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      });
      if (claims.sub) {
        return {
          userId: claims.sub,
          ...(typeof claims.sid === "string" ? { sessionId: claims.sid } : {}),
        };
      }
    } catch {
      return null;
    }
  }

  if (process.env.ZCODE_FORK_ALLOW_UNAUTHENTICATED === "1" && isLocalDevelopment(c)) {
    return { userId: "local-development" };
  }
  return null;
}

export function isCustomForkLocalBypass(c: Context): boolean {
  return process.env.ZCODE_FORK_ALLOW_UNAUTHENTICATED === "1" && isLocalDevelopment(c);
}
