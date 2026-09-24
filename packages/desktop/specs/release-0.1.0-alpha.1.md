# AceVra 0.1.0-alpha.1 local engineering alpha

## Scope and ownership

This release candidate is a macOS 12+ arm64 local engineering alpha. The root `package.json`
version is the single release-version source; workspace package versions remain unchanged. The
packaged application keeps production identity `com.acevra.desktop` / `AceVra`; Preview identity
`com.acevra.desktop.preview` / `AceVra Preview` remains available for existing preview builds.
The local alpha profile is an environment and filesystem profile, not a relabeling of either
production identity and never becomes a Developer ID build.

The desktop main process owns the compiled release profile and the Electron user-data roots.
The services layer owns the shared data-base root and all direct-home readers. CUA owns the
Helper lease, peer session, and native transport; the desktop service boundary is its only
product entry point. Packaging owns the candidate directory and release sidecars. No generated
archive is committed.

## Profile and data isolation

`local-engineering-alpha` has these exact defaults:

- Electron user data: `~/Library/Application Support/AceVra Local Engineering Alpha`
- Electron session data: `~/Library/Application Support/AceVra Local Engineering Alpha/session`
- profile home: `~/.zcode-local-engineering-alpha`
- service data base: `~/.zcode-local-engineering-alpha`
- service state: `~/.zcode-local-engineering-alpha/.zcode/v2`
- Host home: `~/.zcode-local-engineering-alpha/.zcode`
- CUA root: `~/.zcode-local-engineering-alpha/.zcode/computer-use`

`ZCODE_DESKTOP_HOME_DIR` and `ZCODE_DATA_BASE_DIR` are explicit profile roots. Either override
may be supplied alone. If both are supplied, their real-path canonical roots must be identical;
different roots fail with a profile/path conflict. Explicit overrides beat profile defaults and
bootstrap values. Bootstrap may never import production `.zcode/v2/setting.json` into this
profile. `ZCODE_PREVIEW_IDENTITY=1` is rejected with `local-engineering-alpha` so the flag
cannot silently select Preview identity.

Commands, skills and settings, settings sync, skill sync, subagents, hooks, plugin sync, global
CLI configuration, and CUA fallback all resolve through the same canonical alpha root. A clean
install therefore has no production sentinel, and a production sentinel remains unreadable by
alpha readers.

## Native CUA release rules

The product bundle contains the signed `Resources/cua-helper/AceVra Computer Use.app` and the
fixed packaged peer-identity probe. Both use the stable isolated `AceVra CUA Dev Signing`
identity and strict designated-requirement validation; ad-hoc, missing, mismatched, or tampered
nested signatures fail the candidate. The development Harness keeps its separate `AceVra
Computer Use Dev.app` identity and is never relabeled Developer ID. The alpha is explicitly
self-signed and non-notarized; Gatekeeper rejection is an expected checkpoint, not a trust claim.
The Helper has deterministic `0.1.0-alpha.1` metadata and a numeric build number supplied by
release metadata, never a timestamp.

The Host/service lease record is the sole authority for owner session, task, Helper identity,
generation, and terminal state. Acquire, Stop, release, interruption, and disconnect are ordered
through that record. Stop with no lease is `already_stopped`; a generation fence prevents a
concurrent acquire from using a lease being released. No model-facing Stop tool is added.

## Release artifacts and acceptance

A fresh candidate directory must contain exactly `AceVra-0.1.0-alpha.1-arm64.dmg` and
`AceVra-0.1.0-alpha.1-arm64.zip` as release archives, plus separately classified provenance,
release notes, checksum, and signing sidecars. The validator checks bundle version, identifiers,
arm64 architecture, native component paths, matching Helper version/build, and strict nested
signatures. It records only non-secret provenance and the certificate fingerprint/designated
requirement. It scans the candidate for secrets, private keys, personal files, repository-relative
runtime dependencies, `/tmp` dependencies, and absolute developer paths.

Installation is guarded: inspect any existing `/Applications/AceVra.app`, record its version,
signature, and provenance, and require a verified backup or explicit human approval before
replacement. No inference, provider call, credential prompt, or account authentication is
performed by packaging verification. Gatekeeper, TCC, software Stop, and physical-input checks
remain human checkpoints. There is no Developer ID, notarization, staple, public publish, push,
tag, merge, Windows/Linux native CUA, Intel, or VM claim.
