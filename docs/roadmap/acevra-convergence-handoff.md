# AceVra full-product convergence handoff

Written 2026-10-03. Phase A (mechanical convergence) of the full-product
convergence milestone. Phase B (Personal Bot → Cross-Mode → Multitask → return)
has **not** started; it waits for review of this record.

| Item         | Value                                                |
| ------------ | ---------------------------------------------------- |
| Branch       | `integration/acevra-convergence` (local, not pushed) |
| Worktree     | `/Users/felipemore/Projects/AceVra-convergence`      |
| Final commit | the commit that adds this file (top of the branch)   |
| Status       | **Phase A green; Phase B not started**               |

## Baseline and frozen heads

| Role                                       | Ref                                                | Notes                                                                                                              |
| ------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Release baseline                           | `release/0.1.0-alpha` @ **`1959e76`**              | local head = `origin/release/0.1.0-alpha` (`0da09de`) + the worktree disk-budget policy commit; chosen by the user |
| Cross-Mode → Multitask production executor | `integration/cross-mode-multitask` @ **`fe214c2`** | already contains Multitask M2 `024183c` (verified `merge-base --is-ancestor`)                                      |
| Personal Bot                               | `feature/personal-bot` @ **`fb38619`**             | forked from `0da09de`                                                                                              |
| Auth M3a                                   | `feature/auth-first-run` @ **`ab72d74`**           | forked from `c02e24c`                                                                                              |

All four accepted heads matched their local and `origin` branch tips at merge time.
Source branches and worktrees were not modified.

History (all `--no-ff`, no rebase, no cherry-pick):

```text
1959e76  release baseline
2cc4daa  merge: integration/cross-mode-multitask@fe214c2
45bcd60  merge: feature/personal-bot@fb38619
e879b6b  merge: feature/auth-first-run@ab72d74
```

## Conflicts and ownership decisions

No textual conflicts in any of the three merges. Files touched by more than one
feature were checked by hand:

| File(s)                                                               | Sides                                                                                | Decision                                                                                                                                                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared/src/cross-mode/*`, `packages/shared/package.json`    | Cross-Mode (owner) and Personal Bot                                                  | Bot carries a **byte-identical** copy of the frozen contract (`docs(bot): … sync the frozen cross-mode contract`). Git merged them as identical additions; the contract has one owner and one content. |
| `packages/shared/src/zcode-protocol-v4/command.ts`                    | Cross-Mode (`startMultitaskHandoff`) and Bot (`createSession.taskType`)              | Both additions kept; disjoint fields.                                                                                                                                                                  |
| `packages/shared/src/index.ts`                                        | Bot (`personal-memory-protocol`) and Auth (`accountSessions`, `accountSignInReturn`) | All exports kept.                                                                                                                                                                                      |
| `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts`, `types.ts` | Cross-Mode (handoff service, run-settled return) and Bot (`personalMemoryPort`)      | Disjoint wiring; no shared state.                                                                                                                                                                      |
| `packages/ui/src/i18n/locales/{en-US,zh-CN}.ts`                       | Cross-Mode/Multitask, Bot and Auth                                                   | All keys kept; typecheck rejects duplicate object keys and passes.                                                                                                                                     |
| `docs/roadmap/parallel-development-policy.md`                         | all                                                                                  | Auto-merged; no semantic overlap.                                                                                                                                                                      |

## Ownership audit (no duplicates)

| Concern                                   | Single owner after convergence                                                            | Evidence                                                                                                                                                                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent sessions and messages               | CLI `AgentRuntime` + session store                                                        | Bot's `BotConversationShell` stores only `sessionId` (a pointer) and its dedicated workspace path; it never writes session content (`services/src/bot/domain/shell.ts`). Bot sessions are ordinary sessions tagged `taskType: "personal_bot"`.          |
| Workspaces / hosts                        | window-scoped Local Host                                                                  | `IBotService` is registered only on the local host collection; the Bot workspace is created mkdir-only and kept out of tabs, warmup targets and the task index (`desktop/src/main/startupWorkspace.ts`).                                                |
| Account identity, login sessions, devices | Auth (`desktop/src/main/account/*`, `account-api`)                                        | Bot's "identity" is persona data (name, avatar, tone), not an account. `BotComputersPanel` reads `IPlatformService.account.listDevices()` and keeps no second registry. Auth's `accountSessions` are human login sessions, unrelated to agent sessions. |
| Handoff admission, execution and runs     | Cross-Mode handoff service + production executor → Multitask tool → Workflow/M2 lifecycle | Bot's `domain/handoff.ts` only projects a conversation into a contract `HandoffObjectRef`; it creates no admission record and implements no execution port.                                                                                             |
| Personal memory                           | Bot host module (`services/src/bot/domain/memory.ts`)                                     | Injected only for `taskType === "personal_bot"` as a model-only attachment (`core/src/runtime/methods/personal-memory-context.ts`).                                                                                                                     |

## Phase A verification

| Check                                                  | Result                                                                                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                       | pass                                                                                                                                                                                                          |
| `pnpm lint`                                            | 0 errors, 89 warnings (identical count on release `1959e76`)                                                                                                                                                  |
| `pnpm architecture:check` (full)                       | OK, 0 violations                                                                                                                                                                                              |
| `pnpm build` (all workspace packages incl. CLI bundle) | pass                                                                                                                                                                                                          |
| `pnpm fmt:check`                                       | 43 files; 31 already on release. The 12 new files are byte-identical to the frozen heads (`fe214c2`, `fb38619`); left unformatted to keep the merge mechanical. `fmt:check` is not part of `verify:pre-push`. |

Tests (`node --import tsx --test`, Node 24.14.0 via mise, run from each package
directory after `pnpm build`):

| Package                                    | Result                                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared`                          | 77/77                                                                                                                                                              |
| `packages/ui`                              | 263/263                                                                                                                                                            |
| `packages/services`                        | 347 pass, 1 fail — `codexExecutionService: sendTurn rejects non-curated model/effort` fails identically on release `1959e76`; no merged feature touches Codex code |
| `packages/desktop`                         | 144/144 (run from repo root)                                                                                                                                       |
| `packages/account-api`                     | 138/138                                                                                                                                                            |
| `packages/client`                          | 2/2                                                                                                                                                                |
| `packages/node`                            | 33/33                                                                                                                                                              |
| `apps/zcode-cli/packages/core`             | 85/85                                                                                                                                                              |
| `apps/zcode-cli/packages/bootstrap`        | 51/51 (includes `cross-mode-multitask-integration.test.ts`)                                                                                                        |
| `apps/zcode-cli/packages/cli`              | 5/5                                                                                                                                                                |
| `apps/zcode-cli/packages/zcode-cua-plugin` | 5/5                                                                                                                                                                |

UI and CLI tests must run from their package directory (tsconfig path aliases and
JSX settings) and after `pnpm build` (CLI packages import sibling `dist/`).

Live checks on this branch:

| Check                                                                                                                                        | Result                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-Mode command/executor, accept path (`apps/zcode-cli/scripts/cross-mode-handoff-live-acceptance.mjs`, built `zcode.cjs`, isolated HOME) | **PASS** — real Multitask confirmation shown; accepted ACK with `externalRef {kind:"multitask-run"}`; run reached `completed`. Isolated HOME has no model credentials, so this proves the protocol path, gate, run creation and lifecycle, not model-backed worker output. |
| Cross-Mode, decline path (`--deny`)                                                                                                          | **PASS** — handoff `rejected` with `PERMISSION_DENIED`, `externalRef: null`, no workflow run created                                                                                                                                                                       |
| Desktop app starts (`pnpm dev:desktop`, profile `~/.zcode-acevra-dev`)                                                                       | **PASS** — main window up, Local Host registered `accounts` and `bot` channels, agent runtime started, coding-plan entitlement resolved                                                                                                                                    |
| Auth sign-in, Bot open/resume, Multitask worker-first board, normal Workflow, in the UI                                                      | **Not yet observed** — screen access was not granted for this session; covered by unit tests above and to be confirmed by the user in the running app                                                                                                                      |

Environment notes (not code changes):

- The new worktree needed the shared, git-ignored `.env.local` (Clerk keys), copied
  unchanged from the other AceVra worktrees.
- The Electron binary download was incomplete after `pnpm install`;
  `mise exec -- node node_modules/electron/install.js` fixed it.
- The x86_64 `macos-window-bounds` helper fails to link on this machine; the build
  script treats it as non-blocking (permission overlay works, without snapping).
- `credential.load … Credential storage is host-only` in the startup log comes from
  `services/src/credential/credential.ts`, untouched by these merges.
- The dev profile's recent project is a fixture inside
  `AceVra-multitask/.spike/`; Phase B live checks should use a fixture owned by
  this worktree so the source worktrees stay untouched.

## Inputs for Phase B

- Bot memory is injected into `personal_bot` sessions' history. The handoff must
  target a **separate** coding session (as the accepted Cross-Mode path does via
  `createSession` + `startMultitaskHandoff`), never run Multitask inside the Bot
  session, or workers could inherit memory through session history.
- The production auto-return in `create-app.ts` only acts on `completed`
  (`stopped` is resumable and deliberately ignored). Phase B must surface the
  canonical return states in the originating Bot conversation without Bot
  inferring status itself.
- `toBotConversationRef` (Bot) already yields the contract
  `{kind:"conversation", id}` ref for the originating conversation.

## Recommendation

Phase A is green. The converged head is safe to build on for Phase B. It is
**not** yet a `release/0.1.0-alpha` candidate: the UI-level live checks above and
Phase B are still outstanding.

---

# Phase A2 — canonical baseline `8c61cc4` (frozen 2026-10-03)

Two further accepted milestones converged on top of Phase A and are now the
**canonical baseline future agents must branch from**:

| Item     | Value                                                                                     |
| -------- | ----------------------------------------------------------------------------------------- |
| Branch   | `integration/acevra-convergence` — local == `origin` @ **`8c61cc4`** (pushed, verified)   |
| Worktree | `/Users/felipemore/Projects/AceVra-convergence`                                           |
| Rule     | **Frozen.** No feature work directly on this branch; new milestones branch from `8c61cc4` in fresh worktrees unless an isolated branch has a different integration plan |

## History since Phase A (`58f1b0b`)

```text
58f1b0b  Phase A head (this file, initial)
79f5db3  merge: claude/intelligent-lovelace-kede1l@83c48fe (accepted unavailable local-project notice)
a2e5c76  merge: feature/bot-workspace-v2@8e6d9da (accepted Bot Workspace V2)
8c61cc4  merge: reconciliation of the two milestones (both accepted merges are ancestors)
```

Both accepted milestones are verified ancestors of `8c61cc4`
(`git merge-base --is-ancestor 83c48fe` / `8e6d9da`).

## 1. Unavailable local-project notice (`83c48fe`, merged via `79f5db3`)

- The coding main area explains a missing workspace folder in place of the
  composer (`UnavailableWorkspaceNotice` / `UnavailableWorkspaceComposerNotice`,
  spec `packages/ui/specs/unavailable-workspace-composer-notice.md`).
- Removal UX is owned by the shared `useWorkspaceTabRemoval` transaction
  (running-task confirm → closeTab → runtime release → cache invalidation);
  sidebar items and the notice share it — no second close path.
- "Open folder" reuses the existing reveal-folder platform surface.
- The notice is scoped to Coding/project read-only state; the Bot workspace
  (always present) never shows it.

## 2. Bot Workspace V2 (`feature/bot-workspace-v2@8e6d9da`, five commits)

- **Separate workspace chrome:** narrow global rail (`GlobalNavRail`) owns
  Coding / Bot / Search / Automations / Plugins + account/settings; the
  secondary sidebar is contextual (coding keeps Projects/Tasks; Bot gets its
  conversation sidebar); no coding header/terminal/side-pane in the Bot view.
- **History projection, not a copy:** Bot history derives on read from the CLI
  session store via a closed `session/list` projection `personal-bot`
  (workspace-scoped, `personal_bot` only). The default projection is unchanged;
  **no Bot session ever enters `tasks-index.sqlite`**.
- **Selection:** `conversation.json` (`IBotService.getConversationShell`) remains
  the sole durable selection authority; the UI mirrors it with generation-guarded
  reads and single-flight refreshes.
- **Conversation:** production `V4ChatPane` unchanged (streaming, restart/resume,
  `personal_bot` memory injection).
- **Computers:** the inspector hosts the shared `ComputerPane` (live SSH screen,
  Take control/Stop) and the canonical device registry — no second subsystem.
  First `RemoteComputer` attach auto-opens the inspector on Computers.
- **Screenshots:** `RemoteComputer.showToUser` is the display-channel signal —
  user-requested screenshots attach inline in chat; agent-internal ones stay as
  tool-card thumbnails; 256 KB inline display cap; shared by Coding and Bot.

## Reconciliation conflicts (resolved, both features kept)

| File                        | Resolution                                                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkspaceSidebar.tsx`      | 79f5db3's `useWorkspaceTabRemoval` refactor wins; Bot's rail already replaced the footer that used `openSettingsTab`.                                                  |
| `WorkspaceShellLayout.tsx`  | Bot's view gating kept; 79f5db3's `readOnlyComposerNotice` prop added to `V4WorkspaceChatArea` (Coding only; never rendered in the Bot view).                          |
| `locales`, `SessionPane`    | Auto-merged; en-US/zh-CN parity intact.                                                                                                                               |

## Phase A2 verification (all on `8c61cc4`)

Root + CLI typecheck pass; lint 0 errors / 89 warnings (baseline); architecture
check 0 violations; `git diff --check` clean; web `vite build` passes; UI suites
37/37 (unavailable-notice + Bot V2 + screenshot + shell contracts), CLI
projection/display tests 12/12, shared 77/77, services 15/15.

Live smoke (dev app, real runtime): Coding opens with the rail; missing-folder
notice renders in the coding view and is absent in Bot; Bot history and selection
restore; Bot ↔ Coding preserves both contexts; Dell live stream, inline
user-requested screenshot, internal screenshot kept tool-only; zero new
`personal_bot` rows in `tasks-index.sqlite`.

## Known notes carried forward

- The historical stale Bot row in `tasks-index.sqlite` remains a separate
  migration/cleanup issue (predates V2; V2 itself produces zero new rows).
- Phone-viewport visual verification of the rail/drawer remains outstanding.
- Bot conversation rename/delete: deferred (out of V2 scope).
- Cross-Mode "Work on this": deferred; the header actions slot
  (`bot-conversation-actions`) stays reserved.
