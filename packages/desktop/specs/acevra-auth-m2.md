# AceVra Auth — M2: Account & Session Management

Status: implemented behavior spec. Date: 2026-10-03.
Baseline: `feature/auth-first-run` at `49a13fc` (M1), which builds on
`origin/release/0.1.0-alpha` `c02e24c2`.

Scope: make authentication feel like a complete desktop account lifecycle rather
than only first-run sign-in. Presentation, state and one local recovery affordance.
`account-api`, the Clerk desktop account window, the device registry, pairing,
admission and the account/device settings are **authoritative and unchanged**.

Out of scope: Personal Bot, Cross-Mode, Multitask, passkeys, and any change to
their contracts.

## 1. What already exists (verified, not rebuilt)

Measured at `49a13fc`. These were read and confirmed, not re-implemented:

| Behavior                                                                                 | Where                                                                                      | Evidence                                                                                              |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Sign-out end to end: UI → hook → platform → IPC → controller → Clerk window → projection | `accountSessionController.ts:141`, `accountMain.ts:145`, `accountWindowTokenSource.ts:162` | 7 hops, all present                                                                                   |
| Sign-out deletes **no** user data                                                        | `accountSessionController.ts:142`, `accountDevices.ts:28`, `accountInstallation.ts:9`      | Zero filesystem-delete code in the account feature; E2E asserts `provider_config.json` byte-identical |
| Account window is destroyed on sign-out, forcing genuine cold re-auth                    | `accountWindowTokenSource.ts:162-172`                                                      | `finally` block calls `win.destroy()`                                                                 |
| Backend 401 on `/v1/me` → `signedOut` + `session_rejected`                               | `accountSessionController.ts:93-95`                                                        | Unit tested                                                                                           |
| Admission is a live DB read per request; revocation takes effect on the next request     | `accounts.ts:84`                                                                           | `me.test.ts:51`                                                                                       |
| 401 vs 403 split: 401 = token unverifiable, 403 = identity known but not admitted        | `app.ts:70-90`                                                                             | 403 is deliberately non-disclosing                                                                    |
| Device registry: register/list/rename/heartbeat/revoke, presence, ownership fence        | `app.ts:121-185`                                                                           | 12 tests                                                                                              |
| Device conflict: another account's installation is never silently transferred            | `devices.ts:114`                                                                           | `accountDevices.test.ts:85`, E2E `:373`                                                               |
| `rememberSession` derived from `safeStorage` availability, no plaintext fallback         | `accountTokenStorage.ts:32`, `accountClerkBridge.ts:12`                                    | `accountSessionController.test.ts:253`                                                                |
| Generation fence: a late response cannot resurrect a signed-out or switched account      | `accountSessionController.ts:76`                                                           | `:148`, `:163`                                                                                        |
| Account identity, admission state and device list rendered in Settings                   | `AceVraAccountSection.tsx`                                                                 | Mounted `SettingsPage.tsx:1813`                                                                       |

## 2. Gaps M2 closes

### 2.1 A rejected session is only detected on one endpoint

**Defect.** `accountSessionController` interprets HTTP 401 in exactly one place —
the `/v1/me` admission check (`accountSessionController.ts:93`). Every other
account endpoint goes through `accountDevices.call()` (`accountDevices.ts:40`),
which returns `{ status, json }` and leaves the interpretation to each caller.
No caller looks at 401:

- `beat()` (`accountDevices.ts:67`) handles only `403 + device_revoked`; a 401 is
  silently ignored and the heartbeat keeps running against a dead session.
- `start()` (`accountDevices.ts:115-124`) falls through to `registration = "unavailable"`.
- `view()` (`accountDevices.ts:84`) reports `registration: "unavailable"`.

**Consequence.** When a Clerk session is revoked or expires while the app is open,
the next device list/heartbeat surfaces as a generic "devices unavailable" string
and the account still reads as `ready`. The user has no route back to sign-in and no
indication that anything went wrong. `/v1/me` is only re-fetched on a Clerk session
event or an explicit `refresh()`, so in practice the stale state can persist.

**M2 behavior.** A 401 from _any_ account endpoint makes the controller re-run the
authoritative `/v1/me` admission check, which then decides: `ready` if the session is
actually fine, `signedOut` + `session_rejected` if it is not. The device client reports
the 401 through an `onUnauthorized` callback; it never decides the outcome itself. This
is a routing change only — no backend surface, no new authentication.

### 2.2 Sign-out has no pending or failure state

**Defect.** `useAceVraAccount.signOut` (`useAceVraAccount.ts:37`) is a
fire-and-forget pass-through. The settings sign-out button has no `disabled` state,
so it can be double-submitted, and a rejection is unobservable — `signOut()` in the
controller swallows transport failure deliberately (`accountSessionController.ts:145`),
which is correct for the projection but leaves the UI unable to distinguish
"finished" from "still running".

**M2 behavior.** Only the sign-_in_ control gains a busy state, matching the
first-run gate, so it cannot be re-triggered while the Account window opens.

Sign-out deliberately does **not** get a pending flag. `signOut()` settles the
projection synchronously before awaiting the token source
(`accountSessionController.ts:141`), so the control swaps to the sign-in variant
on the next render and a spinner would only ever flash. The original goal — not
double-submitting — is met by the projection changing immediately.

**No confirmation dialog, deliberately.** Sign-out deletes nothing — provider
config, conversations, installation identity and the device registry row all survive,
and this is asserted in E2E. A confirmation gate would add friction in front of a
non-destructive action while implying a destructive one. M2 makes the non-destructive
behavior explicit in copy instead.

### 2.3 The account identity block is incomplete

**Defect.** `AccountProfile.avatarUrl` (`packages/shared/src/account.ts:20`) is
parsed and carried all the way to the renderer but never rendered;
`AceVraAccountSection.tsx` draws an initial-letter circle instead.

**M2 behavior.** Render the avatar when the backend supplies one, falling back to
the existing initial circle. No contract change: `avatarUrl` already exists.

Email is deliberately **not** added. `MeResponse` (`app.ts:18`) has no email field
and adding one is an account-api contract change, which is out of scope.

### 2.4 Switching accounts dead-ends on the device registry

**Defect, and the most user-visible gap.** `devices.installation_id` is globally
`UNIQUE` (`migrations/002_devices.sql:8`), and `register` refuses a cross-account
claim _before_ checking revocation (`devices.ts:113-117`):

```ts
if (row.account_id !== accountId) return { ok: false, reason: "installation_bound" };
if (row.revoked_at) return { ok: false, reason: "device_revoked" };
```

The installation id is a persistent local file that deliberately survives sign-out
(`accountInstallation.ts:10`). So once any account claims this machine, signing in as
a different account returns `409` forever — and revoking the original device does not
help, because the ownership check runs first and the row still exists. The UI shows
`acevra-device-conflict` and offers no way forward.

**M2 behavior.** The conflict state explains itself and offers one local recovery
action: _use a new device identity for this machine_. That mints a fresh
installation UUID and re-registers. The old row is untouched and still belongs to the
original account, so:

- no silent transfer occurs — the new id is a different key, not a reassignment;
- the original account keeps its device (it will simply read as stale/offline);
- `installation_id` remains a non-secret lookup key and is still never a credential
  (`accountInstallation.ts:9`).

This is additive and local. No migration, no schema change, and
`me.test.ts:103`'s exact-table assertion is untouched.

### 2.5 `rememberSession` is invisible unless signed in

**Defect.** The warning is gated on `phase === "ready"`
(`AceVraAccountSection.tsx:91`), so a user on a memory-only keystore who is signed
out is never told that their session will not survive a restart — which is exactly
when it matters most.

**M2 behavior.** Surface it whenever the account is configured and persistence is
unavailable, independent of phase.

## 3. Explicitly out of scope, with reasons

These were requested or are adjacent. Each is declined for a stated reason, not
overlooked.

- **Listing or revoking human sessions.** Not implemented anywhere in this repo:
  no route, no service, no contract, no client call. `VerifiedHumanIdentity.sessionId`
  (`ports.ts:5`) is extracted and then discarded at `app.ts:81`, and the Clerk
  client is only used for `users.getUser` (`clerk.ts:36`). Building it means a new
  port, service, route, shared type and desktop plumbing — i.e. redesigning the
  authoritative boundary, which this milestone forbids. The device registry already
  provides the "which machines" half of session visibility and is surfaced in
  Settings.
- **Distinguishing "revoked" from "never admitted".** The backend deliberately
  collapses both into one non-disclosing 403 (`app.ts:83-85`) so a denied caller
  learns nothing about the ledger. Splitting them would weaken that boundary.
- **Email in the identity block.** `MeResponse` has no email; adding one is an
  account-api contract change.
- **Passkeys.** Not required for account lifecycle.
- **A sign-out confirmation dialog.** See §2.2.

## 4. Security and session decisions

1. **Reuse the existing boundary unchanged.** M2 adds no credential handling, no new
   persistent auth storage, and no new account-api route or table. The only local
   write is a fresh installation UUID, which is documented as a non-secret lookup key.
2. **A 401 is a claim, not a verdict.** The device client reports it; the controller
   re-runs the authoritative `/v1/me` admission check under a fresh generation instead
   of trusting a device route. This matters twice over. A 401 on a single token often
   just means that token expired and Clerk can mint a fresh one, and a response from a
   superseded attempt must not be able to sign out whoever is signed in now — the first
   implementation hard-set `signedOut` from inside `call()` and reproduced exactly that
   bug during review. Re-checking costs one request and removes a whole class of
   spurious sign-out.
3. **The client is still not the authorization source.** `session_rejected` is a
   presentation state derived from an HTTP status; it grants nothing and authorizes
   nothing. Server admission remains a live ledger read.
4. **Sign-out claims nothing about server revocation.** The existing comment at
   `accountSessionController.ts:148` stands: local access is removed; server-side
   session revocation is Clerk's business and is not asserted.
5. **The device-identity reset is explicit and local.** It never mutates another
   account's row and never presents an existing id under a new owner.
6. **M1 safe-redirect guarantees are untouched.** `resolveSafeAccountSignInReturn` is
   unchanged and still the only path to a post-sign-in destination.

## 5. Acceptance cases

1. A 401 from `/v1/devices`, `/v1/devices/register` or a heartbeat drives the
   projection to `signedOut` + `session_rejected`, and the UI offers sign-in.
2. A 403 `device_revoked` still reads as revoked, not as a session failure.
3. A network failure still reads as `offline`, not as a session failure.
4. Sign-out reaches `signedOut`, calls the token source once, and preserves the local
   choice preference. No filesystem delete is reachable from the account feature.
5. The settings sign-in control is disabled while a sign-in is in flight, and
   sign-out flips the projection synchronously without an intermediate state.
6. The identity block renders `avatarUrl` when present and falls back to the initial.
7. `registration: "conflict"` renders an explanation and a recovery action; the
   action mints a new installation id and re-registers, leaving the original
   account's row untouched.
8. `rememberSession === false` is surfaced whenever configured, not only when ready.
9. `resetInstallation()` outside a `conflict` is a no-op, so the renderer cannot mint
   unbounded device rows (the backend never deletes).
10. A failed reset leaves `conflict` intact, so the recovery control cannot delete itself.
11. Concurrent resets cannot leave the in-memory cache and the on-disk id disagreeing.
12. `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed` pass;
    `packages/account-api` stays 81/81; the desktop account unit tests pass.

## 6. Verification status

Everything above is covered by unit tests except two items, both of which need the
shared live Electron slot and are therefore **pending**:

- the reset-identity control has no E2E scenario. Its "leaves the other account's row
  untouched" half is asserted against a stubbed `fetch`, never a real backend;
- the device-conflict banner and the new sign-in busy state have not been seen rendered
  in either theme.
