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
