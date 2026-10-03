# @zcode/account-api — AceVra Account control plane (M2A)

Minimal backend for the optional AceVra Account: verifies a Clerk session token,
enforces private-alpha admission, and returns a safe profile. No sync, devices,
task routing or provider secrets (those are M2B+).

| Endpoint       | Auth         | Result                                                                   |
| -------------- | ------------ | ------------------------------------------------------------------------ |
| `GET /healthz` | none         | `{ ok: true }`                                                           |
| `GET /v1/me`   | Clerk bearer | 200 profile · 401 unauthenticated · 403 `not_admitted` · 503 unavailable |

## Configuration (environment only; nothing is committed)

| Variable                                                                | Purpose                                                                                         |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `ACEVRA_CLERK_SECRET_KEY` (required)                                    | Clerk backend secret. Backend only; never in the desktop app.                                   |
| `ACEVRA_DATABASE_URL` (required)                                        | PostgreSQL connection string.                                                                   |
| `ACEVRA_AUTHORIZED_PARTIES`                                             | Comma list of exact allowed token origins, e.g. `acevra-account://renderer`.                    |
| `ACEVRA_CLERK_JWT_KEY`                                                  | Optional PEM key for networkless verification.                                                  |
| `PORT` / `ACEVRA_API_PORT`                                              | Listen port (default 8787).                                                                     |
| `ACEVRA_ADMISSION_SEED_EMAILS` / `ACEVRA_ADMISSION_SEED_CLERK_USER_IDS` | Comma lists approved at startup.                                                                |
| `ACEVRA_SESSION_FRESHNESS_SECONDS`                                      | Revocation-freshness TTL (default 300). `0` disables it. Unparseable falls back to the default. |

## Private-alpha admission

```bash
pnpm --filter @zcode/account-api admission approve --email person@example.com
pnpm --filter @zcode/account-api admission approve --clerk-user-id user_...
pnpm --filter @zcode/account-api admission revoke  --email person@example.com
pnpm --filter @zcode/account-api admission unrevoke --clerk-user-id user_...
```

An email approval binds to a Clerk user only through that user's **verified** email as
reported by Clerk's backend API. Revoke wins over approve; revocation applies on the very
next request. Also configure the Clerk instance as invite-only so strangers cannot sign up.

## Desktop client configuration

The desktop app reads (main process only): `ACEVRA_API_BASE_URL` (https, or loopback http
in unpackaged builds) and `ACEVRA_CLERK_PUBLISHABLE_KEY` (public identifier). Without them
the account feature is hidden and AceVra runs local-only. The Clerk instance must allow the
origin `acevra-account://renderer`.

## Development

```bash
pnpm --filter @zcode/account-api start     # needs the env above
pnpm --filter @zcode/account-api test      # PGlite (real Postgres engine) + real Clerk JWT verification
```
