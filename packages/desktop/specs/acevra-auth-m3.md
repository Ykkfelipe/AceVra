# AceVra Auth — M3: Human Session Visibility & Revocation

Status: implemented behavior spec. Date: 2026-10-03.
Baseline: `feature/auth-first-run` at `0412f89` (M2), which builds on
`origin/release/0.1.0-alpha` `c02e24c2`.

Scope: let an authenticated user see which human login sessions belong to their
account, identify the current one, and end another one. The device/admission
boundary is unchanged and a Clerk session is **not** an AceVra device.

Out of scope: Personal Bot, Multitask, Cross-Mode, memory, model credentials,
profile ownership, and push-based revocation (recorded separately as M3a in §9).

## 1. What session infrastructure already existed

Verified at `0412f89`:

| Existing asset                                   | Where                                | Consequence for M3                                       |
| ------------------------------------------------ | ------------------------------------ | -------------------------------------------------------- |
| `sid` claim parsed off the verified JWT          | `ports.ts:5`, `clerk.ts:21`          | Available, but **discarded** at `app.ts:81`              |
| Server-side Clerk client                         | `clerk.ts:33`                        | Already constructed; only used for `users.getUser`       |
| `ClerkUserDirectory` port pattern                | `ports.ts:20`                        | Template for a sibling session port                      |
| `authenticate()` chokepoint                      | `app.ts:70-90`                       | Where ownership is established for every route           |
| Generic account HTTP transport                   | `accountDevices.ts:40`               | Already reused by `accountTasks`                         |
| Live admission re-read, device registry, pairing | `app.ts`, `devices.ts`, `pairing.ts` | Untouched                                                |
| M2 authoritative 401 + re-auth fencing           | `accountSessionController.ts:127`    | Preserved by routing sessions through the same transport |
| Exact-table assertion                            | `me.test.ts:103`                     | Must stay green — see §3                                 |

## 2. Investigation: no new table is required

The installed `@clerk/backend@3.18.1` already exposes everything M3 needs
(`dist/api/endpoints/SessionApi.d.ts`):

- `sessions.getSessionList({ userId, status })` → `{ data: Session[], totalCount }`
- `sessions.getSession(sessionId)` → `Session`
- `sessions.revokeSession(sessionId)` → `Session`

And `Session` supplies real metadata — `id`, `userId`, `status`, `createdAt`,
`updatedAt`, `lastActiveAt`, `expireAt`, `abandonAt`, `clientId`, and an optional
`latestActivity` with `deviceType`, `browserName`, `browserVersion`, `country`,
`city`, `isMobile`, `ipAddress`.

**Therefore M3 adds no database table and no migration.** Clerk already owns
human-session lifecycle — it issued the JWT being verified — so mirroring it in
Postgres would duplicate authoritative state that can drift, and would force a
deliberate edit of `me.test.ts`'s exact-table assertion for no added guarantee.

## 3. Architecture: a Clerk-backed `HumanSessionDirectory` port

`packages/account-api/src/ports.ts`:

```ts
export interface HumanSessionRecord {
  id: string;
  status: SessionStatus;
  createdAt: number;
  lastActiveAt: number;
  deviceType: string | null;
  browserName: string | null;
  country: string | null;
}

export interface HumanSessionDirectory {
  /** Sessions belonging to this Clerk user only. Never accepts a caller-supplied user. */
  listActiveSessions(clerkUserId: string): Promise<HumanSessionResult>;
  /**
   * Revokes a session **only if it belongs to `clerkUserId`**. Resolves
   * `not_found` for a session that is not theirs, so a caller cannot probe for or act
   * on another account's sessions. A Clerk failure *after* ownership is proven
   * propagates instead, so the route can answer 503: "we could not end it" must not
   * read as "it is already gone".
   */
  revokeSession(
    clerkUserId: string,
    sessionId: string,
  ): Promise<{ ok: true } | { ok: false; reason: "not_found" }>;
}
```

`createClerkSessionDirectory(secretKey)` in `clerk.ts` implements it over the
existing client. **Clerk types never cross the port** — the app sees only the
record shape, so Clerk's API can change without touching routes or tests, and
`clerk.ts` stays the single place that knows Clerk exists.

**The ownership fence is the load-bearing part.** `revokeSession(sessionId)` takes
only an id, so an authenticated user who guessed or learned another user's session
id could revoke it. The adapter therefore resolves the session first and compares
`session.userId` against the authenticated `clerkUserId`, returning `not_found` on
mismatch — mirroring the non-disclosing 404 the device registry already uses for
another account's device.

## 4. API

`GET /v1/sessions` and `POST /v1/sessions/:id/revoke`, both behind `authenticate()`,
registered only when a session directory is supplied (the same optional-dependency
pattern as `devices`/`pairings`).

```ts
export interface SessionsResponse {
  sessions: Array<{
    id: string;
    status: string;
    createdAt: number;
    lastActiveAt: number;
    deviceType: string | null;
    browserName: string | null;
    country: string | null;
    /** True only for the session the request itself authenticated with. */
    current: boolean;
  }>;
}
```

- `current` is computed **server-side** by comparing `identity.sessionId`, which
  only the backend can read. The client never decides which session it is.
- A request whose JWT carries no `sid` returns `current: false` everywhere rather
  than guessing.
- Revoke returns `{ ok: true }` or a non-disclosing `404 not_found`.
- Revoke gets a tighter rate limit than the global 60/min, following the pairing
  precedent, because it is a destructive authenticated write. It is keyed **per
  account and applied after authentication**: keying on a client address before auth
  would let an unauthenticated caller spend a shared bucket and lock the control for
  everyone on the instance.
- The `:id` path parameter is shape-validated before use, so a hostile id cannot be
  interpolated into an outbound Clerk URL. Relying on the Clerk SDK to reject a
  traversal would make the boundary depend on a dependency's internals.
- A list is capped at 100 and reports `partial` when Clerk holds more, so a truncated
  security review never presents itself as complete.

## 5. Shared contract

`packages/shared/src/account.ts`: `AccountSession`, `AccountSessionsView`,
`AccountSessionRevokeResult`, `listSessions()` / `revokeSession()` on
`IAccountPlatform`, and two IPC channels.

`packages/shared/src/accountSessions.ts`: the presentation helpers — which session
is current, how to describe a session, and how to classify a revoke result. Pure
functions, so they are unit-tested without a DOM.

## 6. UI

A new `AceVraSessionsSection`, rendered in the account settings section only when
the account is `ready`, above the computers section and clearly titled as **login
sessions** — never "devices". Computers stay a separate section below.

States: loading, empty ("no other sessions"), unavailable (backend or Clerk
unreachable), per-row revoke failure, and a revoked confirmation.

The current session is labelled and offers **no revoke control**: Sign out in this
window is already the authoritative path (§7).

## 7. Current-session vs remote-session revocation

Existing sign-out is authoritative and stays the only way to end _this_ session.
It calls Clerk's `signOut()` and destroys the Account window, which also clears
the locally cached token — something a server-side revoke cannot do.

So the two paths are deliberately different and the difference is explicit:

|           | Current session                                                                   | Another session                        |
| --------- | --------------------------------------------------------------------------------- | -------------------------------------- |
| UI action | **Sign out** (existing control)                                                   | **Revoke** on the row                  |
| Effect    | Clerk session ended locally _and_ remotely, token cache cleared, window destroyed | Server-side revoke of that one session |
| Path      | `accountWindowTokenSource.signOut`                                                | `POST /v1/sessions/:id/revoke`         |

The API does not refuse a revoke of the caller's own session — that request is
honest, and the consequence is that the caller's next request 401s, which M2's
existing re-auth path already handles by re-running `/v1/me` and falling back to
sign-in. Inventing a second local sign-out path to avoid that would be the
competing-path mistake.

## 8. Guarantees

1. A Clerk session is not a device. No session id is ever accepted by a device
   route, and no device id is accepted by a session route.
2. Session records are scoped strictly to the authenticated user, server-side.
3. `current` is derived from the verified JWT, never from client input.
4. Another account's session id yields a non-disclosing `not_found` on revoke and
   is never listed.
5. No `ipAddress` is exposed. Clerk records it; AceVra does not need it and does
   not pass personal data to the client unasked. `clientId` and `actor` are also
   withheld — neither is needed to identify a session to its owner.
6. No metadata is invented. Every field is either a Clerk `Session` field or
   `null`. `latestActivity` is optional in Clerk's model, so its fields may be
   absent rather than defaulted.
7. M2's 401 handling is preserved: the session client reuses the shared transport,
   so a rejected session still routes through `onUnauthorized` → authoritative
   `/v1/me` re-check.
8. Device registry, pairing, admission and task semantics are untouched; the exact
   table set is unchanged.

## 9. M3a — push-based revocation (not started)

After M3, a session revoked elsewhere stays usable until its JWT expires, because
the API verifies the token cryptographically and `/v1/me` is only re-checked on a
Clerk event or an explicit refresh. Two options, recorded not implemented:

- **Clerk webhooks** into account-api, marking revoked session ids in a table —
  this is the one case where persisting state would be justified, since a webhook
  cannot be delivered in-band to a connected client.
- **Periodic re-verification** of the last-seen session id.

Neither is inseparable from a correct M3: M3 is correct at token-TTL latency.

## 10. Acceptance cases

1. `GET /v1/sessions` lists only the authenticated user's active sessions.
2. The caller's own session is marked `current`; no other session is.
3. A JWT with no `sid` marks nothing current rather than defaulting.
4. Revoking an owned session succeeds; the session is gone from a later list.
5. Revoking another account's session id returns a non-disclosing 404 and does not
   revoke it.
6. Unauthenticated access to either route is 401.
7. Revoke is rate-limited more tightly than ordinary reads.
8. The UI labels the current session and offers no revoke control for it.
9. The UI shows loading, empty, unavailable and revoke-failure states.
10. No response contains `ipAddress`, `clientId` or `actor`.
11. `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed` pass;
    `packages/account-api` stays green including its exact-table assertion.
