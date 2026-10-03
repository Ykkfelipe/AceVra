# Personal Bot M2 Phase 1 — worker handoff

Branch: `feature/personal-bot`
Spec: `docs/specs/personal-bot.md` §13 (M2 Phase 1)
Predecessor: `docs/handoff/personal-bot-m1.md`

## Commits

| Commit    | Scope                                                                 |
| --------- | --------------------------------------------------------------------- |
| `4e863c3` | M2 Phase 1 spec + frozen cross-mode contract snapshot                 |
| `6e37112` | Personal Bot workspace created at desktop startup                     |
| `672871d` | Bot conversation on the single-pane session stack + pointer lifecycle |
| `5631fba` | Cross-mode conversation reference helper                              |

## What Phase 1 delivers

**Hosting.** `resolveStartupWindowBootstrap` now takes `personalBotWorkspaceDir` and creates it with a
best-effort `mkdir`, before the startup branches diverge — the common persisted-session path never
reached the existing `conversationWorkspaceDir` creation, so a bot-only mkdir inside those branches
would have missed it. The directory is deliberately absent from `initialWorkspacePath`,
`workspacePurpose`, `agentWarmupTargets` and the task index. A failed mkdir warns and lets startup
continue.

**Conversation.** The Bot section renders `V4ChatPane` (`V4ConversationProvider` + `SessionPane`)
bound to the Bot workspace, so composer, streaming, tool rendering, permission dialogs, rewind, find
and draft prewarm are all the existing implementations. The section was restructured so the
conversation is the main area and identity/memory/capabilities moved to a side column; the
conversation renders regardless of the side column's loading state.

**Pointer lifecycle.** `BotConversationShell.sessionId` remains the sole durable authority. The
pointer is written on the accepted `onSessionCreated` boundary and cleared on `onSessionDeleted`;
identity, profile and memory are never touched by pointer changes.

**Cross-Mode.** `toBotConversationRef(shell)` projects the pointer into the frozen contract's
`{ kind: "conversation", id }` reference, validated with the contract's own
`handoffObjectRefSchema`. Null means "not referenceable". No admission records, no
`HandoffExecutionPort`, and personal memory never enters handoff context.

## CQ2 result

**No containment change was required.** Verified from source:

- `SessionPane` never reads or writes `zcodeSessionStore.activeTaskId`. It reports created sessions
  through its `onSessionCreated` prop; the workbench shell is what turns that into `setActiveTaskId`.
- `V4ChatPane` and `V4ConversationProvider` have zero `activeTaskId` coupling.
- Every `paneId`-keyed state in `SessionPane` (scroll memory, draft prewarm) is additionally keyed by
  `workspaceKey`, so reusing `paneId="workspace-main"` for the distinct Bot workspace cannot collide
  with a coding pane.
- The only store write on the draft-send path is `promoteGroupedDraftTask`, gated on a per-workspace
  `groupedDraftTask` that only the coding grouped-draft feature sets and that is never set for the
  Bot workspace key.

The Bot module therefore remains the only authority for "which session the Bot uses"; `activeTaskId`
is simply not involved.

## V4ChatPane outcome

**It worked structurally and was used as-is — no fallback was needed.** One narrow, additive change
was required to make stale-pointer recovery possible without duplicating the provider composition:
`SessionPane` gained an optional `onSessionUnavailable?: () => void` (mirroring the existing
`onSelectionSideChatUnavailable` precedent for the same class of problem), forwarded through
`V4ChatPane`. It fires at most once per session id and only on `sessionNotFound`; transport hiccups
and turn failures deliberately do not trigger it, so a recoverable error cannot escalate into a lost
conversation.

Two honest caveats:

- `V4ChatPane` was **dormant** before this change (imported by `WorkspaceShellLayout.tsx` but never
  rendered, and the sole consumer of `V4ConversationProvider`). Typecheck and lint pass, but its
  runtime path has no prior exercise. Live scenario 2 is what actually confirms it; the documented
  fallback (compose `V4ConversationProvider + SessionPane` directly inside the Bot component) remains
  available and would be a small, contained change.
- Its runtime path has not yet been exercised with a real CLI process, so source-level confidence is
  not the same as observed behaviour.

## Spec correction discovered during implementation

The first draft of §13.4 specified a preflight validation using a read-only `existing-only` session
read. Source showed that is wrong: `getReadOnlyClient(..., "existing-only")` throws
`createRuntimeUnavailableError` when no runtime is alive, so it reports **runtime liveness, not
session existence**. Because the Bot runtime is lazily spawned, a cold start would misclassify a
valid pointer as stale and erase it. §13.4 now records the correct design: no preflight, validation
is part of the normal open, and only the subscription's `sessionNotFound` clears the pointer.

## Automated verification

| Check                                                                                                      | Result                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm architecture:check` (full)                                                                           | OK — 0 violations, 0 baseline, 0 new                                                                                                                              |
| `pnpm typecheck`                                                                                           | Fails only on `packages/account-api` (`pg`, `@electric-sql/pglite` declared but not installed in this worktree) — pre-existing, unrelated                         |
| `tsc -b packages/shared packages/services packages/client packages/ui packages/desktop/tsconfig.host.json` | Pass                                                                                                                                                              |
| `pnpm lint` (root)                                                                                         | 89 warnings, 0 errors. My files contribute none; the 89 vs the earlier 86 is the three `.zcode/workflows/*.dwf.ts` files brought in by the release-baseline merge |
| `personalBot.test.ts`                                                                                      | 14 pass / 0 fail (incl. new stale-pointer recovery case)                                                                                                          |
| `personalBotHandoff.test.ts`                                                                               | 4 pass / 0 fail (new)                                                                                                                                             |
| `personalBotSessionKind.test.ts`                                                                           | 4 pass / 0 fail                                                                                                                                                   |
| `startupWorkspace.test.ts`                                                                                 | 3 pass / 0 fail (new)                                                                                                                                             |
| `botSectionPresentation.test.ts`                                                                           | 4 pass / 0 fail                                                                                                                                                   |
| Merge dry-run vs `feature/multitask`, `feature/cross-mode`, `feature/auth-first-run`                       | All clean                                                                                                                                                         |

Not covered automatically: the reactive stale-pointer race and the conversation itself are React
runtime behaviour and the UI test harness here is static-render only. The durable half (clearing a
pointer touches only `conversation.json`) is covered at the service level.

## Remaining live verification (pending)

The shared `pnpm dev:desktop` runtime was not taken. Scenarios still to run, from spec §13.8: first
Bot launch; send and stream a message; restart and resume the same session; Bot ↔ Coding navigation
without disturbing coding split panes; stale-pointer recovery by deleting the session out from under
the Bot. Scenario 2 is the one that also proves the revived `V4ChatPane` path.

## New dependencies discovered

- **The frozen Cross-Mode contract snapshot was synced** (`packages/shared/src/cross-mode/**`, 10
  files, byte-identical to `feature/cross-mode` @ `b5b4ca1`, plus the same additive barrel and
  `package.json` lines). All ten blob hashes match the snapshot Multitask had already synced, so the
  integration merge is a no-op for these files. This was needed to test the reference helper against
  the real contract instead of a hand-written copy of its rules.
- **Multitask has since adopted Cross-Mode too** (`ef14646`, plus the snapshot sync `aabd8a81`). Their
  adoption lives in `apps/zcode-cli/packages/core/src/cross-mode/multitask-handoff.ts` and follows the
  same pattern as this helper: adopt the frozen contract in your own package, adapt, do not modify the
  contract. The two adoptions are siblings and do not overlap.
- **Phase 2 gate still holds.** Multitask's range still touches
  `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts` (the file turn-time memory injection needs)
  and does **not** touch `packages/shared/src/zcode-protocol/**`. So the memory-injection phase stays
  blocked on the file Multitask is actively changing, exactly as the gate specified. The protocol file
  itself is currently free.
- **New integration surface for later:** the in-process `onSelectionSideChatUnavailable` pattern shows
  the standard way to signal "the session a surface was bound to is gone" down to the owner of the
  binding. Any future surface that persists a session pointer should reuse `onSessionUnavailable`
  rather than re-deriving it from projection state.
