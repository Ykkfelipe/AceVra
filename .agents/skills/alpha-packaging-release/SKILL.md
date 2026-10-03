---
name: alpha-packaging-release
description: "Use when packaging, validating, installing, or compacting the local AceVra alpha candidate (release/0.1.0-alpha.1 fixed artifact workspace). Encodes the exact command sequence, commit-ordering gotchas, install-from-ZIP fallback, and the never-delete artifact policy."
---

# Local alpha packaging & release playbook

Authoritative policy: `AGENTS.md` 「本地构建产物管理」 + `release/0.1.0-alpha.1/HOW_TO_UPDATE.md`.
Run everything from the repo root on `release/0.1.0-alpha`.

## 0. Before packaging

- All source gates GREEN first (report real results, never write failures as passes):

```bash
mise exec -- node scripts/mise-run.mjs pnpm typecheck      # root (does NOT cover CLI packages)
pnpm --dir apps/zcode-cli -r typecheck
pnpm architecture:check --changed                          # must end violations: 0 / new: 0
pnpm exec oxlint --config .oxlintrc.json <changed files>
pnpm exec oxfmt <changed files>                            # then --check to confirm
node --test packages/zcode-cua/test/*.test.mjs             # + the suites for layers you touched
```

- `git diff --check` must be clean. Beware: `pnpm exec oxfmt <directory>` can reformat
  UNRELATED files (e.g. `packages/ui/test/` in bulk) — pass explicit file lists and
  `git checkout --` accidental rewrites of files outside the task.

## 1. Package once (fixed workspace, clean-before-build)

```bash
pnpm artifacts:report                       # read-only before/after inventory
rm -rf release/0.1.0-alpha.1/build && mkdir -p release/0.1.0-alpha.1/build
ZCODE_ENV=production \
ZCODE_DESKTOP_RELEASE_PROFILE=local-engineering-alpha \
ZCODE_DESKTOP_DIST_DIR="/Users/felipemore/Projects/AceVra/release/0.1.0-alpha.1/build" \
mise exec -- node scripts/mise-run.mjs pnpm --filter @zcode/desktop bundle -- --os mac --arch arm64
# ZCODE_ENV=production is REQUIRED: unset falls back to `test` → Preview identity + _TEST suffix.
rm -rf release/0.1.0-alpha.1/validation
mise exec -- node scripts/mise-run.mjs pnpm release:verify:candidate -- \
  --build-dir "$PWD/release/0.1.0-alpha.1/build" \
  --validation-dir "$PWD/release/0.1.0-alpha.1/validation" --json     # final line MUST be [candidate] OK
cat packages/desktop/out/metadata/build-meta.json                     # note buildCommitId/buildTime
rm -rf release/0.1.0-alpha.1/handoff        # clear the previous candidate's five files first
mise exec -- node scripts/mise-run.mjs pnpm release:assemble:candidate -- \
  --build-dir "$PWD/release/0.1.0-alpha.1/build" \
  --validation-dir "$PWD/release/0.1.0-alpha.1/validation" \
  --handoff-dir "$PWD/release/0.1.0-alpha.1/handoff"
(cd release/0.1.0-alpha.1/handoff && shasum -a 256 -c SHA256SUMS.txt)  # both archives OK
```

## 2. Install

```bash
osascript -e 'quit app "AceVra"'; sleep 3
pgrep -fl '^/Applications/AceVra\.app/Contents/'      # must be empty (anchored: in-bundle processes only)
mise exec -- node scripts/mise-run.mjs pnpm release:accept:installed -- \
  --handoff "$PWD/release/0.1.0-alpha.1/handoff" \
  --source-app "$PWD/release/0.1.0-alpha.1/build/mac-arm64/AceVra.app" \
  --app /Applications/AceVra.app
git checkout -- apps/zcode-cli/packages/node-repl-host/dist-types   # builds mutate it; restore
open -a /Applications/AceVra.app
```

- **Install-from-ZIP fallback:** after `release:compact:candidate` the `build/mac-arm64`
  .app is GONE. `release:accept:installed` then fails on --source-app. Extract instead:
  `rm -rf /tmp/acevra-install && mkdir -p /tmp/acevra-install && ditto -x -k
release/0.1.0-alpha.1/handoff/AceVra-0.1.0-alpha.1-arm64.zip /tmp/acevra-install`
  and pass `/tmp/acevra-install/AceVra.app` as --source-app. Verify the install line
  `[installed] candidate installed transaction completed` (earlier a masked failure led to
  testing a stale app — always confirm).
- Provenance check: `grep -ac "<marker string>" /Applications/AceVra.app/Contents/Resources/app.asar`
  for renderer changes and `.../Resources/glm/zcode.cjs` (or
  `Resources/glm/packages/node-repl-host/dist/mcp/server.js`) for runtime changes.
  Binary-safe: `grep -ac` (count) not plain grep.

## 3. Commit ordering (mind the embedded label)

- Commit-then-package: `build-meta.json.buildCommitId` = the commit (preferred when the deck
  allows committing first).
- Package-then-commit (common deck order "package once … commit if accepted"): the label is
  the PREVIOUS HEAD; state that explicitly in the report — content is the uncommitted diff.

## 4. Compact + policy (after the candidate is verified)

```bash
mise exec -- node scripts/mise-run.mjs pnpm release:compact:candidate -- \
  --build-dir "$PWD/release/0.1.0-alpha.1/build" \
  --validation-dir "$PWD/release/0.1.0-alpha.1/validation" \
  --handoff-dir "$PWD/release/0.1.0-alpha.1/handoff"     # handoff is the ONLY persistent owner
pnpm artifacts:report
```

- Keep: one installed app + ONE rollback `/Applications/.AceVra.app.backup-*` (delete older
  ones by explicit path after the new candidate verifies) + one handoff set (DMG/ZIP + 3 sidecars).
- NEVER delete (any cleanup): source, `.git`, `node_modules`, userData/session data, local
  profiles, signing certs/keychain, TCC state, accepted test evidence/reports, `.spike/`.
- Delete transient build logs (`release/0.1.0-alpha.1/build-*.log`, `*-diag*.log`) once captured.

## 5. Gotchas that already bit once

- `pgrep` returning nothing ≠ failed pipeline: `pgrep -f X || true` masks real failures —
  check install output lines, not exit codes alone.
- Helper restarts: after reinstall, a stale `AceVraComputerUse` Helper process can serve an
  OLD binary; if a fresh method is "not available", quit the app AND check
  `pgrep -fl AceVraComputerUse` before diagnosing code.
- First launch after install is slow (login-shell env fallback, plugin registration) — live
  acceptance should wait for `data-desktop-business-ready` + ~10 s, and known intermittent
  first-launch behavior is documented in the `cua-system-map` skill.
