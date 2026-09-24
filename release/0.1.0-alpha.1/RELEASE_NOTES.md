# AceVra 0.1.0-alpha.1

**LOCAL ENGINEERING ALPHA — PRE-RELEASE — macOS Apple Silicon**

This is a self-signed, non-notarized local engineering alpha. It is not Developer ID signed, Apple notarized, stapled, or ready for general public distribution.

## What AceVra is

AceVra is a local desktop coding agent with an embedded Chromium browser, provider/account integrations, workspace tooling, artifact delivery, and Computer Use capabilities.

## Major capabilities

- Local and remote workspace foundations already present in AceVra
- Embedded browser navigation and observation
- Semantic Computer Use actions: press and set_value
- Exclusive foreground Computer Use with lease fencing, pointer, click, text, key, scroll, and drag actions
- Packaged native Computer Use Helper and peer-identity probe
- Artifact registry, integrity hashes, and deliverable output

## Computer Use modes and safety

- **Background / semantic:** observation-derived press and set_value actions; application effect remains unproven unless independently verified.
- **Exclusive foreground:** one service-owned global lease, late-commit fencing, native Helper release, and explicit software Stop.
- The Helper owns held mouse/key cleanup and the global exclusive lock.
- Software Stop is a typed service command, is shown only for an active authoritative lease, waits for native terminal release, and is idempotent.
- Real physical mouse and Shift interruption measurements remain pending installed human acceptance.

## Installation

1. Obtain `AceVra-0.1.0-alpha.1-arm64.dmg` from the exact five-file handoff.
2. Open the DMG and drag `AceVra.app` to `/Applications`.
3. Launch AceVra. Because this build is not notarized, macOS may require the normal Gatekeeper/Open Anyway decision.
4. Grant Accessibility and Screen Recording access to `AceVra Computer Use.app` when requested.
5. Enable Computer Use from Settings only when intended.

Do not use `sudo xattr -rd com.apple.quarantine` as the normal installation workflow.

## Permissions

- Accessibility: required for native Computer Use.
- Screen Recording: required for observation and screen capture.
- Input Monitoring: requirement is not claimed until the clean installed acceptance experiment determines it.

## Supported platform

- macOS Apple Silicon / arm64
- Intel, Windows, and Linux native Computer Use are not supported or validated by this alpha.

## Known limitations

- Developer ID Application signing: deferred.
- Apple notarization and stapling: deferred.
- Gatekeeper trust for arbitrary users: not provided.
- Clean installed acceptance, physical interruption latency, packaged CUA, browser, provider/account, artifact, and restart acceptance: pending.
- Remote physical desktop control is not a CUA-5 claim.

This is alpha software. Do not treat it as daily-use accepted or public-distribution ready until the separate installed acceptance phase is completed.
