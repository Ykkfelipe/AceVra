# AceVra development identity

## Behavior

The local fork uses the `AceVra Dev` display identity, a distinct macOS bundle identifier, and
Electron user-data/session directories under the AceVra Dev application data folder. Its business
data currently remains in the historical `~/.zcode-fork-dev-home/.zcode` root, isolated from
official ZCode's `~/.zcode` root. Provider OAuth continues to use the legacy `zcode://` callback.
Packaged preview and production builds use AceVra-specific identities.

## Ownership and invariants

- The desktop renderer owns the document title and uses AceVra Dev for the fork runtime.
- The existing main-process-injected `__ZCODE_LOCAL_DEVELOPMENT_RUNTIME__` flag is the only gate.
- `mise run dev` owns the fork environment variables; production commands do not inherit them.
- Settings, task databases, credentials, telemetry state, crash archives, CLI logs, helper runtime
  files, Electron caches, and session data resolve below the fork home/user-data roots.
- The fork deep-link scheme must not register or consume the official `zcode:` scheme.
- The marker does not add state, persistence, network activity, or a second environment switch.
- The historical data root is a compatibility path and must not be moved without an explicit
  migration that preserves credentials and task state.
- `zcode://` remains registered for provider OAuth until every configured provider accepts an
  AceVra callback.

## Failure semantics and migration boundary

If fork environment variables are absent, packaged runtime identity and explicit data directory
overrides remain authoritative. The regular ZCode app must never be pointed at the AceVra data root.

## Acceptance

1. `mise run dev` launches the isolated desktop test app.
2. Its settings and workspace sentinels survive restart in the fork root.
3. Official ZCode can run concurrently without reading or writing fork sentinels.
4. AceVra uses the legacy `zcode://` scheme for provider OAuth.
5. Production and preview builds remain distinct and use AceVra product identities.
