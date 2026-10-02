# AceVra Parallel Development / Build & Storage Policy

> Purpose: allow several coding agents to work at the same time without editing the same checkout, duplicating large packaged builds, or leaving stale artifacts behind.

## 1. One worker = one feature branch + one worktree

- Never point two code-writing workers at the same physical checkout.
- Give each active feature worker its own Git branch and Git worktree.
- Roadmap branches are documentation/reference branches only. When implementation begins, create a fresh `feature/...` branch from the latest good `main` and give it its own worktree.
- Workers may fetch/read other branches, but should not merge another worker's branch or `main` unless they are explicitly acting as the integration worker.

Example layout:

```text
AceVra/                 main / integration
AceVra-speed/           feature/runtime-speed
AceVra-multitask/       feature/multitask
AceVra-bot/             feature/personal-bot
```

## 2. Exact worktree setup recipe

Run this from the existing AceVra checkout. It creates implementation worktrees from the **latest remote main** without switching or modifying the current checkout:

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

If a feature branch or worktree already exists, **do not blindly recreate it**. Inspect first:

```bash
git worktree list
git branch --list 'feature/*'
git branch -r --list 'origin/feature/*'
```

A setup agent should be idempotent: reuse a valid existing feature worktree, or stop and report a conflict instead of deleting/replacing work.

### Roadmap references for implementation workers

Implementation branches should start from latest `origin/main`, not from roadmap branches. Read the roadmap without merging it:

```bash
git show origin/roadmap/multitask-future:docs/roadmap/multitask.md
git show origin/roadmap/personal-bot-future:docs/roadmap/personal-bot.md
git show origin/roadmap/cross-mode-future:docs/roadmap/cross-mode-continuity.md
git show origin/roadmap/auth-first-run-future:docs/roadmap/auth-first-run.md
```

The shared policy can likewise be read from the relevant roadmap branch.

### Dependency install

Inside each worktree, when dependencies are needed:

```bash
pnpm install --frozen-lockfile
```

pnpm's shared content-addressed store reduces duplicate package storage, though each worktree still has its own links and generated outputs.

### Environment/secrets

Gitignored files such as `.env.local` do not automatically appear in a new worktree.

- Do not copy or expose secrets unnecessarily.
- If local development requires the same trusted development env, explicitly copy or symlink only the required local env file after inspecting it.
- Never commit the env file.
- Do not invent production credentials.

### Optional remote branch publication

After creating a feature branch, publish it when useful:

```bash
git -C "$PARENT/AceVra-multitask" push -u origin feature/multitask
git -C "$PARENT/AceVra-bot" push -u origin feature/personal-bot
git -C "$PARENT/AceVra-cross-mode" push -u origin feature/cross-mode
git -C "$PARENT/AceVra-auth" push -u origin feature/auth-first-run
```

Do not push merely to satisfy setup if the user wants local-only work first.

## 2. Dependency/storage rule

- AceVra uses pnpm. Each worktree can run `pnpm install` when required; pnpm's content-addressed store avoids redownloading independent full copies of package contents.
- A worktree still has its own checkout and generated outputs. Treat those outputs as disposable.
- Do not copy the whole repository manually to create worker environments; use Git worktrees.

## 3. Development loop for feature workers

Prefer the smallest validation that proves the change while iterating:

1. edit only inside the worker's worktree
2. run targeted checks/tests for the affected package or subsystem
3. run type/lint/architecture checks as appropriate
4. use development mode when visual/runtime validation is needed
5. commit the finished change to the worker's feature branch

Useful root commands currently available:

```bash
pnpm install
pnpm run typecheck
pnpm run lint
pnpm run architecture:check -- --changed
pnpm run verify:pre-push
pnpm dev:desktop
pnpm dev:desktop:test
pnpm dev:web
pnpm --filter @zcode/web build
git diff --check
```

`pnpm build` recursively builds the workspace and is heavier. Use it only when the scope of the change requires it rather than as the default inner-loop check.

## 4. Parallel runtime caution

- Separate worktrees isolate files, but dev servers/apps may still compete for the same ports, app data directories, sockets, relay endpoints, or device resources.
- Do not assume multiple full desktop/web dev runtimes can run simultaneously just because the source is in different worktrees.
- If more than one worker must run a live app at once, give each process explicit isolated ports/data/home/runtime settings where supported; otherwise coordinate so only one owns the conflicting runtime at a time.
- Tests that use shared external resources/devices must also coordinate ownership.

## 5. Canonical build policy

**Many workers may test; only the integration/main workspace owns the canonical packaged AceVra build.**

Feature workers should normally NOT run the full distributable desktop packaging step.

Normal feature-worker flow:

```text
edit → targeted verify → commit
```

Integration flow:

```text
merge accepted feature branches
→ full/relevant verification
→ one canonical desktop package
→ keep the newest intended build
```

The desktop builder supports `ZCODE_DESKTOP_DIST_DIR`. If package-level validation is genuinely required on a feature branch, direct it to a temporary feature-specific directory, validate it, then delete that temporary output.

Example:

```bash
ZCODE_DESKTOP_DIST_DIR=/tmp/acevra-feature-build pnpm bundle:desktop
rm -rf /tmp/acevra-feature-build
```

Do not overwrite or delete the user's current canonical AceVra build from a feature worktree.

## 6. Cleanup rules

- Remove feature-specific temporary build/package outputs after validation.
- After a feature is merged and no longer needs independent work, remove its worktree with `git worktree remove <path>`.
- Keep the Git branch/commit history as needed; the worktree folder is disposable.
- Do not use `pnpm clean` as routine worker cleanup. The current repo command removes both `dist` and `node_modules` from the root/packages, which is broader than normal artifact cleanup.
- Prefer deleting only the known temporary output owned by that worker.

## 7. Verification / handoff expectations

Before handing a branch back for integration, the worker should report:

- branch/commit
- files changed
- checks actually run and their results
- checks not run
- any temporary artifacts left behind
- any migrations/config/env changes required
- known conflicts or dependencies on another feature branch

The repo's current handoff guidance includes this full gate before committing/integration when applicable:

```bash
pnpm run typecheck
pnpm run lint
pnpm run architecture:check -- --changed
pnpm --filter @zcode/web build
git diff --check
```

Do not claim a full gate passed if only targeted checks were run.

## 8. Integration worker

The integration/main worker is responsible for:

- pulling the latest accepted feature commits
- resolving cross-feature conflicts deliberately
- running the broader verification appropriate to the combined change
- producing the single intended packaged desktop build when needed
- deleting/replacing obsolete package artifacts according to the user's storage policy

## Guiding rule

**Parallelize source work, not heavyweight packaged artifacts. Keep worker environments isolated and disposable; keep one intentional current AceVra build.**