# AceVra Auth & First Run — M1

Status: implemented behavior spec. Date: 2026-10-03.
Baseline: `origin/release/0.1.0-alpha`, `c02e24c2`.

Scope: branded signed-out / sign-in surfaces, their loading, error and recovery
states, theme compatibility, safe redirect handling, and the first-run onboarding
shell. This milestone contains no backend change and no new credential surface.

Personal Bot and Cross-Mode are explicitly out of scope here.

## 1. Baseline correction

The roadmap in `docs/roadmap/auth-first-run.md` was written against an older
baseline and is stale in one material way: it describes signed-out users as seeing
a single "Sign in with Clerk" button. That was true of the web fork route only.

At `c02e24c2` the following already exist and are **not** re-implemented here:

| Existing asset                                                                     | Location                                                        |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Clerk session verification, admission ledger, device registry, pairing, task queue | `packages/account-api/src/`                                     |
| Account window hosting the only Clerk SDK instance on desktop                      | `packages/desktop/src/renderer/src/account/main.tsx`            |
| Branded first-run account gate in the main window                                  | `packages/ui/src/account/AceVraAccountChoice.tsx`               |
| Account settings, devices and pairing UI                                           | `packages/ui/src/account/AceVraAccountSection.tsx` and siblings |
| Provider-independent first run                                                     | `packages/ui/src/onboarding/AceVraFirstRun.tsx`                 |

What is genuinely missing is presentation and state handling. The account window is
unstyled inline `system-ui` markup; the web fork signed-out card hardcodes
`AceVra Dev` and has no error state at all.

## 2. Product rules and invariants

These hold for every surface changed in M1. They are the acceptance bar.

1. **Clerk stays the authentication authority.** M1 changes presentation and state
   handling only. No credential is stored, minted or verified by AceVra code, and
   no password handling is introduced.
2. **Never expose an unconfigured provider.** Provider buttons are rendered by
   Clerk, which only emits strategies configured on the instance. M1 must not
   hand-draw provider buttons, because doing so would require guessing instance
   configuration and could advertise a provider that is not enabled.
3. **Brand by theming, not by replacement.** M1 applies an AceVra `appearance`
   theme to Clerk's components and wraps them in an AceVra-owned shell. Clerk is
   not replaced for visual reasons.
4. **Social sign-in is not service authorization.** Signing in with a Google or
   GitHub identity identifies the account. It grants no access to Gmail, Calendar,
   GitHub repositories or any other external data. Every sign-in surface states
   this in copy. No connected-service grant is created by signing in, and no
   provider secret is requested or stored.
5. **Account identity is not device authorization.** Signing in answers _who you
   are_. Registering or pairing a computer answers _which device this account may
   control_. The two are separate steps, separate commands and separate credentials
   (Clerk session JWT versus Ed25519 device key proof). M1 must not merge them into
   one step or imply that signing in trusts a machine.
6. **The client is never the authorization source.** Admission, device ownership and
   task authorization remain server-derived. Sign-in UI never reads an account id,
   owner id or admission decision from client state.
7. **Continue locally always works.** Local use must remain reachable when Clerk, the
   control plane or the network is unavailable. A sign-in surface never becomes the
   only way into the product.
8. **Redirect targets are validated.** Any destination handed to Clerk after sign-in
   must be same-origin and on an allowlisted path. Unvalidated attacker-controlled
   input must never reach `redirectUrl`.
9. **Theme by semantic tokens.** Surfaces use the repository design tokens and the
   `theme-zai-light` / `theme-zai-dark` class contract. No `dark:` variant is
   introduced, and no hardcoded hex is used for application UI.

## 3. Surfaces

### 3.1 Desktop account window

`packages/desktop/src/renderer/src/account/main.tsx`.

Owns: window chrome, branding, Clerk theming, loading / error / recovery states.
Does not own: token issuance, session storage, admission, or any secret. Those stay
behind the existing preload bridge and `accountClerkBridge` keychain storage.

States:

| State          | Trigger                          | Behavior                                                                      |
| -------------- | -------------------------------- | ----------------------------------------------------------------------------- |
| `loading`      | publishable key not yet resolved | Branded skeleton with spinner and `role="status"`                             |
| `unavailable`  | `getConfig()` rejected           | Branded error with a Retry affordance that re-runs the config read            |
| `unconfigured` | resolved key is empty            | Explicit "sign-in is not configured in this build" state; never a dead button |
| `signing-in`   | Clerk loaded, signed out         | AceVra shell plus themed Clerk `SignIn`                                       |
| `signed-in`    | Clerk reports a session          | Confirmation state; window hides itself through the existing bridge           |

Theming: the renderer applies the same `theme-zai-light` / `theme-zai-dark` class
contract as the main window, so Clerk's themed components and the AceVra shell move
together. Clerk receives an `appearance` theme built from the repository's CSS
custom properties, so a theme switch needs no second source of truth.

The `SessionBridge` contract, the `getToken({ skipCache: true })` policy and the
`reportSession` reporting are unchanged.

### 3.2 Web fork signed-out shell

`packages/web/src/customForkRemoteApp.tsx`, and the bootstrap-path card in
`packages/web/src/main.tsx`.

Uses `resolveCustomForkProductConfig().applicationName` instead of the hardcoded
`AceVra Dev` string, adds explicit loading, error and unconfigured states, and
resolves the post-sign-in destination through the shared validator in §3.4 rather
than passing `window.location.href` through unchecked.

Fixes the silent no-op where a missing publishable key left a visible but inert
sign-in button.

### 3.3 First-run onboarding shell

`packages/ui/src/account/AceVraAccountChoice.tsx` and
`packages/ui/src/onboarding/AceVraFirstRun.tsx`.

Bring both onto the design system: the `text-ui-*` scale, defined foreground
tokens, and the existing `Select` primitive instead of raw `<select>` elements.
Both carry the two boundary statements from rules 4 and 5.

All existing `data-testid` values are preserved because `packages/desktop/e2e/account.e2e.mjs`
and `provider-onboarding.e2e.mjs` assert on them.

`text-muted-foreground` is not used anywhere in this change: that token is not
defined in `packages/ui/src/styles.css`, so the class emits no CSS and the text
renders in the default color.

### 3.4 Safe redirect resolution

`packages/shared/src/accountSignInReturn.ts`.

`resolveSafeAccountSignInReturn(candidate, { allowedOrigin, allowedPaths })` returns
an absolute same-origin URL restricted to allowlisted paths, or `null`. It rejects
cross-origin candidates, protocol-relative URLs, credentials in the URL, and paths
outside the allowlist. Callers must treat `null` as "use the default landing route"
rather than passing the original value through.

This mirrors the existing `resolveSafeAppReturnTo` discipline used by the share
OAuth flow, with the path allowlist supplied by the caller that owns the surface.

## 4. Security boundaries this milestone must not weaken

- Server-side Clerk verification, admission ledger reads, header-only bearer
  parsing, non-disclosing denial and `authorizedParties` enforcement are unchanged.
- The Account window still receives only the publishable key.
- No `connected services`, provider-grant or conversation-sync entity is added.
  `packages/account-api/test/me.test.ts` asserts the table set and must stay green.
- The account window origin, asset confinement and CSP are unchanged. The M1 styles
  are bundled into the existing `assets/` output served from the same origin.

## 5. Acceptance cases

1. Account window shows a branded, theme-correct shell in both light and dark, with
   Clerk's sign-in form themed to match; no unstyled `system-ui` text remains.
2. A rejected `getConfig()` produces a recoverable error state, not a dead screen.
3. An empty publishable key produces an explicit unconfigured state, never an inert
   button.
4. The web fork signed-out shell shows the configured product name, and a missing
   publishable key shows an explicit message.
5. A redirect candidate that is cross-origin, protocol-relative, carries
   credentials, or leaves the allowlisted path set resolves to `null`.
6. A same-origin allowlisted candidate round-trips unchanged.
7. Signing-in copy on every surface states that social sign-in grants no external
   data access.
8. Signing-in copy keeps device registration a separate step from account sign-in.
9. `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed` and the
   `account-api` and `shared` suites pass.
