export interface AccountApiConfig {
  clerkSecretKey: string;
  /** Exact renderer origins allowed as the token `azp`; empty = not enforced. */
  authorizedParties: string[];
  /** Networkless verification key (PEM). Optional; JWKS is used otherwise. */
  clerkJwtKey?: string;
  databaseUrl: string;
  port: number;
  seedEmails: string[];
  seedClerkUserIds: string[];
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
    seedEmails: list(env.ACEVRA_ADMISSION_SEED_EMAILS),
    seedClerkUserIds: list(env.ACEVRA_ADMISSION_SEED_CLERK_USER_IDS),
  };
}
