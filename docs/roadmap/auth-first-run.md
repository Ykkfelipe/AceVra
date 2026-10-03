# AceVra Auth & First‑Run Experience — Roadmap

> Status: **M1 in progress** on `feature/auth-first-run`. The behavior spec, plus the
> corrections to this roadmap's baseline assumptions, live in
> `packages/desktop/specs/acevra-auth-m1.md`. Read that spec first: the "Current repo
> state" section below predates `c02e24c2` and understates what already ships.
>
> Originally authored as a reference-only roadmap. Everything else is unchanged.

> Goal: turn the current functional Clerk-backed auth boundary into a polished AceVra sign-in, account, device-trust, and first-run experience.

## Current repo state

As of this roadmap:

- the custom-fork web/remote path already uses Clerk (`@clerk/clerk-js` client + `@clerk/backend` verification)
- signed-out users are currently shown a simple `AceVra Dev` card with a single **Sign in with Clerk** button
- that button redirects to Clerk sign-in
- the server verifies Clerk session JWTs and currently also checks allowed Clerk user IDs for the custom-fork boundary

So this should be treated as a **productization and auth-flow redesign over an existing security boundary**, not a ground-up replacement unless later requirements justify one.

## Product goals

- feel unmistakably like AceVra rather than a generic hosted auth form
- support modern low-friction sign-in
- keep the server-side verification boundary strong
- make desktop/web/remote-device identity understandable
- provide good recovery/error states
- connect first sign-in naturally into Bot/device setup

## Sign-in methods

Desired options, subject to Clerk configuration/platform support:

- **Continue with Google**
- **Continue with GitHub**
- email sign-in / verification
- **Passkey** sign-in when available
- existing authenticated session reuse

Do not expose provider options that are not actually configured.

## UI direction

Replace the current minimal box/button experience with a polished branded auth shell.

Buttons should feel like real interactive controls, not empty bordered rectangles:

- provider icon
- clear label
- hover/press/focus states
- loading/progress state
- disabled state
- error state
- keyboard accessibility
- consistent spacing/typography
- dark/light theme support

Example:

```text
                 ACEVRA

          Welcome back
  Sign in to continue to your workspace

[ G  Continue with Google ]
[ ◉  Continue with GitHub ]
[ 🔑 Use a passkey        ]

────────── or ──────────

[ Email address          ]
[ Continue               ]
```

Visual design should match the future AceVra identity, not inherited ZCode styling.

## Passkeys

Passkeys are a strong future fit for a personal agent product because they reduce password friction and pair naturally with trusted personal devices.

Desired behavior:

- show passkey sign-in when supported/configured
- allow registering a passkey from Account/Security
- name/manage passkeys where provider APIs permit
- retain a recovery path
- gracefully fall back when a browser/device cannot use passkeys

Do not create a home-grown WebAuthn credential system if Clerk already safely provides the needed flow.

## OAuth providers

Google and GitHub should be first-class visual sign-in options when enabled.

Important UX:

- preserve intended return destination
- handle cancelled OAuth cleanly
- show understandable provider errors
- avoid loops between AceVra and hosted auth
- keep redirect targets validated/safe

## Desktop, web, and remote continuity

Auth should feel like one AceVra account even when the user reaches it through different surfaces:

- desktop app
- web app
- remote access to a registered device

Desired model:

```text
AceVra Account
  ├─ authenticated sessions
  ├─ trusted devices
  │   ├─ Mac
  │   ├─ Dell
  │   └─ future VM
  └─ connected services
```

Authentication and device authorization should remain conceptually separate:

- **Who are you?** → account/session auth
- **Which device may this account control?** → device ownership/trust

## Device trust / pairing

Longer-term first-run should let the user connect and understand their machines rather than relying on hidden environment configuration.

Potential flow:

1. sign in
2. detect/register this device
3. name the device
4. optionally connect another device (e.g. Dell)
5. show capability/permission status

Account UI should later support:

- list signed-in sessions
- list trusted devices
- last seen
- revoke device/session
- rename device
- reconnect offline device

## First-run onboarding

After first successful sign-in, avoid immediately dumping the user into a complex inherited workspace.

Potential lightweight onboarding:

1. Welcome to AceVra
2. choose/display name
3. optionally set up the Personal Bot identity/avatar later
4. connect GitHub if desired
5. configure model/provider access
6. register local device
7. explain Work vs Bot at a very high level

Keep onboarding skippable and incremental. Do not demand every integration on day one.

## Connected-account distinction

Signing into **AceVra with Google/GitHub** is not the same thing as granting Ace access to Gmail, Google Calendar, GitHub repos, etc.

Keep these separate in UX and permissions:

- account authentication
- external service connection
- per-capability permissions

This avoids users assuming that social login silently grants the Bot access to personal data.

## Security boundaries

Preserve/strengthen the current server-side trust model:

- server verifies session token/JWT
- client does not become the source of truth for authorization
- validate authorized parties/origins
- validate redirect/return targets
- keep secrets out of client bundles
- distinguish local-development bypasses from production behavior
- fail closed on invalid/expired auth
- log auth/device failures without logging secrets/tokens

The current allowlisted Clerk-user approach is acceptable as a personal-project development boundary, but a generalized product should evolve toward explicit account/device ownership rather than a static environment allowlist.

## Error / recovery UX

Design real screens/states for:

- expired session
- network unavailable
- Clerk/provider unavailable
- OAuth cancelled
- account not authorized
- device offline
- device belongs to another account
- session revoked
- passkey unavailable
- recovery required

Do not collapse all of these into a generic 'Sign in failed'.

## Account / security surface later

Potential settings:

- profile
- authentication methods
- passkeys
- active sessions
- trusted devices
- connected services
- data/privacy controls
- sign out everywhere
- delete/export account data when product scope eventually requires it

## Implementation sequence

- [ ] Extract current signed-out auth shell into an AceVra-owned component
- [ ] Create polished branded sign-in UI
- [ ] Wire configured Google/GitHub provider flows
- [ ] Add robust loading/error/return-state handling
- [ ] Add passkey sign-in/registration where supported by Clerk configuration
- [ ] Unify desktop/web/remote signed-in state UX
- [ ] Add device registration/trust model
- [ ] Add first-run onboarding
- [ ] Add Account/Security management UI
- [ ] Replace development-only allowlist assumptions when broader multi-user scope is required

## Non-goals for first pass

- Do not replace Clerk solely for visual reasons.
- Do not implement custom password storage.
- Do not conflate social login with Gmail/GitHub data permissions.
- Do not weaken server-side token verification.
- Do not make onboarding block basic use unnecessarily.

## Parallel development policy

When implementation begins, use a fresh feature branch/worktree from the latest good `main` and follow `docs/roadmap/parallel-development-policy.md`.

Roadmap branches are reference-only and should not be used as long-lived implementation bases.

## Guiding idea

**Signing into AceVra should feel like entering your own agent environment — polished, secure, fast, and clearly connected to the devices and capabilities you choose to trust.**
