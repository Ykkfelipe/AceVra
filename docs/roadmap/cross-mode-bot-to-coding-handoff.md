# Cross-Mode Bot → Coding "Work on this" — milestone handoff

Written 2026-10-03. Spec: `docs/specs/cross-mode-bot-to-coding.md`.

| Item     | Value                                                                  |
| -------- | ---------------------------------------------------------------------- |
| Branch   | `feature/bot-work-on-this` (local, not pushed)                         |
| Worktree | `/Users/felipemore/Projects/AceVra-bot-work-on-this`                   |
| Base     | `integration/acevra-convergence@191b1bc` (product baseline `8c61cc4`)  |
| Status   | **Implemented; unit + protocol-live + desktop-live acceptance passed** |

## What shipped

- **Product model:** Cross-Mode is continuity between Bot and Coding. `Work on this` = `bot → coding`
  only. Multitask stays a Coding capability (not a Cross-Mode destination); flow matrix unchanged.
- **Protocol (generic, additive):** `createSession.crossModeHandoff{confirmation}`, session entry
  `v4/cross_mode_origin` (frozen confirmation verbatim + `resultRef` + destination), and
  `snapshot.crossModeOrigin` / ACK `crossModeOrigin` (read-only projection, no carried content).
- **CLI intake** (`bootstrap/src/app/cross-mode-coding-handoff.ts`): preflight before any record →
  model-readiness check on the deferred record → frozen M2 admission with an execution port that
  materializes the session and writes the origin → first turn rendered from the packet.
- **Bot UI:** `Work on this` in the `bot-conversation-actions` slot; dialog driven by the contract
  view model (project, objective, notes, text-only excerpts of this conversation, budget, issues).
  No memory/profile/connector item exists. The handoff never writes `conversation.json`.
- **Coding UI:** "Started from a conversation with Ace" notice + **Continue with Ace** (navigation
  only, injected by `BotWorkspaceProvider`, the owner of conversation selection).

## Return seam (next milestone)

The origin entry already identifies the Bot conversation (`sourceRefs`), the handoff (`handoffId`)
and the resulting work (`resultRef` + destination). A `coding → bot` `HandoffReturnSummary` producer in
Coding plus a consumer in Bot completes the loop; no second store is needed.

## Verification

| Check                                                                  | Result                                                                                                               |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck` / CLI turbo typecheck                                 | pass / 21/21                                                                                                         |
| `pnpm lint`                                                            | 0 errors, 89 warnings (baseline)                                                                                     |
| `pnpm architecture:check`                                              | 0 violations                                                                                                         |
| shared / ui / bootstrap tests                                          | 81/81 · 292/292 · 67/67                                                                                              |
| services tests                                                         | 335/336 — the known pre-existing Codex `sendTurn` failure (also on release)                                          |
| Protocol live (`scripts/cross-mode-bot-to-coding-live-acceptance.mjs`) | accept: ACK + live + cold `crossModeOrigin`, SQLite facts; `--expect-reject` (no model): rejected, nothing persisted |

Desktop live (AceVra Dev from this worktree, profile `~/.zcode-acevra-dev`, fixture project
`.spike/work-on-this-fixture`, not committed):

1. Existing Ace conversation shows **Work on this**; a fresh draft does not.
2. Dialog: project picker (only writable local projects), objective, notes, 2 excerpts, budget.
3. Start → new `interactive` session in the fixture project; app switched to Coding.
4. First message = objective + notes + the two checked excerpts.
5. No memory words (dog / coffee records shown in the inspector) in the packet or first message.
6. `v4/cross_mode_origin` references Bot conversation `sess_d7a4e14c…` and the new session.
7. `conversation.json` byte-identical before/after; Continue with Ace reopens the same conversation.
8. Coding keeps its own selection when switching back; the agent then built the CLI "per Ace's plan".
9. `tasks-index.sqlite`: 38 → 39 rows (only the Coding session); Bot-workspace rows unchanged (1, the
   known historical stale row).

## Notes / follow-ups

- Legacy `zcode-session.readSessionMessages` is broken (CLI returns its internal message shape;
  schema rejects it). No UI caller remains; excerpts use the v4 projection instead.
- The dev app's CLI writes to `~/.zcode/cli/db/db.sqlite` (shared with ZCode.app); only host state is
  isolated under `~/.zcode-acevra-dev`. Pre-existing; worth isolating separately.
- Handoff sessions use the target workspace's default model; live tests should first select the Starter
  coding plan and GLM-5.3-Flash Low (the default GLM-5.3 Max hit the usage limit).
- Remote projects are not offered as targets in this milestone.

## Follow-up on `fix/work-on-this-bot-model` (2026-10-03)

- **Model continuity:** the handoff sends the Ace conversation's persisted selection
  (`snapshot.config.modelSelection`) as `createSession.config`. Live: the Coding session ran on
  `account:zai-start-plan` · GLM-5.3-Flash · low (same as Ace) and the first turn completed.
- **Tasks target:** "Work in → Tasks (no project folder)" uses the same app-managed conversation
  workspace as Coding's Tasks → New task; the session lands under Tasks. Live: origin, task index
  (+1, Bot rows unchanged), `conversation.json` unchanged, Continue with Ace verified.
- **Recorded, not fixed:** the target picker (like Automations / Saved Workflows, via
  `buildAutomationWorkspaceOptions`) hides only tabs already flagged `unavailable-local-directory`. A
  project folder deleted while the app runs, or never re-checked, is still offered. Fix belongs to the
  shared workspace-availability detection, not to Work on this.
