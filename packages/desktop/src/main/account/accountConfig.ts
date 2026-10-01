export interface AccountConfig {
  /** Public Clerk identifier; safe for the Account window. Never a secret. Null = no Clerk. */
  publishableKey: string | null;
  apiBaseUrl: string;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Account configuration comes from ACEVRA_* environment variables only. A missing or
 * invalid value yields null: the build runs local-only rather than failing startup.
 * Plain http is accepted for loopback in unpackaged builds; packaged builds need https.
 */
export function resolveAccountConfig(
  env: NodeJS.ProcessEnv,
  options: { isPackaged: boolean },
): AccountConfig | null {
  const publishableKey = env.ACEVRA_CLERK_PUBLISHABLE_KEY?.trim();
  const rawBase = env.ACEVRA_API_BASE_URL?.trim();
  if (!rawBase) return null;
  let base: URL;
  try {
    base = new URL(rawBase);
  } catch {
    return null;
  }
  const secure = base.protocol === "https:";
  const devLoopback =
    !options.isPackaged && base.protocol === "http:" && LOOPBACK.has(base.hostname);
  if (!secure && !devLoopback) return null;
  return { publishableKey: publishableKey || null, apiBaseUrl: base.origin };
}

/** Clerk Frontend API host encoded in a publishable key (`pk_<env>_<base64(host$)>`). */
export function clerkFrontendHost(publishableKey: string): string | null {
  const encoded = publishableKey.split("_").slice(2).join("_");
  try {
    const host = Buffer.from(encoded, "base64").toString("utf8").replace(/\$$/, "");
    return /^[a-z0-9.-]+$/i.test(host) ? host : null;
  } catch {
    return null;
  }
}
