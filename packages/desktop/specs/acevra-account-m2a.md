# AceVra Account shell — M2A implementation spec

Status: implemented with this change. Parent design: `acevra-account.md` (accepted).
Scope: optional Clerk-backed AceVra Account + backend admission. No sync, devices,
transport, task routing, provider-secret handling or cloud execution (M2B+).

## Rules

- Local mode is the default and never depends on Clerk or the backend.
- Clerk authenticates a human; the AceVra backend admits them (private alpha).
  "Clerk signed in" is never "AceVra ready".
- Account state and provider state are independent: no provider identity is an
  account identity and logout never touches providers or local conversations.

## State owners and process boundaries

| State                                                    | Owner                                         | Notes                                                                 |
| -------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| Clerk human session                                      | Account window renderer (`acevra-account://`) | Official `@clerk/electron` bridge; memory-only token storage in alpha |
| Account projection (`AccountView`)                       | Main `AccountSessionController`               | Single writer; generation-guarded; broadcast to renderers             |
| Account-choice preference (`choice: undecided \| local`) | Main, `<userData>/acevra-account.json`        | Contains no tokens; absent file = undecided                           |
| Admission, Account row                                   | Backend (PostgreSQL)                          | Server-resolved; clients never supply an account id                   |
| Provider config, local conversations                     | Existing Host services                        | Untouched by account commands                                         |

The main `file://` renderer never holds a Clerk session or token. It sends
commands (`signIn`, `signOut`, `refresh`, `chooseLocal`) and renders `AccountView`.
Main obtains a fresh session token per request from a `TokenSource` port and calls
`GET /v1/me`. Clerk's secret key exists only in the backend.

Packaged `file://` cannot be a Clerk origin. A **dedicated Account window** loads
bundled assets from the custom scheme `acevra-account://renderer/` (served by
`protocol.handle`, traversal-safe). The main window origin is unchanged, so no
local renderer storage moves.

```mermaid
sequenceDiagram
  participant R as Main renderer (file://)
  participant M as Main AccountSessionController
  participant W as Account window (Clerk SDK)
  participant B as AceVra backend
  R->>M: signIn
  M->>W: open window; state=authenticating
  W-->>M: session ready (token requests answered on demand)
  M->>W: getToken (fresh)
  M->>B: GET /v1/me Bearer
  B->>B: verify Clerk token + admission ledger
  B-->>M: 200 profile | 403 denied | 401 | network error
  M-->>R: view: ready | denied | signedOut | offline
  R->>M: signOut
  M->>W: Clerk signOut; M clears projection (generation++)
```

## State model

`signedOut → authenticating → authenticated → admissionChecking → ready | denied | offline`.
`notConfigured` is a view flag (no publishable key / API base URL in this build), not
a state: local mode only. Every async result carries the attempt generation;
`signOut` and new sign-in bump it so late results are dropped. `offline` keeps the
last profile only as a stale display hint and never authorizes anything.

## Backend (`packages/account-api`)

Hono + `@clerk/backend` + PostgreSQL. Endpoints: `GET /healthz`, `GET /v1/me`.
`/v1/me`: verify bearer (session token, exact authorized parties, header only) →
resolve admission → upsert Account → safe profile. 401 unauthenticated, 403
`not_admitted` (non-disclosing, no profile), 5xx unavailable.

Schema: `accounts(id, clerk_user_id unique, display_name, avatar_url, created_at,
updated_at)`, `admissions(id, clerk_user_id null unique, email null unique,
status pending|approved|revoked, approved_at, revoked_at, created_at)`.
Admission is operator-owned (`pnpm --filter @zcode/account-api admission ...` and
optional `ACEVRA_ADMISSION_SEED_EMAILS`/`_CLERK_USER_IDS` seeded at start). An
email approval binds to a Clerk user only through that user's **verified** email
read from Clerk's backend API — never from client claims. Revoke wins over approve.
No personal identifiers live in source.

## Acceptance (deterministic unless stated)

- A. fresh profile → Continue locally → shell + local provider fixture inference, no Clerk.
- B. fresh profile → deterministic test token → admitted → profile visible → shell.
- C. authenticated but not admitted → denial copy; local mode still usable.
- Existing profile keeps conversations/provider setup; sign-in attaches identity only.
- Logout preserves provider config and conversations; backend offline never blocks startup.
- Backend: verified-JWT allow/deny/revoked/invalid-token/wrong-party; admission binding.
- Test token path exists only for non-packaged builds with an explicit env switch.

## Known limits

- Clerk beta SDK (`@clerk/electron` 0.0.49). Live Google/email sign-in needs the Clerk
  instance to allow origin `acevra-account://renderer`, Google credentials, and
  interactive login — see the M2A report for what was and was not live-verified.
- Memory-only token storage: users sign in again after relaunch (unsigned alpha).
- Phone and passkeys are not implemented.
