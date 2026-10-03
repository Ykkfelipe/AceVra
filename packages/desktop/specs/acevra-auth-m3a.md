# AceVra Auth — M3a: Revocation Freshness

Status: implemented behavior spec. Date: 2026-10-03.
Baseline: `feature/auth-first-run` at `8b646c9` (M3), which builds on
`origin/release/0.1.0-alpha` `c02e24c2`.

Scope: bound how long a remotely revoked human session keeps being accepted.
Control-plane and authentication infrastructure only — no UI, no new surfaces.

## 1. The authentication path, mapped

Measured at `8b646c9`:

```
request ─► app.ts:52  rate limiter on /v1/*
        ─► authenticate()  app.ts:70
             ├─ readBearer(header)                    header-only, strict regex, ≤4096
             ├─ deps.verifier.verify(token)           clerk.ts:16
             │     └─ verifyToken(...)                PURE CRYPTO: signature, exp, azp
             │        └─ claims.sub, claims.sid ─────► VerifiedHumanIdentity
             ├─ deps.accounts.resolve(clerkUserId)   accounts.ts:84 — LIVE ledger read
             └─ 401 / 403 / 503
        ─► route body
```

Every protected route enters through `authenticate()`. Nothing else reads the bearer.

**The gap.** `verifyToken` is a pure cryptographic check. It knows nothing about
Clerk's current session state, so a JWT minted before a revocation keeps passing
until its own `exp`. Today the only bound on that window is the instance's
session-token TTL, which this repository neither controls nor can read.

`VerifiedHumanIdentity.sessionId` is parsed (`clerk.ts:22`) and discarded
(`app.ts:81`) for every route except the M3 session routes.

## 2. What this installation actually offers

Measured, not assumed:

| Fact                                                                                                          | Where                                             | Consequence                                    |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------- |
| `SessionWebhookEvent` covers exactly `session.created`, `session.ended`, `session.removed`, `session.revoked` | `@clerk/backend/dist/api/resources/Webhooks.d.ts` | A webhook denylist is feasible                 |
| `verifyWebhook(request, { signingSecret })` exists                                                            | `@clerk/backend/webhooks`                         | Signature verification needs no new dependency |
| `standardwebhooks` is installed and resolvable                                                                | `node_modules/standardwebhooks`                   | Confirmed at runtime, not just declared        |
| `SessionWebhookEventJSON extends SessionJSON` and adds `user`                                                 | `.../resources/JSON.d.ts:508`                     | The payload carries the sid and the owner      |
| `sessions.getSession(sessionId)` returns `status`                                                             | `.../endpoints/SessionApi.d.ts`                   | Point-in-time revalidation is feasible         |
| Test JWTs use `exp: now + 60`                                                                                 | `account-api/test/helpers.ts:45`                  | The harness's own bound is one minute          |
| `acevra-account.md:104` asserts a ~1 minute session JWT TTL                                                   | spec                                              | Documented expectation, not an enforced fact   |

The last two are **not** treated as guarantees. They describe a configuration this
repository does not own, which is precisely why M3a exists.

## 3. Architectures evaluated

### A — Persisted revoked-sid denylist fed by Clerk webhook

`session.revoked` / `.ended` / `.removed` → verified webhook → insert the sid into a
`revoked_sessions` table; `authenticate()` rejects any sid present.

_Strengths:_ revocation effective in seconds; the denylist is local, so it keeps
working during a Clerk outage; survives restart.
_Costs:_ a new table (a deliberate `me.test.ts` edit), an unauthenticated public
endpoint (a new attack surface), a signing secret to provision, and replay handling.
_Weakness:_ **not bounded.** A missed or delayed webhook leaves the session accepted
indefinitely, bounded only by token expiry. It improves latency; it does not provide
a window this codebase can state and test.

### B — Session-scoped Clerk revalidation with an in-memory freshness cache ← chosen

First presentation of a `sid` asks Clerk whether that session is still active. The
answer is cached for `freshnessTtlMs`. While the cache entry is fresh, no Clerk call
happens. A revoked session is therefore rejected at the next revalidation.

_Strengths:_ **a real, stated, testable bound** that holds even when webhooks are
missed; **no new table** and no change to `me.test.ts`; no public endpoint and no
signing secret, so no new attack surface; no per-request Clerk call.
_Weakness:_ the bound is `freshnessTtlMs`, not seconds — latency is traded for
availability against Clerk.

### C — Hybrid: webhook denylist plus bounded revalidation

B's bound with A's latency. Strictly the best behaviour.

_Costs:_ both of A's costs, plus B's. _Rejected for M3a_ because the extra moving
parts (table, public endpoint, secret, replay handling) buy latency, not
correctness, and B already satisfies the security property. Recorded as the natural
follow-up if revocation latency becomes a product complaint.

### Chosen: B

B is the smallest design that yields a bound this repository can state and prove.
It adds no persistence, because it does not need any: a restart empties the cache,
and the next request revalidates — so a restart _improves_ freshness rather than
reopening a window.

## 4. The security property

> A session that has been authoritatively revoked stops being accepted by AceVra
> within **300 seconds** of the revocation under normal connectivity, and remains
> rejected across a process restart once revocation is known.

300 seconds is derived from the implementation, not chosen as a product wish:

- It is the freshness TTL, so the worst case is exactly one TTL after the last
  successful validation of that sid.
- It caps the window **regardless of the Clerk instance's token TTL**, which is the
  actual defect M3a closes.
- Where the instance issues short-lived tokens (the documented ~60 s), the effective
  bound is the shorter of the two, so M3a never widens the window it inherited.
- Cost is one Clerk call per session per five minutes — negligible for a
  personal-alpha account set, and only on the first request of each TTL window.

Configurable via `ACEVRA_SESSION_FRESHNESS_SECONDS`; `0` disables the check and
restores M3 behaviour.

## 5. Enforcement point

**Inside `authenticate()`, immediately after cryptographic verification and before
`accounts.resolve()`.**

That is the single boundary every protected route already passes through. No route
learns about revocation; `authenticate()` rejects first, so business logic never runs
for a revoked session. Adding it here also means the M3 session routes inherit it
for free, and future routes inherit it automatically.

The check is skipped when the token carried no `sid`, because there is no session
identity to revalidate — such a request is governed by token expiry alone, exactly as
before.

## 6. Failure semantics

The three memories age differently, and that is the design:

| Memory    | Holds                           | Expires                                |
| --------- | ------------------------------- | -------------------------------------- |
| `active`  | a **guess** — Clerk said active | after `freshnessTtlMs`                 |
| `revoked` | a **fact** — Clerk said dead    | never, except after 24h (memory bound) |
| `outage`  | an **absence** of information   | after `outageCacheMs` (10s)            |

A revocation must be durable. If it shared the positive TTL, the next Clerk outage
would re-admit a session already known to be gone, for the rest of that token's life —
which is the exact window this milestone exists to close. So `revoked` is checked
before anything else and outranks even a fresh positive cached before the revocation
was learned. It is capped at 5000 entries independently of live sessions, so ordinary
memory pressure can never evict one and widen the window.

| Situation                                                            | Behaviour                              | Rationale                                                                                                                                                                      |
| -------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `revoked` contains the `sid`                                         | 401, no Clerk call                     | A fact outranks every other memory                                                                                                                                             |
| Clerk unreachable, `active` still fresh                              | Admit from cache                       | No call needed; the answer is already known                                                                                                                                    |
| Clerk unreachable, caches stale, token **not expired**               | Admit; cache the outage for 10s        | Degrades to the M3 guarantee — bounded by `exp`, never wider. An outage cannot turn an authentication problem into an authorization success                                    |
| Clerk unreachable, token **expired**                                 | 401                                    | Expiry is enforced by `verifyToken` regardless                                                                                                                                 |
| Clerk reports **404**                                                | 401, remember as revoked               | The only definitive "this session is gone"                                                                                                                                     |
| Clerk reports **401**                                                | Treat as an outage                     | Against Clerk's backend API, 401 means _this control plane's secret key_ was rejected, not that a session ended. Treating it as a revocation would sign out every user at once |
| Clerk reports 403 / 429 / 5xx / network failure                      | Treat as an outage                     | None is evidence about a particular session                                                                                                                                    |
| Clerk call hangs                                                     | Abandoned after 5s, then an outage     | One hung connection must not wedge every request for that session                                                                                                              |
| Control-plane restart                                                | Caches empty; next request revalidates | No persistence is required for correctness                                                                                                                                     |
| Concurrent first requests for one `sid`                              | Share a single in-flight Clerk call    | Otherwise a burst of requests becomes a burst of Clerk calls                                                                                                                   |
| Revoked by this API's own `/revoke` route                            | Remembered immediately                 | A revocation AceVra performs is the one that should never wait out a TTL                                                                                                       |
| Token carries no `sid`                                               | Check skipped                          | Nothing to revalidate; inventing one would be a guess                                                                                                                          |
| `ACEVRA_SESSION_FRESHNESS_SECONDS` unparseable, negative or infinite | Falls back to 300                      | `Number("abc")` is NaN, which fails the `> 0` gate and would silently disable the only revocation control                                                                      |

The outage row carries the most weight. Accepting a still-unexpired token when Clerk
cannot be reached is _weaker than the stated property_ but never weaker than M3.
Failing closed instead would take the entire account API down on any Clerk hiccup,
which the brief explicitly rules out.

The bound is wall-clock, so a backwards clock step would extend it for the duration
of the skew. That is inherent to `Date.now` and consistent with the rest of the
control plane; a monotonic clock would be the fix if that ever mattered.

## 7. Persistence

**None.** No migration, no table, no change to `me.test.ts`'s exact-table assertion.

Nothing persisted is a revocation record, a session record, a token or a secret. The
in-memory state is three maps keyed by the signed `sid` — when it was confirmed
active, when it was reported dead, and until when an outage should not be retried.
No value is a token, a secret or any data derived from the token beyond the `sid`
itself.

## 8. Test cases

1. An active session is accepted and produces no repeat Clerk call inside the TTL.
2. A session Clerk reports as not active is rejected **despite a cryptographically
   valid, unexpired JWT**.
3. One user's revocation state cannot affect another sid, and another user cannot be
   affected by a sid they do not present.
4. A revocation survives past the TTL and past cache-eviction pressure: with Clerk
   unreachable it is still rejected at +1s, +301s and +24h.
5. Concurrent first requests share one in-flight Clerk call.
6. After the TTL expires the check runs again, so a mid-TTL revocation is caught on
   the next revalidation — this is the bound, proven by a fake clock, with the
   seconds→ms conversion pinned so a 1000× slip cannot pass unnoticed.
7. A session revoked through this API's own route is rejected on the very next
   request, without waiting out the TTL.
8. A restart (a fresh cache) revalidates and still rejects.
9. With Clerk unreachable and the cache stale, an unexpired token is admitted and the
   outage does not become an authz success.
10. With Clerk unreachable and the token expired, the request is 401.
11. A token with no `sid` performs no Clerk call.
12. The cache is bounded.
13. Device, pairing, task and admission routes are unaffected: an active session still
    reaches them, and ownership fences still reject cross-account access.
14. A Clerk 401 is treated as an outage, so a rotated secret key cannot mass-revoke.

## 9. Known residual risks

- Revocation latency is up to `freshnessTtlMs`, not seconds. A webhook denylist
  (spec §3 options A and C) would cut it to seconds; deferred because it is not
  bounded on its own and needs a table plus a public endpoint.
- The 24h revocation retention assumes no session token outlives 24h. A longer-lived
  token would eventually outlive its own revocation record; raising the retention is
  the fix if that ever applies.
- The bound is wall-clock; see §6.

## 10. Out of scope

Notification UX, cross-device UI, and Multitask / Personal Bot / Cross-Mode
integration. No Electron slot is required: M3a adds nothing to render.
