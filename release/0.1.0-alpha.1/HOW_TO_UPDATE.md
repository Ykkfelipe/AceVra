# How to update the installed AceVra alpha yourself

Use this when you have new source changes on `release/0.1.0-alpha` and want them in
`/Applications/AceVra.app`. The safe path is always:

```text
commit → build → validate → assemble handoff → close AceVra → install → open
```

Do not copy `AceVra.app` manually and do not use `xattr` to bypass Gatekeeper.

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
```

All three `pnpm` gates must pass before you package.

## 3. Choose a build label

Use the short commit when possible:

```bash
LABEL=$(git rev-parse --short HEAD)
echo "$LABEL"
```

The examples below use `$LABEL`.

## 4. Build a fresh no-clobber candidate

```bash
rm -rf "release/0.1.0-alpha.1/build-cua-$LABEL"

ZCODE_DESKTOP_RELEASE_PROFILE=local-engineering-alpha \
ZCODE_DESKTOP_DIST_DIR="/Users/felipemore/Projects/AceVra/release/0.1.0-alpha.1/build-cua-$LABEL" \
mise exec -- node scripts/mise-run.mjs pnpm --filter @zcode/desktop bundle -- --os mac --arch arm64
```

This creates:

```text
release/0.1.0-alpha.1/build-cua-$LABEL/mac-arm64/AceVra.app
release/0.1.0-alpha.1/build-cua-$LABEL/AceVra-0.1.0-alpha.1-arm64.dmg
release/0.1.0-alpha.1/build-cua-$LABEL/AceVra-0.1.0-alpha.1-arm64.zip
```

## 5. Validate the candidate

```bash
rm -rf "release/0.1.0-alpha.1/validation-cua-$LABEL"

mise exec -- node scripts/mise-run.mjs pnpm release:verify:candidate -- \
  --build-dir "/Users/felipemore/Projects/AceVra/release/0.1.0-alpha.1/build-cua-$LABEL" \
  --validation-dir "/Users/felipemore/Projects/AceVra/release/0.1.0-alpha.1/validation-cua-$LABEL" \
  --json
```

The final line must say:

```text
[candidate] OK
```

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
release/0.1.0-alpha.1/validation-cua-$LABEL/build-info.json
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
rm -rf "release/0.1.0-alpha.1/handoff-final-$LABEL"

mise exec -- node scripts/mise-run.mjs pnpm release:assemble:candidate -- \
  --validation-dir "/Users/felipemore/Projects/AceVra/release/0.1.0-alpha.1/validation-cua-$LABEL" \
  --handoff-dir "/Users/felipemore/Projects/AceVra/release/0.1.0-alpha.1/handoff-final-$LABEL"
```

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
cd "release/0.1.0-alpha.1/handoff-final-$LABEL"
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
  --handoff "/Users/felipemore/Projects/AceVra/release/0.1.0-alpha.1/handoff-final-$LABEL" \
  --source-app "/Users/felipemore/Projects/AceVra/release/0.1.0-alpha.1/build-cua-$LABEL/mac-arm64/AceVra.app" \
  --app "/Applications/AceVra.app"
```

On success it prints a backup path like:

```text
backup=/Applications/.AceVra.app.backup-<uuid>
```

Keep that backup until you have confirmed the new app works.

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

## 11. Optional cleanup after the new app works

Only after you have verified the new app:

```bash
rm -rf \
  "release/0.1.0-alpha.1/build-cua-<old-label>" \
  "release/0.1.0-alpha.1/validation-cua-<old-label>" \
  "release/0.1.0-alpha.1/handoff-final-<old-label>"
```

Never delete:

```text
/Applications/.AceVra.app.backup-*
```

until you are sure you will not need the old version.

## If something looks wrong

Close AceVra and reinstall the backup using the same runner pattern:

```bash
mise exec -- node scripts/mise-run.mjs pnpm release:accept:installed -- \
  --handoff "/Users/felipemore/Projects/AceVra/release/0.1.0-alpha.1/handoff-final-<known-good-label>" \
  --source-app "/Users/felipemore/Projects/AceVra/release/0.1.0-alpha.1/build-cua-<known-good-label>/mac-arm64/AceVra.app" \
  --app "/Applications/AceVra.app"
```

If you do not have the known-good handoff anymore, stop and ask before deleting or replacing
`/Applications/AceVra.app`; the hidden backup still contains the previous installed app.

## Rules

- Never install while AceVra is running.
- Never install directly from an unvalidated raw build directory.
- Never use `sudo xattr -rd com.apple.quarantine` as an install workflow.
- Never delete backups automatically.
- Do not commit generated `.dmg`, `.zip`, app bundles, signing keys, keychains, or passwords.
- Do not rename `com.acevra.desktop`, `dev.acevra.cua-helper`, or the stable `zcode` backend value.
