# AceVra product identity

This document is the identity policy for the AceVra derivative. AceVra is the application users
run; ZCode names that remain in source are upstream attribution, compatibility APIs, or persisted
data contracts unless the inventory below says otherwise.

## Canonical identity matrix

| Surface                                   | Canonical value                     |
| ----------------------------------------- | ----------------------------------- |
| Product display name                      | `AceVra`                            |
| Development display name                  | `AceVra Dev`                        |
| Preview display name                      | `AceVra Preview`                    |
| CLI/package-safe slug                     | `acevra`                            |
| macOS production bundle id                | `dev.acevra.app`                    |
| macOS development bundle id               | `dev.acevra.app.development`        |
| macOS preview bundle id                   | `dev.acevra.app.preview`            |
| Reserved future CUA helper id             | `dev.acevra.cua-helper`             |
| Reserved future CUA development helper id | `dev.acevra.cua-helper.development` |
| Linux production executable/package       | `acevra`                            |
| Linux development executable/package      | `acevra-dev`                        |
| Linux preview executable/package          | `acevra-preview`                    |
| Windows production AppUserModelID         | `dev.acevra.app`                    |
| Windows development AppUserModelID        | `dev.acevra.app.development`        |
| Windows preview AppUserModelID            | `dev.acevra.app.preview`            |

Electron Builder's `appId` is the source for packaged macOS bundle identity and Windows shell
identity. The desktop product identity definition is in
`packages/desktop/scripts/desktop-product-identity.mjs`; build configuration consumes the
production/preview records. The dev Electron bundle and runtime use the development record's
values. UI labels and package manifests use literal product names where importing build metadata
would add inappropriate coupling.

## Protocols

- **Legacy compatibility protocol: `zcode://`.** Z.ai/BigModel OAuth provider registrations and
  their web callback relay use this exact URI. Keep it registered and keep OAuth validation bound
  to it until provider-side redirect registration is confirmed for a replacement.
- The original ZCode app also registers `zcode://`. The OS can have only one default handler per
  scheme at a time, so whichever app last registers the handler may receive the OAuth callback.
  Separate bundle IDs and data roots prevent data sharing but cannot remove this OS-level callback
  collision. A provider-approved AceVra redirect is required for reliable concurrent OAuth use.
- `acevra://` is a possible future application-owned scheme, but is not active in this change.
  Current deep-link parsing, launch registration, Linux desktop association, and installed-provider
  callbacks are designed around one scheme. Supporting both safely requires a coordinated change
  to protocol declarations, second-instance/open-url parsing, Linux MIME associations, and tests.
  It can be added as a non-OAuth alias while keeping `zcode://` OAuth-only after that work.
- Custom in-app schemes such as `zcode-media:` are internal resource protocols, not public product
  identities; do not rename them as part of visual rebranding.

## Runtime and persistent paths

- Official ZCode uses its existing `~/.zcode` business-data root and `ZCode` Electron userData.
- AceVra development currently uses `~/.zcode-fork-dev-home/.zcode` for business data and the
  separate Electron userData/session paths derived from `AceVra Dev`.
- The production-CDN development helper's remote-assets cache is under the AceVra Dev application
  data directory; it no longer reads or writes the official ZCode remote-assets cache.
- The current fork root is a compatibility path containing real provider credentials, task data,
  settings, and logs. Do not move, rename, or delete it in a branding release.
- A future clean path such as `~/.acevra-dev/.zcode` may be introduced only with an explicit,
  idempotent migration that preserves encrypted credentials and task state and never changes the
  official ZCode root. Until that migration exists, keep reading/writing the historical fork path.
- `ZCODE_DATA_BASE_DIR`, `ZCODE_HOME`, `ZCODE_DESKTOP_HOME_DIR`, and `ZCODE_FORK_DEV` continue to
  be the internal switches that keep fork data separated. They must not be dropped or silently
  reinterpreted while the old path remains active.

## Namespace and environment strategy

| Namespace                                                                   | Decision    | Reason                                                                                                                                                                              |
| --------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@zcode/*`, `packages/zcode-cua`, `apps/zcode-cli`                          | KEEP        | Internal package/import and workspace APIs; renaming creates broad churn and upstream sync conflicts.                                                                               |
| `ZCODE_*` environment variables                                             | KEEP        | Internal runtime/build compatibility contract shared by scripts, Desktop, Host, CLI and tests. A future `ACEVRA_*` migration should add aliases first, then deprecate deliberately. |
| RPC method/type names and protocol payload fields                           | KEEP        | Wire compatibility and persisted session/task state depend on them.                                                                                                                 |
| `.zcode` settings/database keys and legacy import paths                     | KEEP        | Persistent user data contract; migrate only with a designed data migration.                                                                                                         |
| `zcode://` provider OAuth callback                                          | KEEP        | External provider allowlists currently depend on it.                                                                                                                                |
| Product-facing labels, bundle/package identifiers, About text, relay labels | MIGRATE NOW | These are visible identity fields and do not require changing internal APIs.                                                                                                        |

No `ACEVRA_*` environment aliases are added now: there is no benefit to creating a parallel env
surface before a deliberate compatibility migration is designed.

## Linux and Windows packaging

Linux packaged executable and binary package names derive from the selected identity. The current
Linux OAuth association intentionally retains `zcode.desktop`, `x-scheme-handler/zcode`, and its
ownership marker because those are tied to the compatibility callback and existing installation
cleanup. User-visible `Name`, `StartupWMClass`, and executable/package names use AceVra identities.

Windows currently packages through electron-builder's NSIS target. Production/preview package
names come from `productName` and artifact naming; packaged AppUserModelID follows `appId`. No
additional Windows packaging format is introduced here.

## Upstream attribution and intentional remaining names

Do not remove upstream copyright, Apache license text, `NOTICE.md`, third-party notices, or
license headers. Use “ZCode” for the original project, upstream service endpoints, or historical
compatibility only. Use “AceVra” for this derivative product.

| Remaining occurrence/category          | Examples                                                                  | Policy                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Internal source namespace              | `@zcode/*`, `ZCodeTaskMeta`, `ZCODE_*`, `packages/zcode-cua`              | Keep; not presented as product identity.                                                                                     |
| Legacy persisted data/config           | `.zcode`, old ZCode userData paths in migration helpers                   | Keep to find existing user state; never repurpose official data for AceVra.                                                  |
| External OAuth/deep-link compatibility | `zcode://oauth/callback`, Linux `zcode.desktop`, `x-scheme-handler/zcode` | Keep until provider and installed-client compatibility migration.                                                            |
| Shared OS protocol-handler collision     | Original ZCode and AceVra both register `zcode://`                         | Last registered app may receive either app's callback; reliable coexistence needs a provider-approved AceVra callback.       |
| Upstream product/service names           | `ZCode CDN`, `ZCode 3.x`, `ZCode MCP`, verified ZCode official plugin      | Retain only when naming the upstream distribution/account/entitlement product or trust root; don't relabel its service.      |
| Upstream attribution/design references | Apache/license, upstream repository/project, Z.ai provider service URLs   | Keep and label as upstream where user-facing context requires it.                                                            |
| Historical tests/specs/comments        | Existing storage and release behavior                                     | Update when describing the current fork; retain only when recording a real historical migration or compatibility constraint. |

## Computer Use coordination

The separate Computer Use worktree is not modified by this identity change. This branch updates a
few desktop CUA indicator and shared localized UI identity strings, which may conflict if the CUA
worktree edits the same copy. The future integration target is in
[ACEVRA_CUA_INTEGRATION.md](./ACEVRA_CUA_INTEGRATION.md). No helper signing, permissions, helper
bundle identifiers, or helper implementation is changed here.

## Migration risks and future cleanup

1. Provider OAuth registrations may reject `acevra://`; retain `zcode://` until provider-side
   allowlisting and a tested callback migration are available.
2. Renaming the development data directory without migration would make saved credentials/tasks
   appear lost. The current path remains in use.
3. Internal namespace renames would conflict with upstream sync and external integrations; keep
   those changes out of product-identity work.
4. Linux desktop handler filenames are compatibility identifiers and need an upgrade/uninstall
   plan before they can be renamed.
5. Future cleanup candidates: add and test a dual-scheme parser/registration, plan a safe dev-data
   migration, and add `ACEVRA_*` aliases only when there is a rollout owner.
