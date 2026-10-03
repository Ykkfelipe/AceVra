# Cross-Mode — Bot → Coding "Work on this" (M3)

> Contracts: `docs/specs/cross-mode-continuity.md` (M1, frozen `handoff-packet/v1`) and
> `docs/specs/cross-mode-m2.md` (preview + admission). Bot surface: `docs/specs/personal-bot.md` §16.
> Baseline: `integration/acevra-convergence@191b1bc` (product code `8c61cc4`).

## 1. Product model

| Space          | What it is                                                                                          | What it is not             |
| -------------- | --------------------------------------------------------------------------------------------------- | -------------------------- |
| **Bot / Ace**  | Personal-assistant space: conversation, ideas, planning, research, personal memory, Ace's computers | Not the coding workspace   |
| **Coding**     | Focused work space: projects, coding agents, building/testing; **Multitask is a Coding capability** | Not the assistant space    |
| **Cross-Mode** | Context continuity between the spaces. Carries the relevant context; never merges ownership         | Not an execution subsystem |

Mental model: _I was talking to Ace → we decided something needs real implementation → I pressed
**Work on this** → AceVra moved me into the right project in Coding with the context already there →
I did the work → I returned to Ace and continued the larger conversation._

This milestone ships the forward half (`bot → coding`) and the durable origin seam that the reverse
half (`coding → bot`) builds on. It also ships a navigation-only **Continue with Ace** backlink.

Multitask is **not** a Cross-Mode destination here. A Coding session created by this flow is an ordinary
`interactive` session; if the work later needs parallel workers the user uses Multitask inside Coding
as usual. The frozen flow matrix is unchanged (`bot → multitask` stays disallowed).

## 2. User flow

1. In the Bot view, with a conversation that already has a session, the header's
   `bot-conversation-actions` slot shows **Work on this** (hidden for a fresh draft: there is nothing to
   reference yet).
2. The dialog shows, all driven by the contract preview view model (`buildHandoffPreviewViewModel`):
   - **Project** — pick one of the open local Coding projects (`buildAutomationWorkspaceOptions(tabs)`,
     remote workspaces excluded in this milestone). Required.
   - **Objective** — editable, prefilled from the conversation title (1–500 chars).
   - **Context to carry** — explicit labeled items with include toggles and the byte budget:
     - _Notes for the work_ — free text the user writes (standard).
     - _Recent conversation_ — the latest user/assistant **text** messages of _this_ conversation as
       separate excerpts (standard). The most recent ones that fit the budget start included; older
       ones start excluded. Tool output, attachments, images and system parts are never offered.
   - **Returns to** — "Ace · summary" (fixed `returnPolicy: "summary"`).
   - Blocking issues (sorted, from the contract) replace a silent disabled button.
3. **Start in Coding** freezes the snapshot (`confirmHandoffPreview`) and sends one `createSession`
   with `crossModeHandoff.confirmation` to the target project's runtime.
4. The CLI admits the snapshot, creates and persists the Coding session, records the origin, and starts
   the first turn with the rendered handoff. The desktop switches to that session in Coding.
5. The Coding session shows a **Started from Ace** notice (objective) with **Continue with Ace**, which
   opens the Bot view on the originating conversation.

Not carried, ever (no UI to add them): the personal memory store, the Bot identity/profile, other Bot
conversations, connector/account data. Bot memory is a model-only, non-persisted attachment
(`personal-bot.md` §14), so the transcript read for excerpts cannot contain memory records.

## 3. Ownership

| State / behavior                                    | Owner                                                                           | Notes                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Packet, context caps, preview, confirmation         | `@zcode/shared/cross-mode` (frozen M1/M2)                                       | UI only calls contract functions; no local caps or scoring.                             |
| Which excerpts exist (projection of the transcript) | Bot UI (`packages/ui/src/bot/workOnThis/`)                                      | Pure function over `readSessionMessages`; creates items via `createHandoffContextItem`. |
| Admission + execution (destination work creation)   | CLI Cross-Mode coding intake (`bootstrap/src/app/cross-mode-coding-handoff.ts`) | Re-parses the snapshot, admits via `createHandoffAdmissionService`, executes.           |
| The Coding session                                  | CLI `AgentRuntime` + session store (unchanged)                                  | Normal `interactive`; never `personal_bot`, so no memory injection.                     |
| Durable origin                                      | Session entry `v4/cross_mode_origin` on the **Coding** session                  | One entry per session; written once by the intake; read-only afterwards.                |
| `snapshot.crossModeOrigin`                          | v4 projection (seeded from the entry, like `sharedContextImport`)               | Static metadata: no row, no revision bump.                                              |
| Bot conversation selection (`conversation.json`)    | Bot module (unchanged)                                                          | The handoff never writes it. Only an explicit **Continue with Ace** selects.            |
| Coding task index                                   | Host task-index syncer (unchanged)                                              | Only the new `interactive` session enters it, like any Coding session.                  |

## 4. Protocol (additive, Cross-Mode-generic)

`packages/shared/src/zcode-protocol-v4/cross-mode-origin.ts`:

- `createSession.crossModeHandoff?: { confirmation: HandoffConfirmation }` — the frozen M2
  confirmation (`handoffId`, canonical `packetJson`, `confirmedAt`, `warnings`). Mutually exclusive with
  `firstInput` and `taskType` (the first input is rendered by the CLI from the packet; the session is
  always a normal Coding session).
- The accepted `createSession` ACK result gains `crossModeOrigin?: CrossModeOriginState` (below). The
  desktop requires it whenever it sent `crossModeHandoff`: an old CLI silently drops the unknown key and
  would create an empty session, so a missing origin is treated as a failed handoff (see §6).
- Session entry `v4/cross_mode_origin`, data `CrossModeOriginEntry`:
  `{ version: "cross-mode-origin/v1", confirmation, resultRef, destination, acceptedAt }` where
  `resultRef = { kind: "coding-session", id: <sessionId> }` and
  `destination = { workspacePath, workspaceIdentity? }`. The confirmation is stored verbatim, so the
  original packet (provenance, objective, carried context, return policy) is re-parseable with
  `deserializeHandoffPacket` — no parallel metadata.
- `snapshot.crossModeOrigin?: CrossModeOriginState` — a projection of the entry for display/backlinks:
  `{ version, handoffId, sourceMode, destinationMode, objective, sourceRefs, returnPolicy, resultRef,
acceptedAt }`. Carried context content is **not** projected into snapshots (it is already the first
  user message).

`linkedProject` stays `null`: v1 project refs need an opaque id and no canonical path → project-id
mapping exists yet; the destination workspace is the result-side fact recorded in the entry.

## 5. Event order

```mermaid
sequenceDiagram
  actor User
  participant Bot as Bot UI (WorkOnThisDialog)
  participant Contract as @zcode/shared/cross-mode
  participant CLI as Target project CLI (createSession handler)
  participant Intake as Cross-Mode coding intake
  participant Store as Session store
  User->>Bot: Work on this
  Bot->>Bot: readSessionMessages(Bot session) → excerpts (text only)
  Bot->>Contract: createHandoffPacket(bot→coding, sourceRefs=[conversation:<id>])
  User->>Bot: edit objective / toggle items / pick project
  Bot->>Contract: confirmHandoffPreview → HandoffConfirmation
  Bot->>CLI: createSession{workspaceId, crossModeHandoff{confirmation}}
  CLI->>Contract: deserialize + assertTransferable + destination=coding (before any record)
  CLI->>CLI: createSessionRecord (interactive)
  CLI->>Intake: acceptCrossModeHandoff(confirmation)
  Intake->>Contract: admission.admit → re-parse, dispatched
  Intake->>Store: persist session (title = objective) + v4/cross_mode_origin
  Intake-->>CLI: accepted(coding-session:<id>) + origin
  CLI->>CLI: seed snapshot.crossModeOrigin; start first turn (rendered handoff)
  CLI-->>Bot: ACK accepted {sessionId}
  Bot->>Bot: navigate to Coding session (Bot pointer untouched)
```

Rules:

- Validation failures happen **before** the session record exists (no leaked sessions).
- If the intake rejects after the record exists, the handler closes the session and rejects the ACK.
- The origin is persisted **before** the first turn starts, so it exists even if the turn fails.
- A failure to start the first turn after acceptance keeps the session and origin (the user can resend);
  the ACK reports the input failure as today.

## 6. Failure semantics

| Failure                                                  | Behaviour                                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Dialog blocked (empty objective, budget exceeded)        | Contract issues listed; Start disabled with reasons.                                      |
| Tampered/unparseable snapshot, wrong destination         | ACK rejected `proto.invalidPayload`; no session created; dialog shows the error.          |
| `crossModeHandoff` together with `firstInput`/`taskType` | ACK rejected `proto.invalidPayload`.                                                      |
| Intake rejects / persistence fails                       | Session closed; ACK rejected; dialog stays open with the error; retry is a new attempt.   |
| Old CLI (drops the key)                                  | ACK has no `crossModeOrigin`: the desktop deletes the empty session and shows an error.   |
| Target project removed/read-only                         | Not offered in the picker; navigation failure keeps the user in Bot with a toast.         |
| Origin conversation deleted later                        | Continue with Ace selects it; Bot's existing `sessionNotFound` self-heal clears to draft. |

## 7. Return seam (coding → bot, next milestone)

The entry already answers the three questions a `coding → bot` return needs:

- **which Bot conversation** — `packet.sourceRefs` (`{kind:"conversation", id}`), `sourceMode: "bot"`;
- **which handoff** — `handoffId` (a `HandoffReturnSummary` with the same id satisfies
  `handoffReturnMatchesPacket`);
- **which work session resulted** — `resultRef` (`coding-session:<id>`) + `destination`.

The return milestone adds a `coding → bot` packet/`HandoffReturnSummary` producer in Coding and a
consumer in Bot that shows it in the originating conversation. No second store is needed: the origin
lives with the Coding session; Bot keeps no reverse index. This milestone's **Continue with Ace** is
navigation only (no summary transfer yet).

## 8. Acceptance scenarios

1. Open an existing Ace conversation → **Work on this** is visible; on a fresh draft it is hidden.
2. The dialog lists the open local projects, prefilled objective, notes, recent text excerpts with
   budget; no memory/profile item exists.
3. Confirm → a new `interactive` session exists in the chosen project; the desktop shows it in Coding.
4. Its first user message contains the objective and exactly the included items (excluded items absent).
5. The Bot session never received a memory-derived item; the Coding session never gets personal memory
   injection (`taskType` is not `personal_bot`).
6. `v4/cross_mode_origin` exists on the Coding session; after restart `snapshot.crossModeOrigin` still
   names the Bot conversation, the handoff id and the Coding session.
7. Returning to Bot shows the same selected conversation, unchanged (`conversation.json` not written).
8. Coding/Multitask state is independent: the Coding session can use Multitask normally; Bot has no
   Coding state.
9. No new Bot row appears in the Coding task index; no `personal_bot` row in `tasks-index.sqlite`.
10. **Continue with Ace** opens the Bot view on the originating conversation.

Tests: shared (`crossModeOrigin` schemas/projection), bootstrap (intake admit/reject/persist/render,
handler pre-validation), UI (excerpt projection, draft defaults, dialog gating).

## 9. Out of scope

Bot → Multitask; changing the flow matrix; `coding → bot` summary transfer; durable admission store;
remote target projects; Bot rename/delete; stale task-index migration; mobile layout work.
