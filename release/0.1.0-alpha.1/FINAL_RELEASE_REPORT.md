# AceVra 0.1.0-alpha.1 — isolated alpha permission repair handoff

**Status: REPAIRED CANDIDATE INSTALLED; READY FOR HUMAN SETTINGS/ENABLEMENT VERIFICATION**

The prior installed candidate was `ab7c5b26`. It was preserved and replaced with the new `1479bf4c` candidate through the tested backup/staging/rollback runner.

## 1. Missing-plugin root cause

The canonical UI toggle used `computer-use@zcode-plugins-official`, but the earlier packaged candidate did not contain the loadable official CUA plugin. The repair adds the official plugin package, manifest, docs, client, and skill, and stages them under `Resources/glm/packages/zcode-cua-plugin`.

## 2. Intended enablement architecture

Computer Use is default-off and is enabled through the canonical official plugin configuration. The plugin is the enablement/skill layer; `@zcode/zcode-cua` remains the native Helper/broker/lease authority. The repair does not create a second Helper, socket, lease authority, or TCC subject.

## 3. Legacy plugin dependency

The canonical dependency is now bundled and discoverable. The legacy `zcode-cua@zcode-plugins-official` ID remains internally supported, but normal users use `computer-use@zcode-plugins-official`.

## 4. Composer button impact

Composer visibility continues to depend on the same authoritative plugin state. The E2E verifies that enabling Computer Use and enabling the composer setting remain consistent; the composer never bypasses the authoritative toggle.

## 5. Accessibility-link root cause

The settings-row handler performed status retries before opening a hardcoded pane and silently returned while another permission operation was active. That caused the lag and dropped second click. The repair opens the requested pane immediately through the existing preload/main bridge.

## 6. Screen Recording-link root cause

Screen Recording shared the same status gate and active-operation guard. It now follows the same immediate, serialized permission-link path.

## 7. macOS settings-opening implementation

The existing Electron `shell.openExternal` path is preserved. Exact Accessibility/Screen Recording URLs are attempted first, with a broader supported `x-apple.systempreferences:com.apple.preference.security` fallback. Launch failures are typed and visible; no shell command is assembled from user input.

## 8. Permission-status source

`permission_status` is relayed through the same admitted `AceVra Computer Use.app` Helper transport. The product host now waits for Helper admission before `start()` resolves, and status reuses that admitted session instead of starting a second hardened session.

## 9. TCC owner identity

```text
AceVra Computer Use.app
bundle ID: dev.acevra.cua-helper
path: AceVra.app/Contents/Resources/cua-helper/AceVra Computer Use.app
```

The outer `AceVra.app` is not presented as the TCC subject. Input Monitoring was not added.

## 10. Refresh/recheck behavior

The existing focus, return, Helper-restart, and permission-store refresh paths remain. Permission rows open even when status is unavailable or settling. A visible Re-check permissions action remains available. Plugin-disabled, Helper-unavailable, and native unknown are no longer conflated.

## 11. Tests

Passed:

- Official plugin package and seed tests.
- Plugin default-off/canonical/legacy enablement tests.
- Desktop/SEA packaging inclusion and packaged-asset verifier tests.
- Isolated `ZCODE_HOME` config-authority test.
- Product Helper admission and `permission_status` transport tests.
- Service permission projection tests.
- macOS settings fallback and failure tests.
- Focused CUA packaging-boundary tests.
- Pinned full workspace build under Node `24.14.0`.
- Typecheck.
- Architecture check with zero violations.
- Lint with zero errors.
- Package-aware E2E with distinct HOME and ZCODE_HOME roots.

The E2E verified packaged plugin assets, real UI enablement without `Plugin not found`, isolated config persistence, composer consistency, Accessibility/Screen Recording packaged bridge calls, active Stop, and released projection. The final OS launch was mocked only at the last E2E boundary.

## 12. Source-gate results

All required source gates passed. Repository-wide formatting retains unrelated baseline debt; task-changed files are formatted and `git diff --check` passes.

## 13. Repair commits

- `08f8882` — packaged CUA plugin and initial permission repair
- `0519cca` — packaged plugin path verifier
- `ab7c5b2` — permission links available before status settles
- `1479bf4` — isolated alpha config authority and Helper admission ordering

## 14. Rebuilt candidate revision

```text
1479bf4c
```

Embedded build time:

```text
2026-09-24T13:49:30.083Z
```

## 15. Rebuilt DMG/ZIP paths

```text
release/0.1.0-alpha.1/handoff-cua-1479bf4/AceVra-0.1.0-alpha.1-arm64.dmg
release/0.1.0-alpha.1/handoff-cua-1479bf4/AceVra-0.1.0-alpha.1-arm64.zip
```

Raw build:

```text
release/0.1.0-alpha.1/build-cua-1479bf4/
```

## 16. Hashes

```text
dd19725ac7532342794e42aa365133430838b803302bd424efb432bcaa54ef8c  AceVra-0.1.0-alpha.1-arm64.dmg
d14c4d059ae91ec6c1ac43ac3f21db7353af0e7e3810ae98e82a0393035d8e38  AceVra-0.1.0-alpha.1-arm64.zip
```

## 17. Validator result

`release:verify:candidate` returned:

```text
ok: true
errors: []
warnings: []
```

The raw app, ZIP-contained app, and mounted DMG app all passed the archive-aware validator, including the packaged CUA plugin tree and stable outer/Helper signatures.

## 18. Reinstall result

Installed path:

```text
/Applications/AceVra.app
```

Previous app backup:

```text
/Applications/.AceVra.app.backup-cfac4eea-f717-4872-b329-fc791a69c6ce
```

Source and installed tree hashes matched. The installed app reports `1479bf4c`, `local-engineering-alpha`, and `AceVra CUA Dev Signing`.

## 19. Exact remaining manual clicks

1. Open **Settings → Computer Use**.
2. Turn on **Enable Computer Use**.
3. Confirm no `Plugin not found` error appears.
4. Confirm the page does not show a false **Helper unavailable** state before the Helper is actually admitted.
5. Click **Open Accessibility Settings**.
6. Report whether System Settings opens to the Accessibility surface.
7. Return to AceVra.
8. Click **Open Screen Recording**.
9. Report whether System Settings opens to the Screen Recording surface.

Do not change TCC permissions yet.

## 20. Decision

**READY FOR HUMAN SETTINGS/ENABLEMENT VERIFICATION.**

Do not claim TCC acceptance, installed CUA acceptance, physical interruption, browser, artifact, provider/account, remote, or restart acceptance yet. No publish, tag, merge, CUA-4, or CUA-5 action is authorized.
