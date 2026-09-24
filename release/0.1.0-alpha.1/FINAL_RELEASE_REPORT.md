# AceVra 0.1.0-alpha.1 — Computer Use settings repair handoff

**Status: REPAIRED CANDIDATE INSTALLED; READY FOR HUMAN SETTINGS/ENABLEMENT VERIFICATION**

The previously installed candidate was `49d5fd6d`. It was preserved and replaced through the tested backup/staging/rollback runner with the new repaired candidate.

## 1. Missing-plugin root cause

The canonical UI toggle called `setPluginEnabled("computer-use@zcode-plugins-official", true)`, but no loadable official plugin package with that ID was staged into the desktop/SEA runtime. The bootstrap selector therefore threw `Plugin not found`.

The repair restores the official `@zcode/zcode-cua-plugin` package and stages its manifest, docs, client, and Computer Use skill into the packaged `glm/packages/zcode-cua-plugin` tree.

## 2. Intended Computer Use enablement architecture

Computer Use remains default-off and is enabled through the canonical official plugin configuration. The plugin is the enablement/skill layer; `@zcode/zcode-cua` remains the native Helper/broker/lease authority. The plugin does not create a second Helper, socket, lease authority, or TCC subject.

## 3. Legacy plugin dependency

The canonical plugin dependency is now correctly bundled and discoverable. Compatibility support for the legacy `zcode-cua@zcode-plugins-official` ID remains internal, but the installed default path is the canonical `computer-use@zcode-plugins-official` ID. A normal user toggle no longer depends on a missing upstream package.

## 4. Composer button impact

The composer visibility setting remains separate from enablement, but its `pluginEnabled` dependency now reads the real packaged Computer Use plugin state. Once the plugin is enabled and the composer setting is made visible, the same authoritative state drives the composer action; it no longer points at an absent plugin.

## 5. Accessibility-link root cause

The React action was gated on a settled, available, actionable permission status. With the Helper unavailable or status still settling, the click returned before crossing preload/main. The action now opens the platform boundary even when the current status is unknown/unavailable.

## 6. Screen Recording-link root cause

The same status gate blocked Screen Recording. The packaged Electron main/preload chain existed, but the UI never invoked it under the observed `Unknown` state.

## 7. macOS settings-opening implementation

The existing Electron `shell.openExternal` boundary is preserved. Per-pane URLs remain best effort:

- `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`
- `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`

If the exact pane URL fails, the main process falls back to:

- `x-apple.systempreferences:com.apple.preference.security`

The result includes `fallbackUsed`, failures are typed and visible, and a fallback hint tells the user to select the requested permission manually. No shell command is assembled from user input.

## 8. Permission-status source

`permission_status` is read from the same admitted Helper transport used by the product CUA runtime. The product host no longer returns `{}` for a valid Helper. The services projection preserves `available: true` and native granted/denied/stale/unknown values.

## 9. TCC owner identity

The TCC subject is:

```text
AceVra Computer Use.app
bundle ID: dev.acevra.cua-helper
packaged path: AceVra.app/Contents/Resources/cua-helper/AceVra Computer Use.app
```

The UI copy now identifies `AceVra Computer Use.app`; it does not tell the user to authorize the outer `AceVra.app`.

## 10. Refresh/recheck behavior

The existing focus, return, Helper-restart, and permission-store refresh paths remain. A visible Re-check permissions action was added. `available:false` is displayed as Helper unavailable rather than being conflated with a TCC `unknown` or required state. No second Helper is created.

## 11. Tests

Passed:

- Official plugin package and seed-asset tests.
- Plugin default-off/canonical/legacy enablement tests.
- Desktop/SEA packaging inclusion tests.
- Packaged plugin verifier missing-asset regression.
- Bootstrap runtime feature and node-repl registration tests.
- Product Host `permission_status` transport test.
- Service permission projection tests.
- macOS settings fallback and failure tests.
- Existing CUA packaging-boundary tests.
- Workspace typecheck.
- Architecture check with zero violations.
- Lint with zero errors.
- Package-aware E2E against an E2E-flagged package built from the same committed source.

Repository-wide formatting retains unrelated baseline failures; task-changed files are formatted and `git diff --check` passes.

## 12. Package-aware E2E result

The E2E verified the packaged plugin assets and:

- Settings → Computer Use visible.
- Enable Computer Use succeeds without `Plugin not found`.
- Composer Computer Use setting remains consistent.
- Accessibility settings request crosses the packaged renderer/preload/main boundary.
- Screen Recording settings request crosses the same boundary.
- Active Stop and released projection remain covered.
- Final OS launch was mocked only at the last boundary to avoid changing the developer’s real System Settings.

The E2E used a separate E2E-flagged build; the release artifact is the non-E2E build.

## 13. Source gate results

- Pinned full workspace build under Node `24.14.0`: passed.
- `pnpm typecheck`: passed.
- `pnpm architecture:check --changed`: passed, zero violations.
- `pnpm lint`: passed, zero errors; existing warnings remain.
- Focused plugin/CUA/service/UI tests: passed.
- `git diff --check`: passed.
- Archive-aware candidate validation: passed for raw app, ZIP-contained app, and mounted DMG app.

## 14. Repair commits

- `08f8882` — `fix(cua): restore packaged enablement and permissions`
- `0519cca` — `fix(release): verify packaged CUA plugin path`
- `ab7c5b2` — `fix(ui): allow permission links before status settles`

## 15. Rebuilt candidate revision

```text
ab7c5b26
```

Build time embedded in the candidate:

```text
2026-09-24T12:53:29.354Z
```

## 16. Rebuilt DMG/ZIP paths

Release handoff:

- `release/0.1.0-alpha.1/handoff-cua-ab7c5b2/AceVra-0.1.0-alpha.1-arm64.dmg`
- `release/0.1.0-alpha.1/handoff-cua-ab7c5b2/AceVra-0.1.0-alpha.1-arm64.zip`

Raw build:

```text
release/0.1.0-alpha.1/build-cua-ab7c5b2/
```

## 17. Hashes

```text
e6be095395fe2b9b9e370102bb435b6345841609901c360e3ad0e15e83d36b9d  AceVra-0.1.0-alpha.1-arm64.dmg
42d071e1929f2feebb4f48f2b767ded770a173f04d7524f6bd95f77d539f8783  AceVra-0.1.0-alpha.1-arm64.zip
```

## 18. Validator result

`release:verify:candidate` returned:

```text
ok: true
errors: []
warnings: []
```

The validator checked the raw app, the ZIP-contained app, and the mounted DMG app. The packaged CUA plugin assets were present and the outer app used the stable local certificate-root signature.

## 19. Reinstall result

The exact `ab7c5b26` handoff app was installed to:

```text
/Applications/AceVra.app
```

The prior app was preserved at:

```text
/Applications/.AceVra.app.backup-f9da983d-9bc1-41a5-9ccd-38bf6e8d0c5a
```

Source and installed tree hashes matched.

## 20. Exact remaining manual clicks

The candidate is ready for the requested human verification. Please perform:

1. Open **Settings → Computer Use**.
2. Turn on **Enable Computer Use**.
3. Confirm no `Plugin not found` error appears.
4. Click **Open Accessibility Settings**.
5. Report whether System Settings opens to the Accessibility surface.
6. Return to AceVra.
7. Click **Open Screen Recording**.
8. Report whether System Settings opens to the Screen Recording surface.

Do not change TCC permissions yet. Broader CUA, physical interruption, browser, artifact, provider, remote, and restart acceptance remain intentionally paused.

**Decision: READY FOR HUMAN SETTINGS/ENABLEMENT VERIFICATION. Not yet ready to claim TCC or broader CUA acceptance.**
