# How to update the installed AceVra alpha yourself

Use this when you have new source changes on `release/0.1.0-alpha` and want them in
`/Applications/AceVra.app`. The safe path is always:

```text
commit → build → validate → assemble handoff → close AceVra → install → open
```

Do not copy `AceVra.app` manually and do not use `xattr` to bypass Gatekeeper.

## Artifact storage policy (fixed workspace)

All local alpha packaging uses ONE reusable workspace; reinitialize it before every run and
build the new candidate into the same paths:

```text
release/0.1.0-alpha.1/build/
release/0.1.0-alpha.1/validation/
release/0.1.0-alpha.1/handoff/
```

- Do NOT create `build-<sha>/`, `candidate-<sha>/`, `validation-<sha>/`, `handoff-<sha>/`, or
  timestamped equivalents for ordinary iterative builds. Git is the historical record; compiled
  artifacts are disposable. The authoritative rule lives in `AGENTS.md`（本地构建产物管理）.
- Clean-before-build: remove/reinitialize the three fixed directories before each packaging run.
  Never delete source files, `node_modules`, caches, or signing assets as part of this cleanup.
- Installed app: keep `/Applications/AceVra.app` plus at most ONE rollback copy of the
  immediately previous known-good app (a hidden `/Applications/.AceVra.app.backup-*`). After a
  newly installed candidate is verified, delete every rollback older than one generation.
- DMG/ZIP: keep only the newest local handoff artifacts for the current candidate (current
  arm64 DMG, plus the arm64 ZIP when the pipeline produces both). Delete or reuse previous
  outputs once the replacement candidate has passed validation; do not accumulate same-named
  copies in alternate directories.
- Same-generation ownership: **`handoff/` is the sole persistent owner of the final local
  distribution archives.** `build/` may hold intermediate build products only, and
  `validation/` holds reports, manifests, and checksums only — never a persistent `.app`, DMG,
  or ZIP copy. Validation runs in place against the build output (archives are checked in a
  self-cleaning temp dir); after `[candidate] OK`, a verified installation, and verified
  handoff checksums, compact the redundant build/validation copies with
  `pnpm release:compact:candidate` (step 11). Fixed directories prevent historical
  accumulation; compaction removes same-generation duplication.
- Diagnostic builds: temporary instrumented trees must be deleted after evidence is collected,
  diagnostics are reverted, and a clean candidate has been rebuilt.
- Before each packaging run, inventory sizes, stale generations, and same-generation duplicate
  copies with:

```bash
pnpm artifacts:report
```

It is read-only (it never deletes) and it never fails ordinary source development.

## 0. One-time assumptions

Run commands from:

```bash
cd /Users/felipemore/Projects/AceVra
```

Node is pinned through `mise`. The isolated local alpha uses:

- profile: `local-engineering-alpha`
- bundle ID: `com.acevra.desktop`
- installed app: `/Applications/AceVra.app`

## 1. Put your changes into a commit

The packaged app embeds the current Git commit ID. If you build with uncommitted changes, the
installed app will still report the older commit, which makes provenance confusing.

```bash
git status --short
git add <your-files>
git commit -m "feat(ui): describe your change"
```

If you only want to try changes without installing them, run the development app instead:

```bash
pnpm dev:desktop
```

## 2. Run the quick source gates

```bash
node scripts/check-workspace-freshness.mjs
mise exec -- node scripts/mise-run.mjs pnpm typecheck
mise exec -- node scripts/mise-run.mjs pnpm lint
mise exec -- node scripts/mise-run.mjs pnpm architecture:check --changed
pnpm artifacts:report
```

All three `pnpm` gates must pass before you package. The artifact report is informational:
act on its stale-generation warnings (see section 11), but a large `node_modules` is never a
failure.

## 3. Note the build label

The packaged app embeds the commit ID; record it for provenance and build-meta checks:

```bash
LABEL=$(git rev-parse --short HEAD)
echo "$LABEL"
```

Paths no longer include the label — everything goes into the fixed workspace.

## 4. Build a fresh candidate into the fixed build workspace

```bash
rm -rf "release/0.1.0-alpha.1/build"
mkdir -p "release/0.1.0-alpha.1/build"

ZCODE_DESKTOP_RELEASE_PROFILE=local-engineering-alpha \
ZCODE_DESKTOP_DIST_DIR="/Users/felipemore/Projects/AceVra/release/0.1.0-alpha.1/build" \
mise exec -- node scripts/mise-run.mjs pnpm --filter @zcode/desktop bundle -- --os mac --arch arm64
```

This creates:

```text
release/0.1.0-alpha.1/build/mac-arm64/AceVra.app
release/0.1.0-alpha.1/build/AceVra-0.1.0-alpha.1-arm64.dmg
release/0.1.0-alpha.1/build/AceVra-0.1.0-alpha.1-arm64.zip
```

## 5. Validate the candidate

```bash
rm -rf "release/0.1.0-alpha.1/validation"

mise exec -- node scripts/mise-run.mjs pnpm release:verify:candidate -- \
  --build-dir "/Users/felipemore/Projects/AceVra/release/0.1.0-alpha.1/build" \
  --validation-dir "/Users/felipemore/Projects/AceVra/release/0.1.0-alpha.1/validation" \
  --json
```

The final line must say:

```text
[candidate] OK
```

`validation/` now receives reports only (`build-info.json`, `RELEASE_NOTES.md`,
`SHA256SUMS.txt`). The `.app`, DMG, and ZIP are validated in place from `build/` (archives are
unpacked/mounted in a self-cleaning temp dir), so no same-generation copy is created.

## 6. Record the exact embedded revision

Read the build metadata:

```bash
cat packages/desktop/out/metadata/build-meta.json
```

You should see the commit and time from the build you just made, for example:

```json
{
  "buildCommitId": "48bea3cb",
  "buildTime": "2026-09-24T15:59:47.638Z"
}
```

Open:

```text
release/0.1.0-alpha.1/validation/build-info.json
```

Make sure these fields exist at the top and match `build-meta.json`:

```json
{
  "schemaVersion": 4,
  "buildCommitId": "<the eight-character value from build-meta.json>",
  "buildTime": "<the exact buildTime from build-meta.json>"
}
```

## 7. Assemble the exact handoff

```bash
rm -rf "release/0.1.0-alpha.1/handoff"

mise exec -- node scripts/mise-run.mjs pnpm release:assemble:candidate -- \
  --build-dir "/Users/felipemore/Projects/AceVra/release/0.1.0-alpha.1/build" \
  --validation-dir "/Users/felipemore/Projects/AceVra/release/0.1.0-alpha.1/validation" \
  --handoff-dir "/Users/felipemore/Projects/AceVra/release/0.1.0-alpha.1/handoff"
```

Archives are taken from `build/` and hardlinked into `handoff/` when both live on the same
volume (no second physical copy); the handoff later becomes the only surviving name once
step 11 compacts the build output. Report sidecars come from `validation/`.

The handoff must contain exactly five files:

```text
AceVra-0.1.0-alpha.1-arm64.dmg
AceVra-0.1.0-alpha.1-arm64.zip
build-info.json
RELEASE_NOTES.md
SHA256SUMS.txt
```

Check the archives:

```bash
cd "release/0.1.0-alpha.1/handoff"
shasum -a 256 -c SHA256SUMS.txt
cd -
```

Both lines must say `OK`.

## 8. Close AceVra

Quit AceVra normally with **Cmd+Q** or **AceVra → Quit AceVra**.

Confirm it is fully closed:

```bash
pgrep -fl 'AceVra Local Engineering Alpha|/Applications/AceVra.app/Contents/MacOS' || true
```

No output means it is closed. Do not install while AceVra is running.

## 9. Install with backup and rollback

```bash
mise exec -- node scripts/mise-run.mjs pnpm release:accept:installed -- \
  --handoff "/Users/felipemore/Projects/AceVra/release/0.1.0-alpha.1/handoff" \
  --source-app "/Users/felipemore/Projects/AceVra/release/0.1.0-alpha.1/build/mac-arm64/AceVra.app" \
  --app "/Applications/AceVra.app"
```

On success it prints a backup path like:

```text
backup=/Applications/.AceVra.app.backup-<uuid>
```

That backup is the previous known-good app. Keep it (and only it) until you have confirmed the
new app works.

## 10. Open the updated app

```bash
open -a /Applications/AceVra.app
```

Optional provenance check:

```bash
node - <<'NODE'
const asar = require('@electron/asar');
const data = asar.extractFile(
  '/Applications/AceVra.app/Contents/Resources/app.asar',
  'out/metadata/build-meta.json',
);
process.stdout.write(data.toString());
NODE
```

The installed `buildCommitId` should match the commit you built.

## 11. Cleanup after the new app works

Once you have verified the new app (installation verified + `shasum -a 256 -c` on the handoff
passed), reclaim the previous generation **and compact same-generation duplicates**
(path-scoped, conservative):

```bash
# 1. Same-generation compaction: after a verified install, build/ and validation/ must not
#    retain .app/DMG/ZIP copies. Refuses to run unless the handoff five-file set verifies.
mise exec -- node scripts/mise-run.mjs pnpm release:compact:candidate -- \
  --build-dir "release/0.1.0-alpha.1/build" \
  --validation-dir "release/0.1.0-alpha.1/validation" \
  --handoff-dir "release/0.1.0-alpha.1/handoff"

# 2. Rollbacks: keep exactly ONE — the most recent hidden backup — delete the rest.
ls -dut /Applications/.AceVra.app.backup-* | tail -n +2 | xargs rm -rf

# 3. Confirm no stale generations and no same-generation duplicate copies remain.
pnpm artifacts:report
```

`pnpm release:compact:candidate` removes only fixed allowlist paths: the build app tree
(`build/mac-arm64/`), the build-side DMG/ZIP/blockmaps (mere names when hardlinked into the
handoff), and any legacy `AceVra.app`/DMG/ZIP copies inside `validation/`. Reports, logs,
manifests, and checksums stay. Do not run it before the installation is verified.

`pnpm artifacts:report` warns about both stale generations (`build-*/`, `validation-*/`,
`handoff-*/`, `candidate-*/`, timestamped equivalents) and **same-generation duplicate physical
copies** across `build/`+`validation/`+`handoff/`; delete what it lists unless an active
investigation needs the tree.

Never delete as part of artifact cleanup: source code, `.git`, `node_modules`, userData or
conversation data, local profile data, signing certificates/keychains, TCC state, accepted test
evidence or reports, `.spike/`, or tracked files under `release/0.1.0-alpha.1/` (release notes,
reports, logs, checksums). If an item is not clearly a disposable artifact, leave it and ask.

## If something looks wrong

Close AceVra and restore the retained hidden backup (it contains the previous installed app):

```bash
pgrep -fl 'AceVra Local Engineering Alpha|/Applications/AceVra.app/Contents/MacOS' || true
rm -rf /Applications/AceVra.app
mv /Applications/.AceVra.app.backup-<uuid-of-newest-backup> /Applications/AceVra.app
open -a /Applications/AceVra.app
```

Only do this with the newest backup — older ones should already have been deleted in step 11.
If you have no backup left, stop and ask before deleting or replacing `/Applications/AceVra.app`.

## Rules

- Never install while AceVra is running.
- Never install directly from an unvalidated raw build directory.
- Never use `sudo xattr -rd com.apple.quarantine` as an install workflow.
- Keep at most one `/Applications/.AceVra.app.backup-*`; delete older ones after the new
  candidate is verified.
- `handoff/` is the sole persistent owner of the final DMG/ZIP; compact same-generation copies
  out of `build/` and `validation/` after a verified install, and never copy a 500–600 MB `.app`
  just to validate it.
- Do not commit generated `.dmg`, `.zip`, app bundles, signing keys, keychains, or passwords.
- Do not rename `com.acevra.desktop`, `dev.acevra.cua-helper`, or the stable `zcode` backend value.
