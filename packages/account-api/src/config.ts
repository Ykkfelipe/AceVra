export interface AccountApiConfig {
  clerkSecretKey: string;
  /** Exact renderer origins allowed as the token `azp`; empty = not enforced. */
  authorizedParties: string[];
  /** Networkless verification key (PEM). Optional; JWKS is used otherwise. */
  clerkJwtKey?: string;
  databaseUrl: string;
  port: number;
  host: string;
  /** Honour X-Forwarded-For for rate-limit keys (only behind a trusted proxy). */
  trustProxy: boolean;
  seedEmails: string[];
  seedClerkUserIds: string[];
  /**
   * How long a confirmed human-session status is trusted, in seconds. This is the
   * maximum revocation window M3a promises. 0 disables the check.
   */
  sessionFreshnessSeconds: number;
}

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/** Reads only ACEVRA_* variables. Throws with the missing names, never values. */
export function readAccountApiConfig(env: NodeJS.ProcessEnv = process.env): AccountApiConfig {
  const missing = ["ACEVRA_CLERK_SECRET_KEY", "ACEVRA_DATABASE_URL"].filter(
    (name) => !env[name]?.trim(),
  );
  if (missing.length) throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  return {
    clerkSecretKey: env.ACEVRA_CLERK_SECRET_KEY!.trim(),
    authorizedParties: list(env.ACEVRA_AUTHORIZED_PARTIES),
    clerkJwtKey: env.ACEVRA_CLERK_JWT_KEY?.trim() || undefined,
    databaseUrl: env.ACEVRA_DATABASE_URL!.trim(),
    port: Number(env.PORT ?? env.ACEVRA_API_PORT ?? 8787),
    host: env.ACEVRA_API_HOST?.trim() || "0.0.0.0",
    trustProxy: env.ACEVRA_TRUST_PROXY === "1",
    seedEmails: list(env.ACEVRA_ADMISSION_SEED_EMAILS),
    seedClerkUserIds: list(env.ACEVRA_ADMISSION_SEED_CLERK_USER_IDS),
    // 300s is the bound stated in the M3a spec: worst-case exposure is one TTL
    // after the last confirmation, regardless of the instance's token TTL.
    sessionFreshnessSeconds: parseFreshnessSeconds(env.ACEVRA_SESSION_FRESHNESS_SECONDS),
  };
}

/** An hour is far beyond any useful bound, and past it the check is off, not infinite. */
const MAX_FRESHNESS_SECONDS = 3_600;

/**
 * Parses the freshness TTL, falling back to the documented default rather than
 * accepting anything.
 *
 * `Number(...)` alone is how a typo silently disables the only revocation control: a
 * non-numeric or negative value becomes NaN, and NaN fails the `> 0` gate downstream
 * so the check turns off with nothing in the logs. An unparseable value is treated as
 * unset, and out-of-range values are clamped, so the worst outcome of a bad
 * configuration is the default rather than no protection.
 */
function parseFreshnessSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 300;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 300;
  return Math.min(value, MAX_FRESHNESS_SECONDS);
}
