# AceVra 0.1.0-alpha.1 — fresh local alpha release handoff

**Status: READY FOR INSTALLED ACCEPTANCE — NOT YET DAILY-USE ACCEPTED**

This report covers the fresh candidate built from committed source. The earlier `repaired-build` candidate was rejected and was not reused. No installation, Gatekeeper approval, TCC authorization, physical interruption, browser, provider/account, remote, or restart acceptance was performed.

## 1. Commit SHAs

- `f767be2` — `fix(release): harden local alpha packaging pipeline`
- `e7704e7` — `fix(cua): unify foreground lease and stop safety`
- `d70197b8` — `fix(release): preserve precommit candidate evidence`

The candidate build metadata records source revision `d70197b8` and build time `2026-09-24T05:53:05.407Z`. The final report commit is recorded by the final Git handoff.

## 2. Outer signing root cause

Electron Builder’s macOS identity discovery uses `security find-identity` and does not treat the deliberately untrusted self-signed `AceVra CUA Dev Signing` certificate as a valid normal signing identity. On arm64, Electron Builder then intentionally falls back to identity `-`, producing an ad-hoc outer signature. The isolated keychain remains untrusted; no user/system trust setting or Apple Developer identity was added.

## 3. Final outer signature and designated requirement

The final outer app is certificate-signed, not ad-hoc:

```text
Identifier=com.acevra.desktop
Authority=AceVra CUA Dev Signing
TeamIdentifier=not set
Runtime Version=26.2.0
flags=0x10000(runtime)
designated => identifier "com.acevra.desktop" and certificate root = H"bf8f0f5130e10950f5a723ee77b8cad93951b56a"
```

The Helper and peer-probe designated requirements use the same certificate root. Developer ID signing and notarization remain deferred.

## 4. Foreground CUA regression fix

The duplicate, undeclared `pendingAuthorityLease` acquisition path was removed. The runtime now performs one authority reservation, passes both the authority lease ID and native Helper lease ID to `commitAcquire`, stores both IDs in its non-authoritative projection, and releases the Helper before releasing the service authority on model release, interruption, session close, and dispose.

Focused CUA/release tests: **138 passed, 0 failed**. Lease-authority tests: **5 passed, 0 failed**.

## 5. Software Stop design

Stop is a typed service command, not a model tool or raw desktop command. The service authority serializes Stop with admission, fences late commits, calls the narrow Helper-host `release_control` bridge with the native lease ID and owner credentials, waits for `lease_state: released`, and only then publishes the terminal projection. Repeated Stop returns `already_stopped` without another Helper release. The settings surface renders Stop only while the authoritative projection is active.

The installed runner and physical Helper behavior still require the separate human installed-acceptance phase.

## 6. E2E root cause and fix

The original E2E read the body immediately after `DOMContentLoaded`, launched a mutable shared build, did not navigate to Settings, started with empty tab state, encountered first-run gates, and the Computer Use section was explicitly hidden by the settings navigation denylist.

The guarded E2E now builds and verifies an isolated `local-engineering-alpha` artifact, waits for a business-root readiness marker, uses clean per-scenario data roots, seeds a harmless workspace tab, exposes the Computer Use section on desktop, and covers default-off/no Stop, active Stop, and released projection. The E2E passed.

## 7. Static gate isolation fix

Only generated output directories are ignored: canonical build/validation/handoff paths, repaired evidence paths, precommit evidence paths, and the fresh build transcript. Release Markdown/JSON remains visible to source gates. Generated repaired-build content is no longer linted or formatted as source.

## 8. Complete source-gate results

- Freshness: exit `0`; ahead 9 / behind 0.
- Pinned full workspace build under Node `24.14.0`: exit `0`.
- `pnpm typecheck`: exit `0`.
- `pnpm architecture:check --changed`: exit `0`, violations `0`, baseline `0`, new `0`.
- `pnpm lint`: exit `0`; existing repository warnings remain.
- `pnpm verify:pre-push`: exit `0`.
- `pnpm fmt:check`: exit `1` on 43 pre-existing baseline files; no task-changed file is in the failing list.
- `git diff --check`: exit `0`.
- CUA/release JavaScript suite: `138` passed, `0` failed.
- TypeScript lease-authority suite: `5` passed, `0` failed.
- Guarded Electron E2E: passed.

## 9. Fresh build revision and transcript

- Build revision: `d70197b8`
- Build directory: `release/0.1.0-alpha.1/build/`
- Complete transcript: `release/0.1.0-alpha.1/fresh-build.log`
- Raw builder metadata: `packages/desktop/out/metadata/build-meta.json`

The earlier precommit build was preserved under ignored `release/0.1.0-alpha.1/precommit-build/` and was not used as final evidence.

## 10. Fresh DMG path

`release/0.1.0-alpha.1/handoff/AceVra-0.1.0-alpha.1-arm64.dmg`

Raw build copy: `release/0.1.0-alpha.1/build/AceVra-0.1.0-alpha.1-arm64.dmg`

## 11. Fresh ZIP path

`release/0.1.0-alpha.1/handoff/AceVra-0.1.0-alpha.1-arm64.zip`

Raw build copy: `release/0.1.0-alpha.1/build/AceVra-0.1.0-alpha.1-arm64.zip`

## 12. SHA256 hashes

```text
5a8b18a77148dda426e94cd882184bdbe52f02f768816181abd206ba28575b44  AceVra-0.1.0-alpha.1-arm64.dmg
badcb722f03ffbb1676b8f210b7e9de62649ddcf289a8e6e72c3dcf42abc0c90  AceVra-0.1.0-alpha.1-arm64.zip
```

`hdiutil verify` reported a valid DMG checksum. `unzip -t` reported no errors.

## 13. Candidate-validator result

`release:verify:candidate` returned `ok: true` with zero errors and zero warnings. It verified product identity, `com.acevra.desktop`, version `0.1.0-alpha.1`, arm64 architecture, stable local outer signature/DR, signed Helper and peer probe, native component identities, release profile, and content scan.

## 14. Secret/path scan result

The independent final scan returned no findings for either representation:

```text
DMG-mounted AceVra.app: []
ZIP-extracted AceVra.app: []
```

No credentials, private keys, keychains, cookies, personal files, developer absolute paths, or `/tmp` runtime dependencies were found in the scanned app contents.

## 15. Exact handoff contents

`release/0.1.0-alpha.1/handoff/` contains exactly:

1. `AceVra-0.1.0-alpha.1-arm64.dmg`
2. `AceVra-0.1.0-alpha.1-arm64.zip`
3. `build-info.json`
4. `RELEASE_NOTES.md`
5. `SHA256SUMS.txt`

## 16. Installed-acceptance-runner readiness

The runner now verifies exact handoff contents and checksums, candidate provenance, existing-target provenance, running-process refusal, backup/staging hashes, strict signatures, atomic replacement, and rollback. Fixture tests passed. It was **not executed against `/Applications`**.

## 17. Exact remaining human checkpoints

After the user explicitly starts installed acceptance:

- Gatekeeper/Open Anyway decision
- Accessibility permission
- Screen Recording permission
- Input Monitoring experiment, only if functionally required
- Explicit software Stop and repeated Stop in the installed app
- Real physical mouse movement interruption
- Real Shift press/release interruption
- Packaged Helper launch and native identity
- Installed CUA, browser, artifact, provider/account, remote, and restart/persistence regressions

## 18. Daily-use and public-distribution readiness

- **Daily use:** Not yet accepted. The candidate is ready for the human installed-acceptance phase only.
- **Public distribution:** Not ready. Developer ID signing, notarization, stapling, and public Gatekeeper trust are deferred.

## 19. Final decision

**READY FOR INSTALLED ACCEPTANCE.**

Do not install or distribute automatically. The next action requires explicit human authorization for the installed acceptance phase.
