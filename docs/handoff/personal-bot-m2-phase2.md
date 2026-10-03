# Personal Bot M2 Phase 2 — worker handoff

Branch: `feature/personal-bot`
Spec: `docs/specs/personal-bot.md` §14 (M2 Phase 2)
Predecessors: `docs/handoff/personal-bot-m1.md`, `docs/handoff/personal-bot-m2-phase1.md`

## Multitask baseline consumed

Gate released after the agreed one-time freshness check. M2 landed on a **new branch**, so both were
checked:

| Surface                            | Head                                       | `create-app.ts` blob                       |
| ---------------------------------- | ------------------------------------------ | ------------------------------------------ |
| `origin/feature/multitask` (M1)    | `ef14646`                                  | `74acde8fc7e5858295e80e19cb9321069671089e` |
| `origin/feature/multitask-m2` (M2) | `e39802a5e23a57b133907cd04bf30b70ebe4bb89` | `74acde8fc7e5858295e80e19cb9321069671089e` |

Both are byte-identical to the recorded baseline, so the gate file was unchanged by M2 and the
approved design was implemented without a further design pass. `feature/multitask-m2` branched from
`d25f031a`, i.e. before the cross-mode adoption commits — which is why it does not carry them.

## Commits

| Commit    | Scope                                      |
| --------- | ------------------------------------------ |
| `401ef92` | spec §14                                   |
| `4f453bb` | shared protocol method + CLI port contract |
| `f209e9e` | core per-turn injection                    |
| `bc47bdd` | bootstrap adapter + host resolver          |

## Memory injection path

```text
turn.ts (options.inputVisibility !== "model-only")
  └─ injectPersonalMemoryContextFromTurn          core
       ├─ gate: config.taskType === "personal_bot"   ← enforced here, not at the call site
       ├─ port.requestContext({ query, turnId })     core → bootstrap
       │    └─ PersonalMemoryContextPort adapter
       │         └─ interaction/personalMemoryContext  (strict schemas)
       │              └─ handlePersonalMemoryContextRequest        host
       │                   └─ resolver → IBotService.buildMemoryContext({ query })
       │                        └─ bot/domain/memory.ts   ← the only scoring/bounding owner
       │                   ← re-projected to { text, omittedCount, byteLength }
       ├─ empty text → zero injection
       ├─ same body already in history → not re-appended
       └─ messageHistory.addAttachment("personal_memory_context", text)
```

The port is installed only on `personal_bot` sessions (`server-operations.ts`), so any other session
cannot reach the host at all; the core re-checks the task type before touching the port. Fail-open is
enforced at three layers: the adapter (RPC error / old host / 1s timeout → no context), the injection
method (any throw → debug log, turn continues), and the host handler (resolver absent or throwing →
empty context, not an error). Malformed params are still `-32602`, because "invalid request" and
"no memory" are different facts.

## Automated verification

| Check                                                                                                                    | Result                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `pnpm architecture:check` (full)                                                                                         | OK — 0 violations, 0 baseline, 0 new                                                                  |
| `pnpm typecheck`                                                                                                         | Only the pre-existing `packages/account-api` missing-dependency errors (`pg`, `@electric-sql/pglite`) |
| `packages/shared`, `packages/services`, `packages/ui`, `packages/desktop/tsconfig.host.json`, and the three CLI packages | Pass                                                                                                  |
| `pnpm lint`                                                                                                              | 89 warnings, 0 errors — same count as before Phase 2, none on the new files                           |
| All core tests (`core/test/*.test.ts`)                                                                                   | 65 pass / 0 fail — no regression in the shared reminder/turn seam                                     |
| `personal-memory-context.test.ts` (new)                                                                                  | 7 pass / 0 fail                                                                                       |
| `personalMemoryRpc.test.ts` (new)                                                                                        | 7 pass / 0 fail                                                                                       |
| All Bot suites (service, handoff, session kind, startup workspace, presentation)                                         | 29 pass / 0 fail                                                                                      |
| `packages/services` full suite                                                                                           | 335 pass / **1 fail** — see below                                                                     |

### The one failure is pre-existing

`packages/services/test/codexExecutionService.test.ts` → "sendTurn rejects non-curated model/effort
before touching turn/start" (the `codex_effort_not_allowed` assertion) fails deterministically.
Verified by stashing all Phase 2 work and re-running at the frozen head `a396654`: it fails there
too, identically. No codex file was touched by this phase. It is a real pre-existing failure in the
repo, unrelated to Personal Bot, and worth someone's attention separately.

### Required behaviours, mapped to coverage

| Requirement                                   | Where                                                                                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Relevant memory reaches a `personal_bot` turn | core test 1                                                                                                                             |
| Retrieval stays bounded by the Bot module     | Bot service tests + end-to-end chain test (200 records → ≤8 / ≤4096 bytes, `byteLength` matches UTF-8)                                  |
| Empty / no-match injects nothing              | core test 2 (including whitespace-only)                                                                                                 |
| Failure fails open                            | core test 3 (throwing port), host tests 3–4 (missing/throwing resolver)                                                                 |
| Non-`personal_bot` never receives memory      | core test 4 — four task types, asserts no injection **and** no host call                                                                |
| No duplicate accumulation                     | core tests 5–6 (unchanged body deduped, changed body appended)                                                                          |
| Raw records never cross the boundary          | host test 2 (resolver returning `selected` → payload has exactly 3 keys, no `mem_secret`) + strict-schema rejection of budget overrides |
| Coding / project memory unchanged             | all 65 core tests pass; `personal_bot` remains excluded by the existing `isMainMemoryTaskType` predicate                                |

## Live verification: pending

Not taken. The shared dev runtime is owned by other workers right now — live Electron processes from
`AceVra-multitask-m2` and a new `AceVra-integration-cm-mt` worktree (an integration branch for
cross-mode × multitask that did not exist when Phase 1 was planned). Per instruction I did not contest
it.

## Remaining gaps

- **Live acceptance (Phase 1 + Phase 2 combined), all pending:** first Bot launch; first message
  creates a `personal_bot` session; response streams through `V4ChatPane` (this is also what finally
  exercises the revived `V4ChatPane`/`V4ConversationProvider` path, still dormant in production);
  restart/resume restores the same conversation; relevant memory visibly affects a Bot turn; Bot ↔
  Coding navigation leaves coding pane state intact; stale Bot pointer recovers cleanly; the Bot
  session stays absent from Coding Sessions.
- **The pre-existing codex test failure** above is not ours to fix from this branch but should be
  surfaced to whoever owns that surface.
- Cross-Mode implementation was deliberately not expanded: the `bot → coding` / `coding → bot` /
  `multitask → bot` executors remain Cross-Mode's milestone. Personal Bot exposes the conversation
  reference and the bounded memory context; it creates no admission records and still never carries
  memory into a handoff.
- A new integration worktree (`AceVra-integration-cm-mt`) suggests cross-mode × multitask
  integration is underway. When that branch hands off, the Personal Bot additions that intersect it
  are the shared protocol barrel (`packages/shared/src/index.ts`), the protocol method table, and the
  `zcodeAgentService` request dispatch — all additive, but worth a merge dry-run at the time.

## Live acceptance — observed results (2026-10-03, head `bd8de7b`)

Runtime: `mise run dev` desktop dev profile (`~/.zcode-acevra-dev`, Vite 5174, CDP 9229), driven via
Playwright-core `connectOverCDP`. Bot fixtures reset before the run (fresh first-launch). All seven
scenarios passed:

1. **First launch** — the `personal-bot` workspace is recreated mkdir-only at startup (empty dir),
   no CLI runtime is spawned for it before the first message (0 matching processes, 0 host-log
   mentions), and the bot store regenerates lazily on first Bot open.
2. **First message creates a `personal_bot` session** — real turn through `V4ChatPane` (streamed
   reply), pointer written (`conversation.json`), turn ran with cwd = the bot workspace (model-io),
   and the session has **no row in the tasks index** (Coding Sessions exclusion). The session kind
   is positively proven by scenario 4: turn-time injection is gated on `taskType === "personal_bot"`
   before any host RPC, and injection fired.
3. **Restart/resume** — after a full app kill + relaunch, the Bot view resumed the same session id
   with both turns, both answers, memory rows ("2 remembered") and a ready composer.
4. **End-to-end memory injection** — two seeded records (one pinned) produced a `system` attachment
   in the provider request (verified in the turn's model-io JSONL: the bounded
   "Personal memory (remembered from earlier conversations…)" block with exactly the two rendered
   records) and the answer quoted both facts. No block on the pre-seeding turn. The Memory tab needs
   a manual refresh to see out-of-band store edits (mount-time read); refresh works and fresh
   mounts read current data.
5. **Bot ↔ other-view navigation** — leaving Bot via a top-level main-view switch unmounts the Bot
   section with zero conversation-text leakage into other surfaces; returning restores both turns.
   (The chat/coding view is re-entered by restore or workspace selection, not by the sidebar
   Projects/Tasks items while Bot is active.)
6. **Stale pointer recovery** — corrupted pointer (`sess_does_not_exist…`) + reload: no crash, no
   error boundary, and the durable pointer self-heals to `null` passively (no user action). A
   message after recovery creates a fresh session and re-points. Cosmetic note: if the pane layer
   still holds a _valid_ previous session, its transcript can flash briefly before the pointer
   validation clears it; the state converges correctly (old content never persists into the new
   session).
7. **Ordinary coding tool path** — a coding session in the restored project workspace ran a shell
   tool (`ls -1 | wc -l` → "7") normally; its model-io contains **no** personal-memory block or
   RPC trace; the session indexes normally; the two live bot sessions never entered the index.

Redesigned UI (spec §15) verified during the same run: conversation flow, Memory/Computers/
Capabilities tabs, memory rows with category badges, Computers empty state with the SSH-server hint
and a working refresh, capability domains with availability badges, header identity, composer.

Automated verification at the same head: services `personalBot(+Handoff)` 18/18, CLI core
`personal-memory-context` 7/7, CLI bootstrap `personalBotSessionKind` 4/4, UI
`botSectionPresentation` 4/4, root `pnpm typecheck` clean, oxlint 0 errors (89 pre-existing
repo-wide warnings, none in bot files), `architecture:check --changed` 0 violations.

Conclusion: `V4ChatPane` is confirmed as the production Bot conversation host. No Personal Bot
defects were found during live acceptance; the branch is ready to freeze for cross-feature
integration.
