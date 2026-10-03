# Personal Bot M1 — worker handoff

Branch: `feature/personal-bot`
Base: `origin/release/0.1.0-alpha` (`c02e24c`), fast-forwarded from `main`. The release branch
advanced to `0da09de` during implementation (oxfmt on relay drills, saved CUA dynamic workflows,
`.gitignore`); it was merged at `d55a958` with zero file overlap and no conflicts.
Spec: `docs/specs/personal-bot.md`
Roadmap: `docs/roadmap/personal-bot.md`, `docs/roadmap/parallel-development-policy.md`

## Commits

| Commit    | Scope                                                                   |
| --------- | ----------------------------------------------------------------------- |
| `cca6b0b` | roadmap + M1 spec                                                       |
| `5e30e78` | `bot` module: identity, profile, memory, capability surface, shell      |
| `b7e1e43` | `personal_bot` session kind + creatable `taskType` on both create paths |
| `57e2748` | service channel, client proxy, host registrations, UI hooks             |
| `b19123c` | Bot section (sidebar entry, main view, nav history, i18n)               |
| `3818ca8` | trim local-only type exports                                            |

## Files changed

New managed module `packages/services/src/bot/` (`contract.ts`, `module.ts`, `CONTRACT.md`,
`domain/`, `app/`, `adapters/`), registered in `architecture-policy.yaml` (`owner: personal-bot`).

Runtime: `SESSION_TASK_TYPES` + `zcodeSessionKindSchema` + `SESSION_TASK_TYPES`-derived
`isConversationalSessionTaskType`; `zcodeCreatableSessionTaskTypes`; `taskType` on
`zcodeSessionCreateParamsSchema` and the V4 `createSession` payload; V4 handler, command host
hook, and v4-bridge pass-through; session-title and goal-summary-title use the new predicate.

Services/UI: `ServiceChannels.Bot`, `IServiceAccessor.botService?`, `RemoteServiceAccess` proxy,
`createNodeBotService` registration in the desktop host and node collections, `useBotHome`,
`BotSection`, `WorkspaceMainView = "bot"`, sidebar entry, `BotNavEntry`, 45 `bot.*` strings in
both locales.

## Checks actually run

| Check                                                                                          | Result                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm architecture:check` (full)                                                               | OK — 0 violations, 0 baseline, 0 new                                                                                                                                                                   |
| `pnpm typecheck`                                                                               | Fails on `packages/account-api` only: `pg` and `@electric-sql/pglite` are declared dependencies but not installed in this worktree. Pre-existing, unrelated to this branch.                            |
| `tsc -b packages/shared packages/services packages/client packages/ui`                         | Pass                                                                                                                                                                                                   |
| `turbo run typecheck --filter=@zcode/contracts --filter=@zcode/core --filter=@zcode/bootstrap` | Pass                                                                                                                                                                                                   |
| `pnpm lint` (root)                                                                             | 86 warnings, 0 errors. All warnings are on pre-existing lines/imports; none on added lines.                                                                                                            |
| `turbo run lint` for CLI packages                                                              | `@zcode/contracts` and `@zcode/core` fail on pre-existing `max-lines` violations in untouched files. My files lint clean.                                                                              |
| `pnpm knip`                                                                                    | Fails at baseline (1039 findings incl. 92 pre-existing test files). No leftover findings from the new exports except `bot/module.ts`, which matches the existing `task-artifacts/module.ts` precedent. |
| `node --test packages/services/test/personalBot.test.ts`                                       | 13 pass / 0 fail                                                                                                                                                                                       |
| `node --test apps/zcode-cli/packages/bootstrap/test/personalBotSessionKind.test.ts`            | 4 pass / 0 fail                                                                                                                                                                                        |
| `node --test packages/ui/test/botSectionPresentation.test.ts`                                  | 4 pass / 0 fail                                                                                                                                                                                        |

## Checks not run

- **Live desktop verification: pending.** Another worker is running the desktop dev runtime from
  `/Users/felipemore/Projects/AceVra-multitask` (Electron `AceVra Dev`, `--remote-debugging-port=9229`,
  live `zcode-host-local-1` / `zcode-cli` processes) and the dev profile
  (`ZCODE_HOME=~/.zcode-fork-dev-home`, `~/Library/Application Support/AceVra Dev`) is shared.
  Starting `pnpm dev:desktop` here would fight over that runtime, so it was left pending per the
  parallel-development policy.
- No E2E scenario for the Bot section.
- No packaged build created; no DMG; the installed AceVra app was not touched.

## Not implemented (deliberately deferred)

The Bot conversation is **not** yet hosted inside the Bot section. M1 delivers the persistent shell
(workspace + session pointer, owned by the Bot module) and the `personal_bot` classification, but
the section renders identity/profile, memory, capabilities, and the shell state — it does not embed
the chat workbench. Embedding it needs the Bot workspace registered/prepared in the host and a
decision about `ensureWorkspace`, which is the next milestone's first item.

Everything else in the roadmap (voice notes, goals/ideas, self-customization, device registry, real
email/calendar providers, Cross-Mode turn-time injection) is out of M1 by design.

## Integration notes

- `packages/shared/src/zcode-protocol/index.ts` and `zcode-protocol-v4/command.ts` are shared with
  other feature workers (`feature/cross-mode`, `feature/auth-first-run`, `feature/multitask`). The
  `taskType` additions are additive and fail-closed; expect trivial conflicts if they also touch
  `commandPayloadSchemas.createSession`.
- `TASK_LIST_SESSION_TYPES` was deliberately left unchanged. Any future milestone that adds Bot
  sessions to a sidebar projection must add a Bot-specific projection instead.
- No config, env, or migration changes. The Bot documents are created on first write under
  `{dataBaseDir}/.zcode/personal-bot/` (three independent JSON files). The shell records the Bot
  workspace as `{dataBaseDir}/.zcode/workspace/personal-bot`, but nothing creates that directory
  yet — that belongs with hosting the conversation.
