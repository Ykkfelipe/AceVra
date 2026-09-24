# AceVra 0.1.0-alpha.1 — repaired installed-candidate report

**Status: INSTALLED CANDIDATE VERIFIED; READY TO CONTINUE HUMAN INSTALLED ACCEPTANCE**

The stale installed app was `fff67d4b`, ad-hoc signed, and did not contain the repaired renderer. It was preserved and replaced through the tested backup/staging/rollback runner with the exact repaired candidate built from `49d5fd6`.

## 1. Installed-app provenance

- Installed path: `/Applications/AceVra.app`
- Bundle ID: `com.acevra.desktop`
- Version: `0.1.0-alpha.1`
- Embedded build commit: `49d5fd6d`
- Release profile: `local-engineering-alpha`
- Outer signer: `AceVra CUA Dev Signing`
- Outer DR: `identifier "com.acevra.desktop" and certificate root = H"bf8f0f5130e10950f5a723ee77b8cad93951b56a"`
- Helper DR uses the same certificate root.
- Previous stale app backup: `/Applications/.AceVra.app.backup-13155475-8ea0-45aa-b197-3533201bec5b`

## 2. Exact-candidate reproduction result

The defect was not reproduced against the correct repaired candidate:

- Settings visibly contained `Computer Use` between Browser Use and Keyboard Shortcuts.
- Clicking the visible Computer Use entry mounted the real page.
- The page rendered the alpha safety copy, Computer Use enablement, composer-entry control, Accessibility, and Screen Recording status from the service projection.
- No active exclusive lease was present, so Stop was correctly hidden.
- Codex scan found 44 candidates and rendered meaningful first-user-message titles plus Preview controls.
- Expanding the first candidate showed bounded `User` and `Assistant` text before import.

The old installed copy had produced the original observations because it was a different artifact, not because the repaired renderer lacked the page.

## 3. Computer Use menu root cause

The old installed app embedded `fff67d4b`, whose renderer still hid `computerUse` in `HIDDEN_SETTINGS_SECTIONS`. The prior E2E only rebuilt and launched `packages/desktop/out`; it never launched or inspected the packaged app that the user opened. The repaired source keeps `computerUse` enabled for desktop Settings while retaining platform/content gating for unsupported environments.

## 4. Computer Use UI fix

The existing current-source navigation fix is now present in the installed candidate. The E2E was changed to:

- read packaged `app.asar` build metadata;
- require the expected `local-engineering-alpha` profile and commit;
- launch the packaged app executable through Playwright;
- click the real Settings button and the visible Computer Use navigation item;
- assert the real page and active-only Stop behavior.

The Computer Use page uses the existing service permission/control projection. No raw Helper command was added to React and no CUA-4 functionality was introduced.

## 5. Permission UX now exposed

The installed page exposed:

- Computer Use enablement state.
- Accessibility status: `Unknown` in this run.
- Screen Recording status: `Unknown` in this run.
- Existing permission actions and service-backed refresh behavior.
- No Input Monitoring requirement was fabricated.

No TCC permission was changed during this reproduction.

## 6. E2E false-positive root cause

The old E2E passed against a fresh `out` renderer while the installed app was an older package. It did not verify embedded build metadata, packaged `app.asar`, or the packaged executable. The new package-aware E2E closes that gap.

## 7. E2E repair result

A separately flagged E2E package built from the same committed source was launched through the packaged-app path. It passed:

- business-root readiness;
- real Settings navigation;
- visible Computer Use entry;
- default-off/no Stop;
- active Stop;
- released projection.

The E2E package is test evidence only, not the release artifact.

## 8. Codex candidate-preview design

Codex scan now calls the existing sanitized rollout parser in bounded preview mode. Candidate data is transient and contains only:

- first visible user message;
- first visible assistant message when present;
- a short bounded title;
- existing workspace/date/session metadata.

The full import path still uses the same parser in full mode. Preview data is not persisted into imported history.

## 9. Title derivation

The title is derived locally from the first meaningful visible user message using the existing bounded title behavior. If no user message exists, the UI falls back to a short session ID. No model or provider call is used.

## 10. Expanded-preview behavior

The Preview control expands a candidate in local UI state and shows bounded, escaped User/Assistant text. It does not reread the transcript, import automatically, call a model, or expose raw records. The installed reproduction showed both roles in the expanded first candidate.

## 11. Privacy/redaction guarantees

Preview extraction only admits the existing visible user/assistant text types. It excludes reasoning, tool calls/results, metadata, hidden/system content, credentials, `auth.json`, and raw transcript records. UI rendering uses plain escaped React text; it does not use Markdown or `dangerouslySetInnerHTML`. Workspace paths remain local-only and are not sent to an external service.

## 12. Claude preview parity

Deferred. The shared UI is ready for future Claude preview fields, but the existing Claude head parser was not expanded in this repair because doing so safely requires a separate sanitized-extraction cleanup. No Claude scanning behavior was changed.

## 13. Test results

- Codex history preview tests: **3 passed**.
- Codex/lease focused TypeScript tests: **8 passed**.
- Installed-runner and release-validator tests: **8 passed** across the focused release test run.
- Package-aware packaged E2E: **passed**.
- Full pinned workspace build: **passed**.
- `pnpm typecheck`: **passed**.
- `pnpm architecture:check --changed`: **passed**, zero violations.
- `pnpm lint`: **passed** with existing repository warnings and zero errors.
- `git diff --check`: **passed**.
- `pnpm fmt:check`: **still exits 1 on the repository’s pre-existing formatting baseline; changed files were formatted and are not the source of the new failures.**

## 14. Source-gate results

The release candidate was not accepted until the new archive-signing fix was in place. The final candidate build used the pinned Node 24.14.0 toolchain, completed the full workspace build, and passed the strengthened validator against:

- the unpacked app;
- the ZIP-contained app;
- the mounted DMG app.

The old post-build-only signing path was insufficient because it ran after archive creation. The new `afterSign` hook signs before DMG/ZIP creation, and the validator now rejects ad-hoc app content inside either archive.

## 15. Repair commit SHAs

- `7b9b12a` — `fix(release): sign archives before packaging`
- `767e0fe` — `feat(accounts): preview Codex sessions before import`
- `cb6e28f` — `fix(test): validate packaged CUA navigation`
- `49d5fd6` — `fix(release): preserve app signatures during install`
- `8b917e8` — `fix(release): canonicalize app tree paths`

The packaged candidate source revision is `49d5fd6`. The final runner hardening commit is release tooling after the packaged runtime build and does not alter the app contents.

## 16. Rebuilt candidate source revision

`49d5fd6d` (embedded metadata)
Build time: `2026-09-24T11:42:58.816Z`

## 17. Rebuilt DMG/ZIP paths

Final handoff:

- `release/0.1.0-alpha.1/handoff-final-49d5fd6/AceVra-0.1.0-alpha.1-arm64.dmg`
- `release/0.1.0-alpha.1/handoff-final-49d5fd6/AceVra-0.1.0-alpha.1-arm64.zip`

Raw build:

- `release/0.1.0-alpha.1/build-final-49d5fd6/`

## 18. Hashes

```text
b0bafdc4184308731b390f3b1153ca495483ccb19a18c625e2aaa9f54f31212a  AceVra-0.1.0-alpha.1-arm64.dmg
bf29e846bdddb03c45789b4898c26c8499927f5b539dbf2ecd824ef67cbe6421  AceVra-0.1.0-alpha.1-arm64.zip
```

The handoff `SHA256SUMS.txt` verification passed.

## 19. Validator result

`release:verify:candidate` returned:

```text
ok: true
errors: []
warnings: []
```

It verified the raw app, ZIP app, and mounted DMG app. Both archives contain the certificate-root-anchored outer app, not the earlier ad-hoc app.

## 20. Reinstall result

The exact final handoff app was installed through the tested runner.

- Previous stale app was preserved in a unique backup.
- Source and installed tree hashes matched.
- Installed app was verified after the atomic swap.
- The old backup was not deleted.

## 21. Installed Computer Use menu proof

The installed app’s real Settings tree showed:

```text
General
Appearance
Model settings
Browser Use
Computer Use
Keyboard Shortcuts
...
```

Clicking the visible Computer Use entry mounted the real page. This is installed-app evidence, not source/dev evidence.

## 22. Installed Codex preview proof

The installed app’s real Codex account page was opened, `Scan sessions` was activated, and 44 candidates appeared. Candidate cards showed meaningful first-user-message text and Preview buttons. Expanding the first card showed bounded User and Assistant text before import. No import was performed.

The account status displayed `Not connected` during this run, so account/provider acceptance is not claimed.

## 23. Remaining human/TCC acceptance checkpoints

Formal broader installed acceptance has not started. Remaining checkpoints are:

- fresh Gatekeeper/Open Anyway proof;
- Accessibility permission;
- Screen Recording permission;
- Input Monitoring experiment if functionally required;
- packaged Helper admission and CUA runtime;
- background semantic CUA;
- exclusive CUA and software Stop;
- held-input cleanup;
- real physical mouse interruption;
- real Shift press/release interruption;
- browser regression;
- artifact regression;
- provider/account regression;
- existing remote-feature regression;
- restart/persistence;
- no-dev-dependency proof;
- separate human decision about retaining or removing the backup.

## 24. Final decision

**READY TO CONTINUE INSTALLED ACCEPTANCE.**

The two requested installed UX defects are repaired and manually reproduced as fixed against the exact installed candidate. Do not publish, tag, merge, or begin CUA-4/CUA-5. Broader installed acceptance remains gated on the human checkpoints above.
