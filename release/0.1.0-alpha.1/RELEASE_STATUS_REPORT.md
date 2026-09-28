# AceVra 0.1.0-alpha.1 — release status report

**Date:** 2026-09-24  
**Branch:** `release/0.1.0-alpha`  
**Installed revision:** `42a26cd` (`42a26cdd`)

**Status:** Installed local engineering alpha, ready for the limited human UI check. Broader
acceptance remains intentionally paused.

## 1. Product and security boundary

- Product: AceVra `0.1.0-alpha.1`
- Bundle ID: `com.acevra.desktop`
- Profile: `local-engineering-alpha`
- Platform: macOS arm64
- Signing: local self-signed identity `AceVra CUA Dev Signing`
- Developer ID: not used
- Notarization/stapling: not used
- Public publish, tag, merge, provider inference, and Gatekeeper/TCC bypass: not performed
- TCC permissions: not changed
- CUA-4/CUA-5, VM/private desktop, provider redesign, and unrelated cleanup: not started

The native Computer Use TCC owner remains:

```text
AceVra Computer Use.app
dev.acevra.cua-helper
```

The outer app is not the TCC subject. Input Monitoring was not added.

## 2. Repairs completed

### Plugin availability and config authority

- Restored the canonical `computer-use@zcode-plugins-official` plugin package and its manifest,
  docs, client, and skill assets.
- Added desktop and remote/SEA packaging checks so the plugin cannot silently disappear again.
- Fixed the isolated-alpha config split: plugin enablement and service reads now agree under
  `ZCODE_HOME`.
- Kept legacy plugin ID compatibility without changing the canonical user-facing ID.

### Helper admission and permission projection

- Product Helper startup now waits for real Helper admission before reporting readiness.
- `permission_status` is relayed through the same admitted Helper transport instead of creating a
  second authority.
- Native `available: true` reports are preserved by the service projection.
- Helper-unavailable, plugin-disabled, unknown, and granted/denied states are no longer conflated.

### macOS permission links

- Accessibility and Screen Recording rows open the requested System Settings pane immediately.
- A second click while an operation is active is queued instead of silently dropped.
- Existing `shell.openExternal` deep links and the broader Privacy & Security fallback remain.
- Existing focus, return-recovery, Helper-restart, and manual recheck paths remain.

### Composer truth and tooltip repairs

- `16af5e1`: the local-alpha reminder disappears after confirmed Computer Use enablement, and the
  stale “restart ZCode” tooltip was replaced with Settings-first wording.
- `633de95`: once the canonical plugin is confirmed enabled, stale plugin errors no longer override
  the enabled composer state.
- `6b5c721`: fixed the restart-specific false error. The first-screen permission cache restored a
  valid report without `available: true`; the composer therefore misread it as Helper-unavailable.
  Cache validation now preserves the live Helper availability contract.
- Unavailable and malformed cached payloads remain rejected.

### Composer presentation and naming

- `48bea3c`: the built-in backend is now displayed as **Agent** in English and **智能体** in Chinese.
- The stable backend value remains `zcode`; protocol fields, package names, test IDs, logs, bundle
  identity, and release identity are unchanged.
- Mode, backend, plan, and Computer Use controls share a compact outline treatment:
  - 28 px hit target;
  - semantic border/surface/hover tokens;
  - expanded-state surface;
  - visible keyboard focus ring;
  - `text-ui-*` typography.
- Leading and task-option controls are grouped as localized semantic toolbars.
- Computer Use remains a Settings entry, not a direct runtime toggle; its state owner is unchanged.
- `42a26cd`: fixed the overlapping composer controls by changing the shared trigger contract from a
  square `size-7` box to a fixed 28 px height with a 28 px icon-only floor and content-driven width
  when text is visible.
- `42a26cd`: new-task and idle-time composer copy now uses generalized agent wording instead of the
  internal product name.

### Release packaging and installation

- Local-alpha outer signing happens before DMG/ZIP creation through Electron Builder `afterSign`.
- The validator checks the raw app, ZIP-contained app, and mounted DMG app.
- Outer/Helper/peer-probe designated requirements share the same certificate root.
- Installation uses the tested exact-handoff runner with provenance checks, running-process refusal,
  signature-preserving `ditto` staging, atomic replacement, automatic rollback, and backups.
- Generated binaries, signing keys, passwords, and credentials are not committed.

### Workspace cleanup

- Superseded release build/validation/handoff directories were removed.
- Only the current candidate remains:
  - `build-cua-42a26cd/`
  - `validation-cua-42a26cd/`
  - `handoff-final-42a26cd/`
- The stale `mock-cdn/releases/3.14.0` Node runtime cache was removed (~571 MB).
- `mock-cdn/releases/0.1.0-alpha.1` remains because packaging uses it.
- No build/runtime Node processes remained after build/install. Other `node` binaries under
  `node_modules` are dependencies and must not be deleted manually.
- Free space is approximately 36 GiB.

## 3. Verification completed

Current candidate `42a26cd`:

- Archive-aware validator: passed for raw app, ZIP app, and mounted DMG app.
- Installed embedded metadata: `buildCommitId=42a26cdd`, profile `local-engineering-alpha`.
- Strict installed codesign verification: passed.
- Certificate-root designated requirement: passed.
- Exact five-file handoff checksums: passed.

Source gates on the repair stream:

- Focused composer/cache/Computer Use tests: 10 passed in the latest run.
- Earlier focused CUA/plugin/permission tests: 13 passed.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with zero errors; existing warnings remain.
- `pnpm architecture:check --changed`: passed with zero violations.
- Task-changed files formatted; `git diff --check`: passed.
- Full pinned workspace build: passed.

The repository-wide formatter still reports unrelated pre-existing formatting debt; no unrelated
files were reformatted in this work.

## 4. Current installed state

- Path: `/Applications/AceVra.app`
- Revision: `42a26cd` / `42a26cdd`
- Version: `0.1.0-alpha.1`
- Profile: `local-engineering-alpha`
- App is installed and relaunched.
- Immediate prior backup:
  `/Applications/.AceVra.app.backup-d7520775-2db3-46c9-a747-978fe13317c4`
- Earlier backup:
  `/Applications/.AceVra.app.backup-4d81e807-a6a5-4fd6-9c32-e90ea297664d`

Current handoff:

```text
release/0.1.0-alpha.1/handoff-final-42a26cd
```

Checksums are recorded in that handoff’s `SHA256SUMS.txt`.

## 5. What remains for human verification

Only these local UI checks are requested now:

1. In the newly opened AceVra, confirm the built-in backend control says **Agent**, the new-task
   placeholder is the approved desktop copy `Ask the agent anything, @ to add context, / for commands or capabilities`,
   and the mode/Computer Use/Agent controls no longer overlap.
2. Confirm the Computer Use composer control no longer shows the enablement-failure tooltip while
   Computer Use is enabled.
3. Open **Settings → Computer Use**, enable Computer Use if needed, and confirm the local-alpha
   reminder disappears after the toggle settles.

## 6. Explicitly not accepted yet

Do not claim or start these without a new checkpoint:

- Gatekeeper first-launch acceptance;
- Accessibility, Screen Recording, or Input Monitoring authorization;
- physical mouse/Shift interruption;
- foreground/background Computer Use execution;
- browser use acceptance;
- task artifact acceptance;
- provider/account acceptance or any provider inference;
- remote/mobile-control acceptance;
- restart/persistence acceptance;
- publish, tag, merge, CUA-4, or CUA-5.

## 7. Known limitations

- The package-aware E2E used an E2E-flagged build and mocked only the final OS launch boundary. It
  does not prove real System Settings or TCC behavior.
- No TCC permission was granted or changed during this work.
- The alpha remains self-signed and non-notarized; Gatekeeper rejection on first launch is expected
  and must be handled only through the documented human checkpoint.
- Internal names still contain `ZCode` where they are runtime, protocol, compatibility, or package
  identities. Those were intentionally not renamed.
