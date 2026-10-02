# AceVra Parallel Development / Build & Storage Policy

> Purpose: make AceVra development feel like normal web development: keep a live dev app while coding, use isolated worktrees for parallel workers, and only create a heavyweight packaged app when the user explicitly wants a real build.

## Core rule

**Development and packaging are separate.**

Normal development:

```text
edit source
→ dev/watch mode updates the running app
→ targeted checks
→ commit
```

Packaging:

```text
explicit checkpoint/release request
→ broader verification
→ one intentional packaged AceVra build
→ remove obsolete packaging output
```

Do **not** rebuild/package AceVra after every code change.

---

## 1. One worker = one feature branch + one worktree

- Never point two code-writing workers at the same physical checkout.
- Give each active feature worker its own Git branch and Git worktree.
- Roadmap branches are documentation/reference branches only.
- When implementation begins, create a fresh `feature/...` branch from the latest good `origin/main`.
- Workers may inspect other branches but should not merge another worker's branch or `main` unless explicitly acting as the integration worker.

Example:

```text
AceVra/                 main / integration
AceVra-speed/           feature/runtime-speed
AceVra-multitask/       feature/multitask
AceVra-bot/             feature/personal-bot
AceVra-cross-mode/      feature/cross-mode
AceVra-auth/            feature/auth-first-run
```

## 2. Exact worktree setup recipe

Run from the existing AceVra checkout:

```bash
ROOT="$(git rev-parse --show-toplevel)"
PARENT="$(dirname "$ROOT")"

git fetch origin --prune

git worktree add -b feature/multitask \
  "$PARENT/AceVra-multitask" origin/main

git worktree add -b feature/personal-bot \
  "$PARENT/AceVra-bot" origin/main

git worktree add -b feature/cross-mode \
  "$PARENT/AceVra-cross-mode" origin/main

git worktree add -b feature/auth-first-run \
  "$PARENT/AceVra-auth" origin/main

git worktree list
```

If a branch/worktree already exists, inspect first:

```bash
git worktree list
git branch --list 'feature/*'
git branch -r --list 'origin/feature/*'
```

Setup must be idempotent: reuse valid existing worktrees or stop and report a conflict. Never delete or replace unknown work.

### Roadmap references

Read roadmaps without merging roadmap branches:

```bash
git show origin/roadmap/multitask-future:docs/roadmap/multitask.md
git show origin/roadmap/personal-bot-future:docs/roadmap/personal-bot.md
git show origin/roadmap/cross-mode-future:docs/roadmap/cross-mode-continuity.md
git show origin/roadmap/auth-first-run-future:docs/roadmap/auth-first-run.md
```

### Dependencies

Inside a worktree when needed:

```bash
pnpm install --frozen-lockfile
```

pnpm's shared content-addressed store reduces duplicated package downloads/storage, although every worktree still has its own checkout, links, and generated outputs.

### Environment/secrets

Gitignored files such as `.env.local` do not automatically appear in new worktrees.

- Do not copy secrets automatically.
- Copy/symlink only required trusted development env files after inspection.
- Never commit env/secrets.
- Never invent production credentials.

---

## 3. Daily development = dev mode, not packaged builds

For normal coding, UI work, debugging, and most agent validation use:

```bash
pnpm dev:desktop
```

This is the AceVra equivalent of `npm run dev` in a web project.

The desktop dev runtime uses watch processes for the Electron/main-side bundles and Vite for the renderer, so source changes can be rebuilt during the running development session instead of producing a fresh ~1 GB packaged app every time.

For web-only work where appropriate:

```bash
pnpm dev:web
```

Feature workers should leave packaging alone unless package-level behavior is specifically under test.

### Development loop

Preferred inner loop:

```text
start dev once
→ edit
→ watch/reload
→ edit
→ watch/reload
→ targeted checks
→ commit
```

Do **not** do this:

```text
edit
→ delete packaged app
→ full bundle
→ wait several minutes
→ edit again
→ full bundle again
```

### Useful verification commands

Use the smallest checks that prove the change while iterating:

```bash
pnpm run typecheck
pnpm run lint
pnpm run architecture:check -- --changed
pnpm run verify:pre-push
pnpm --filter @zcode/web build
git diff --check
```

`pnpm build` recursively builds the workspace and is heavier. It is not the default inner-loop command.

---

## 4. Parallel runtime caution

Worktrees isolate files, but they do not automatically isolate:

- ports
- dev-server processes
- app data/home directories
- relay endpoints
- sockets
- attached devices
- other shared external resources

Do not assume four worktrees can all run the same full desktop runtime simultaneously with identical settings.

If multiple workers must run live apps at once, give them isolated ports/data/runtime settings where supported. Otherwise coordinate ownership of the live runtime.

A worker that only needs code inspection, typechecking, linting, or package-level tests does not need its own live desktop app.

---

## 5. Packaging policy: explicit only

**No feature worker should create a packaged AceVra app just because code changed.**

Packaging happens only when one of these is true:

1. the user explicitly asks for a real packaged app,
2. package-level behavior must be tested,
3. an integration/release checkpoint has been reached.

The normal full packaging command remains:

```bash
pnpm bundle:desktop
```

This is analogous to a production/deploy build in a web project, not the development loop.

## 6. One canonical packaged build

The integration/main workspace owns the canonical packaged build.

Default rule:

**Keep only the currently intended packaged AceVra build/release artifacts. Do not accumulate historical local builds.**

Before/after an intentional packaging run, clean only known desktop packaging artifacts as appropriate. Do **not** use broad repo cleanup merely to remove a desktop bundle.

The current default desktop packaging output is under:

```text
packages/desktop/dist
```

If an old local package is no longer needed, remove that old desktop packaging output before/after the next intentional package cycle as appropriate.

Do not use `pnpm clean` for routine package cleanup: the current command also removes `node_modules` and package `dist` directories across the repo.

### After installing/accepting a build

If the user has installed/copied the desired AceVra application and does not need to archive the build artifacts:

- keep the installed/current app
- remove obsolete local packaging output
- remove old DMG/ZIP/unpacked packaging leftovers
- do not retain numbered/versioned local copies unless the user explicitly wants an archive

If the user wants to keep a release artifact, keep only the intentional artifact (for example one DMG) and remove the temporary unpacked/package staging tree afterward.

---

## 7. Temporary package validation

If a feature branch genuinely requires package-level validation, do not use the canonical output.

Use a temporary feature-specific directory:

```bash
ZCODE_DESKTOP_DIST_DIR=/tmp/acevra-feature-build pnpm bundle:desktop
```

After validation:

```bash
rm -rf /tmp/acevra-feature-build
```

Temporary packaged output must not be left behind.

Do not overwrite or delete the user's canonical installed/current AceVra app from a feature worktree.

---

## 8. Existing bundle shortcuts

The current desktop bundler supports:

```text
--skip-prepare
--skip-build
```

These may be used only when the worker has verified that the corresponding prepared/build outputs are already fresh and valid.

Example:

```bash
pnpm bundle:desktop -- --skip-prepare --skip-build
```

Do not use skip flags blindly; stale production output can create an invalid package.

For day-to-day development, prefer `pnpm dev:desktop` rather than trying to optimize packaging.

---

## 9. Production build cleanup must remain correctness-first

The current production desktop build intentionally clears stale `out/main`, `out/host`, `out/preload`, and `out/renderer` outputs before rebuilding so stale chunks do not leak into packaged `app.asar`.

Do not disable that correctness cleanup merely to make release packaging faster.

The speed strategy is:

```text
make packaging rare
NOT
make every release build dangerously incremental
```

---

## 10. Worktree cleanup

After a feature is merged and no longer needs independent development:

```bash
git worktree remove <path>
```

Keep the Git branch/commit history as needed. The worktree directory is disposable.

Before removal, verify there are no uncommitted changes that need preservation.

---

## 11. Worker handoff requirements

Before handing a feature branch back for integration, report:

- branch and commit
- files changed
- checks actually run and results
- checks not run
- whether a live runtime was used
- whether any packaged artifact was created
- any temporary artifact still present
- config/env/migration changes required
- known dependency/conflict with another feature branch

Do not claim a full gate passed if only targeted checks ran.

The current broader handoff gate, when applicable, includes:

```bash
pnpm run typecheck
pnpm run lint
pnpm run architecture:check -- --changed
pnpm --filter @zcode/web build
git diff --check
```

---

## 12. Integration/main worker

The integration/main worker is responsible for:

- integrating accepted feature commits
- resolving cross-feature conflicts deliberately
- running broader combined verification
- running the live dev app for combined validation when useful
- creating the packaged AceVra build only when explicitly requested or at a real checkpoint
- keeping only the intentional current build/artifact set
- removing obsolete packaging outputs after a successful replacement

---

## Mental model

Treat AceVra like a web project:

```text
pnpm dev:desktop
≈ npm run dev

pnpm bundle:desktop
≈ production build / deploy artifact
```

**Code in dev mode. Package rarely. Keep one intentional real build. Never accumulate old local packages.**
