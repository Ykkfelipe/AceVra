# Custom fork development identity

## Behavior

The local fork uses a separate development identity: `AceVra Dev`, the
`~/.zcode-fork-dev-home` storage root, its own Electron user-data/session directories, and the
`zcode://` deep-link scheme. The renderer shows `AceVra Dev` only in this local runtime. The
welcome/login screen uses AceVra product-facing labels; internal package names and the
`zcode://` protocol are unchanged.
Packaged preview and production builds retain their existing identities.

## Ownership and invariants

- The desktop renderer owns the document title.
- The existing main-process-injected `__ZCODE_LOCAL_DEVELOPMENT_RUNTIME__` flag is the only gate.
- `mise run dev` owns the fork environment variables; production commands do not inherit them.
- Settings, task databases, credentials, telemetry state, crash archives, CLI logs, helper runtime
  files, Electron caches, and session data resolve below the fork home/user-data roots.
- The development runtime keeps the registered `zcode:` scheme for OAuth and existing deep-link
  compatibility; branding changes never rename that protocol.
- The marker does not add state, persistence, network activity, or a second environment switch.
- App identity, bundle identifiers, data directories, and production behavior remain unchanged in
  this phase; only the development display name and supported runtime roots are AceVra-specific.

## Failure semantics and migration boundary

If the fork environment variables are absent, existing official/preview defaults remain in place.
Removing the fork environment block and runtime scheme wiring restores the prior development
behavior.

## Acceptance

1. `mise run dev` launches the isolated desktop test app.
2. Its settings and workspace sentinels survive restart in the fork root.
3. Official ZCode can run concurrently without reading or writing fork sentinels.
4. The development runtime registers the compatible `zcode:` scheme, preserving OAuth callbacks.
5. A non-local packaged build continues to use its existing identity.
