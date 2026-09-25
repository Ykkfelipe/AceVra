# Backend migration: switching an existing task's execution backend (phase 11)

Status: **spec agreed, implementation starting.** Written before code per this repo's own
rule — this file exists so the transactional protocol, the normalized transcript contract, and
the restart-recovery state machine are agreed before any of it is built. File/line references
were gathered by direct investigation of the current codebase; they are facts, not
assumptions, but exact row/type names for the zcode-agent's native persisted-message schema
still need confirming at implementation time — flagged inline as **(confirm at
implementation)**. Amended once (2026-09-24) to make the Codex handoff turn a first-class,
inspectable transition event with a constrained prompt contract and tool-activity detection, a
five-phase restart-safe state machine, a richer transition-timeline record, and an explicit
switch-cost confirmation for the Codex direction only.

## Problem and non-goal this replaces

A user hits Z.ai's usage limit mid-task and wants to keep working on the _same_ task, now
answered by Codex, Command Code, or another configured provider — without losing what was
already discussed or decided, and without a new task appearing in the sidebar.

This is **not** the same thing as switching provider within the zcode backend (Z.ai ↔ Azure ↔
Command Code ↔ ...), which already works today (see
[composer-toolbar-presentation.md](../../ui/specs/composer-toolbar-presentation.md)) because
the Agent already resends the whole accumulated message history to whichever provider answers
the next turn — no history conversion needed, no backend change, no new capability. This spec
is only for the two directions that cross the `zcode` ↔ `codex` boundary, where the destination
is a genuinely different program with no shared message history today.

## Terminology (load-bearing, do not conflate)

- **Task** — the stable identity the user sees as "the conversation." One row in the shared
  `tasks` SQLite table (`packages/services/src/session/tasksDatabase/schema-v1.ts:1-24`),
  keyed by `(workspace_key, task_id)`. This identity **never changes** across a migration.
- **Backend** — `zcode` (the built-in Agent, running via a per-session zcode-cli child
  process) or `codex` (the Codex App Server, its own program with its own thread state).
  Stored in `ZCodeTaskMeta.executionBackend` (`packages/shared/src/zcode-task-types-core.ts`),
  itself inside the row's `meta_json` column. **Both backends already read/write the same
  row** via the same `TaskIndexRepo` (`packages/services/src/session/taskIndexRepo.ts`) — this
  spec does not need a new store, only new fields and a new write protocol on the existing one.
- **Provider** — within the `zcode` backend only: which model/API config answers a turn
  (Z.ai, Azure OpenAI, Command Code, ...). Already switchable mid-task; unaffected by this spec.
- **Thread/session identifier** — `codexThreadId` for Codex, or the zcode-cli process's own
  session state for `zcode`. An **execution detail** the task owns, not the other way around.

## Normalized handoff transcript

The one artifact that crosses the backend boundary. Neither backend's native format (Codex's
`ConversationRow`/`ConversationDelta` projection, `packages/services/src/codex/domain/codexProjection.ts`;
zcode-cli's internal `RuntimeMessageEntry`, `apps/zcode-cli/packages/core/src/agent/message-history.ts`)
crosses directly — both get converted to and from this shape.

```ts
interface BackendHandoffTranscript {
  readonly taskId: string;
  readonly generatedAt: number;
  readonly sourceBackend: ZCodeExecutionBackend;
  readonly entries: readonly BackendHandoffEntry[];
  /** Set when compaction ran because the raw transcript exceeded the destination's budget. */
  readonly compacted: boolean;
}

interface BackendHandoffEntry {
  readonly role: "user" | "assistant" | "tool_summary" | "task_note";
  /** Plain text. For tool_summary: a one-line "what happened", never raw tool output. */
  readonly content: string;
  readonly timestamp?: number;
}
```

This is deliberately close to the existing `ZCodeSessionImportMessage`/`ZCodeSessionImportHistory`
shape (`packages/shared/src/zcode-protocol/index.ts:725,734`, used by the Codex-history-_import_
feature) plus one addition: `tool_summary`, because import history is text-only by design
(`codexHistoryImportParser.ts:160`'s own docstring says tool calls/reasoning are dropped) but
this spec's user explicitly wants "relevant tool/action history and useful results" carried
over — a summarized _outcome_, not the raw tool payload.

### What is included

- User-visible user messages and assistant responses (`role: "user" | "assistant"`).
- Tool/action history, reduced to a one-line outcome per meaningfully-completed action
  (`role: "tool_summary"`, e.g. `"Edited src/foo.ts: added retry logic"` —
  not the diff, not the full command output).
- Important task state/decisions worth carrying forward as an explicit `task_note` entry when
  they would not survive summarization otherwise (e.g. "user asked to keep functions under
  400 lines"), synthesized during construction, not copied from a raw source.
- The current workspace path and any artifact references (file paths, task-artifact ids)
  needed to keep working — carried as `task_note` entries, since both backends already
  resolve artifacts by path/id independent of which backend created them.

### What is excluded — enforced by construction, not by best effort

- Codex reasoning/internal items — `CodexThreadProjection` rows of kind `"reasoning"`
  (`codexProjection.ts` imports `isToolItemKind`; reasoning items are a distinct row kind) are
  dropped by the converter before a `BackendHandoffEntry` is ever created for them, not
  filtered afterward.
- Provider-private/internal wire events, auth tokens, credentials, raw Codex stderr/OAuth
  material — none of these ever reach `ConversationRow`/`RuntimeMessageEntry` in the first
  place (existing boundary: `codexExecutionServiceImpl.ts:5-6`'s own comment: "bridge 的
  stderr、auth 面、OAuth URL 一律不进入本文件"), so the converter has nothing to filter — the
  exclusion is inherited from the existing projection boundary, not newly invented here.
- Telemetry, RPC/log noise — never part of `ConversationRow` or `RuntimeMessageEntry` either.

### Oversized transcripts: reuse the existing compaction philosophy, not a new mechanism

There is no single reusable `compact(messages, maxTokens) → messages` pure function today —
`compactActiveConversationImpl` (`apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts:142`)
is bound to a live `AgentRuntimeInternal` and calls a model to produce a prose summary, then
reassembles `[prefix] + [summary] + [preserved tail]` via
`buildPostCompactRuntimeEntries` (`apps/zcode-cli/packages/core/src/runtime/helpers/compact.ts:72`).

The handoff path must follow the **same shape of behavior** — summarize older content with a
model call, preserve the most recent entries verbatim — rather than truncating or failing:

1. Estimate the transcript's token count (reuse `estimateMessageTokens`,
   `apps/zcode-cli/packages/core/src/compact/manual.ts:102`, adapted to `BackendHandoffEntry`).
2. If it fits the destination's advertised context window (with the same reserve/buffer
   `shouldAutoCompact`, `compact/policy.ts:90`, already uses) — send as-is, `compacted: false`.
3. If it does not fit: split into an older prefix and a recent tail sized to fit, run one
   summarization call over the prefix using the same prompt-construction approach as
   `buildCompactPrompt` (`compact/prompt.ts`), and assemble
   `[task_note: "prior context summary"] + [summary] + [recent tail as-is]`. `compacted: true`.
4. Never silently drop the whole thing and never fail the migration solely because the
   transcript was long — compaction failing (the model call itself erroring) _is_ a migration
   failure and follows the rollback rule below, but "transcript is large" alone is not.

**(confirm at implementation)** the destination's advertised context window: for a zcode
provider, `ModelSelectionProviderView`'s resolved `properties.contextWindow`
(`packages/provider/src/facades.ts:198`); for Codex, the curated `CODEX_MODEL_OPTIONS` entry
does not currently carry a context-window number (`packages/shared/src/codex-execution.ts`) —
this spec assumes a conservative fixed budget for Codex handoff turns until that's added.

## State ownership and event order

`pendingBackendTransition.phase` is an explicit 5-value state machine, not a boolean "in
progress" flag — each phase is a distinct, restart-safe checkpoint:

```ts
type BackendTransitionPhase =
  | "prepared" // transcript built (and compacted, if needed); nothing external created yet
  | "destinationCreated" // Codex thread exists (thread/start ok) / zcode process spawned, not seeded/verified
  | "handoffRunning" // Codex turn/start in flight, OR zcode seed-rows write + readiness check in flight
  | "readyToCommit" // destination confirmed ready; about to write the commit
  | "committed"; // terminal — same tick as clearing pendingBackendTransition, never observed at rest
```

`"committed"` is never actually read back as a resting state: the commit write clears
`pendingBackendTransition` and appends the `backendTransitions` record in the same
`syncTaskMeta` call (single row, single statement — see below), so a reader either sees
`pendingBackendTransition` in one of the first four phases (migration in flight or crashed
mid-flight) or sees no `pendingBackendTransition` at all with a fresh `backendTransitions`
entry (migration finished, one way or the other). The literal is still named for symmetry
with the transition record's own `status`, and because the orchestration function's internal
state briefly holds it between "destination confirmed ready" and "the commit write returns."

```mermaid
sequenceDiagram
  participant U as User (Provider menu)
  participant T as Task record (TaskIndexRepo, single SQLite row)
  participant Old as Old backend runtime
  participant New as New backend runtime
  U->>T: request migration to <backend, provider>
  Note over T: reject outright if pendingBackendTransition already set (no concurrent migrations)
  T->>Old: read live/persisted history (Old remains authoritative and untouched throughout)
  Old-->>T: BackendHandoffTranscript, canonical entries only (never a prior handoff exchange)
  T->>T: write pendingBackendTransition{phase:"prepared", transcriptRevision, compacted}
  T->>New: create (Codex thread/start) OR (spawn zcode-cli for this session)
  New-->>T: phase→"destinationCreated"
  T->>New: run handoff (Codex turn/start with the constrained prompt) OR (write seed rows + confirm ready)
  New-->>T: phase→"handoffRunning" while in flight
  alt destination ready and, for Codex, turn reached a normal terminal state with no unexpected tool activity
    T->>T: phase→"readyToCommit"
    T->>T: ONE syncTaskMeta write: executionBackend=new, codexThreadId?/provider?, append backendTransitions{status:"committed",...}, clear pendingBackendTransition
    T->>Old: dispose (only now)
    T-->>U: conversation continues, same taskId; handoff shown as a collapsed transition marker
  else any step failed (create, handoff turn errored/timed out, unexpected tool activity detected, compaction's model call failed)
    T->>T: ONE syncTaskMeta write: append backendTransitions{status:"failed", failureReason}, clear pendingBackendTransition — executionBackend untouched
    T->>New: best-effort cleanup (abandon created Codex thread / kill spawned zcode-cli process)
    T-->>U: migration failed, nothing changed, old backend still fully usable
  end
```

The task row is the **only** owner of "which backend is authoritative right now." Neither
backend runtime is ever allowed to assume it owns that decision — this mirrors the existing
architecture rule that Main/host processes never carry task/session business state themselves.
**Before `"committed"`, `executionBackend` is never written** — not even optimistically — so a
reader checking `executionBackend` alone (ignoring `pendingBackendTransition` entirely) always
gets the correct answer with no special-casing.

### Restart-during-migration

`pendingBackendTransition` is written to the _same_ `meta_json` row via `syncTaskMeta`
(**not** the narrower `updateTaskState` patch path, which today silently drops
`executionBackend`/`codexThreadId` writes — `taskIndexRepo.ts:1604-1612` whitelists neither;
`persistCodexTurnOverride`'s fire-and-forget pattern, `codexTaskPersistence.ts:2-3`, is the
anti-pattern this spec explicitly does not repeat: migration writes must be confirmed, not
fired-and-forgotten). Because it lives in the same row as `executionBackend`, it survives a
restart for free, the same way `executionBackend`/`codexThreadId` already do today with zero
extra work (`taskIndexRepo.ts`, `runTasksDatabaseMigrations`,
`packages/services/src/session/tasksDatabase/startup.ts`).

On task load, the rule is unambiguous regardless of which of the four resting phases
(`prepared`/`destinationCreated`/`handoffRunning`/`readyToCommit`) is found — **ownership is
decided by `executionBackend` alone, never inferred from whether a destination happens to
exist**:

- `pendingBackendTransition` present, in any phase → the migration did not commit before the
  process ended. `executionBackend` (unchanged this whole time) is authoritative. Clear
  `pendingBackendTransition`, append a `backendTransitions` record with
  `status: "failed"`, `failureReason: "restart"`. Best-effort clean up anything the new side
  may have partially created — an orphaned Codex thread or an orphaned zcode-cli process is
  harmless to abandon; nothing in the task record ever pointed to it before commit, so nothing
  needs to be un-pointed.
- `pendingBackendTransition` absent → `executionBackend` is authoritative, full stop, whether
  or not a Codex thread exists somewhere. A Codex thread's mere existence is never sufficient
  to make it the active backend for a task.

Never resume a migration blind after restart — the transcript that was being sent may be stale
relative to messages that arrived through the (still-authoritative) old backend before the
crash. A retried migration after restart builds a **fresh** transcript from current history.

### Backend transition timeline

No task-level lifecycle log exists today (confirmed: no "timeline"/"audit"/"eventLog" hits
anywhere in `packages/services` or `packages/shared`). Add one field, not a new table — it is
small, append-only, and always read/written with the rest of `meta_json`. No secrets, no raw
provider-private state — only identifiers and status:

```ts
interface BackendTransitionRecord {
  readonly startedAt: number;
  readonly committedAt?: number;
  readonly failedAt?: number;
  readonly from: ZCodeExecutionBackend;
  readonly to: ZCodeExecutionBackend;
  readonly fromProviderId?: string;
  readonly toProviderId?: string;
  /** Execution identity on the source side at the moment of transition (opaque, no secrets). */
  readonly sourceExecutionRef?: string; // e.g. the codexThreadId being left, if from === "codex"
  /** Execution identity created on the destination side. */
  readonly destinationExecutionRef?: string; // e.g. the new codexThreadId, if to === "codex"
  readonly status: "committed" | "failed";
  readonly failureReason?: string;
  /** Content hash of the BackendHandoffTranscript actually sent — lets two transitions be
   *  compared without re-serializing the full transcript into this record. */
  readonly transcriptRevision?: string;
  readonly transcriptCompacted: boolean;
  /** Set only when to === "codex": the real turn id Codex assigned to the handoff turn,
   *  so the exchange stays inspectable (see "Handoff turn representation" below). */
  readonly handoffTurnId?: string;
}
// on ZCodeTaskMeta:
backendTransitions?: readonly BackendTransitionRecord[];
pendingBackendTransition?: {
  readonly phase: BackendTransitionPhase;
  readonly to: ZCodeExecutionBackend;
  readonly toProviderId?: string;
  readonly requestedAt: number;
  readonly transcriptRevision?: string;
  readonly compacted?: boolean;
  readonly destinationExecutionRef?: string; // filled once known, e.g. after thread/start
  readonly handoffTurnId?: string; // filled once turn/start returns a turn id
};
```

### Handoff turn representation (Codex direction only)

The `turn/start` call that seeds Codex is a real turn with a real reply — it must never be
rendered as an ordinary user/assistant exchange, and it must never be silently discarded
either. Both requirements are met by extending the **existing** timeline-marker mechanism
(`timelineMarkerPayloadSchema`, `packages/shared/src/zcode-protocol-v4/rows.ts:332-392`) —
already used for exactly this shape of thing (`"compact"` has a `running`/`success`/`failed`
status and a `summaryRef`; `"modelChange"` renders a from→to divider) — with one new variant:

```ts
z.object({
  type: z.literal("backendTransition"),
  status: z.enum(["running", "success", "failed"]),
  fromBackend: zcodeExecutionBackendSchema,
  toBackend: zcodeExecutionBackendSchema,
  fromProviderId: z.string().optional(),
  toProviderId: z.string().optional(),
  transcriptCompacted: z.boolean(),
  /** Row id of the actual handoff turn's underlying rows, kept for "Show handoff details" —
   *  the real request text and the real Codex reply are never deleted, only hidden by
   *  default behind this marker. */
  detailRowIds: z.array(z.number()).optional(),
  failureReason: z.string().optional(),
});
```

Rendering (`TimelineMarkerRowView`, `packages/ui/src/v4/ConversationRowView.tsx:1787-1894`,
same `switch (marker.type)` that already handles `"compact"`/`"modelChange"`): a divider row
reading "Switched Agent → Codex" / "Context transferred", `running` while `status ===
"running"`, click-to-expand ("Show handoff details") revealing the rows referenced by
`detailRowIds` — the actual handoff prompt and Codex's actual reply, unmodified. Nothing about
the exchange is deleted; it is folded, the same UI concept `"compact"` already uses for its
own summary/detail split.

### Canonical history must never accumulate handoff turns

A task migrated `Agent → Codex → Agent → Codex` must not have its second handoff transcript
contain the first handoff's prompt-and-acknowledgement as if it were ordinary conversation —
that both wastes context and would let handoff prompts nest recursively. Enforced structurally:
the transcript-building converters (zcode-history → normalized, Codex-projection → normalized)
**skip any row/entry whose originating turn is referenced by a `"backendTransition"` marker as
one of its `detailRowIds`**, the same way the Codex-projection converter already skips
`"reasoning"`-kind rows. A handoff exchange is queryable forever (via the marker's
`detailRowIds` and the `backendTransitions` timeline), but it is never again treated as
canonical task history once a marker exists for it.

## Direction-specific mechanics

### Provider A → Provider B, both within `zcode` — already shipped, unaffected

Covered by today's `handleDraftSelectProvider` write path
(`packages/ui/src/v4/composer/useDraftConfigControl.ts`) and the Provider-menu visibility fix
in `composerToolbarPresentation.ts`'s `shouldShowComposerProviderMenu`. No transcript
conversion, no task-meta write, no new capability — this spec must not regress it.

### `zcode` → `codex`

Codex's wire protocol has **no seed/history parameter of any kind.** `thread/start`
(`packages/services/src/codex/app/codexTaskRuntime.ts:161-166`, method `"thread/start"`,
`codexWire.ts:11`) accepts only `cwd`/`approvalPolicy`/`sandbox`/`model` — it opens an empty
thread. The only way to put content in front of Codex is `turn/start`
(`codexExecutionServiceImpl.ts:234-238`) with `input: [{type:"text", text}]` — **a real turn
Codex actually executes and replies to.** There is no free or silent seeding mechanism; this
is a hard protocol fact, not an integration gap to route around.

Consequence, stated plainly rather than glossed over: seeding Codex costs one real turn
(tokens, latency, a real model reply) on the destination. The migration:

1. Builds the `BackendHandoffTranscript` from the zcode session's persisted message history
   (**confirm at implementation**: exact read path — likely the same message store the
   session already rehydrates from on resume/app-restart, not `RuntimeMessageEntry`, which is
   in-process-only). `pendingBackendTransition.phase = "prepared"` once built.
2. Calls `thread/start` for a **new** Codex thread (task id and title carried over as `title`,
   not as identity — Codex has no concept of "this is task X"). On success,
   `phase = "destinationCreated"`, `destinationExecutionRef` set to the new thread id.
3. Sends one `turn/start` — `phase = "handoffRunning"` while in flight — whose `input` text is
   the transcript (compacted if needed), built from a **fixed, non-negotiable prompt
   template** (not left to per-call string assembly) that explicitly states, in this order:
   this is a context-transfer turn, not a request to redo or continue the task yet; do not
   modify files; do not run tools unless the protocol leaves no other way to acknowledge;
   do not summarize the transferred history back; respond only with a short readiness
   acknowledgement. The template asks for a **deterministic marker** the app can recognize
   (e.g. the literal token `ACEVRA_HANDOFF_READY` somewhere in the reply) but treats it as a
   hint, not a contract: a normal `turn/start` terminal state (not `error`, not timeout) with
   the marker present is the strong-confidence success signal; a normal terminal state
   _without_ the marker is still accepted as success (the model complied but paraphrased) — the
   app does not fail a working handoff over exact string matching. Only `error`/timeout is a
   turn failure.
4. **Unexpected tool/action activity during the handoff turn is detected, not silently
   accepted.** Codex's protocol has no mechanical way from the caller side to forbid tool use
   on a single turn (**confirm at implementation**: check whether `turn/start`'s
   `approvalPolicy` can be tightened to `never`-approve for this one call, which would make any
   attempted tool use surface as a rejected approval rather than a silent action — if so, use
   it; that is the one mechanical lever the spec assumes is checked before deciding to fall
   back to detection-only). If any tool-call item appears in the handoff turn's projection:
   the migration treats it as a failure (`failureReason: "unexpected_tool_activity_in_handoff"`),
   not as a normal handoff — a handoff turn that touched files or ran commands is not a safe
   commit, regardless of what it said.
5. Only after the turn reaches a normal terminal state **and** no unexpected tool activity was
   observed does the state advance to `"readyToCommit"` and then commit in one write:
   `executionBackend: "codex"`, `codexThreadId`, append `backendTransitions` (`status:
"committed"`, `handoffTurnId` set), clear `pendingBackendTransition`.
6. The handoff turn's rows are marked via a `"backendTransition"` timeline marker
   (see below) referencing them as `detailRowIds` — rendered as a collapsed "Switched Agent →
   Codex / Context transferred" divider, expandable to the real prompt and the real reply,
   never deleted and never replayed as ordinary history in a future migration.
7. On any failure (thread/start rejects, turn/start errors or times out, unexpected tool
   activity, transcript compaction's model call failed): the zcode task/session is untouched
   and still fully usable; `backendTransitions` gets a `status: "failed"` record with a
   `failureReason`; the orphaned Codex thread (if `thread/start` succeeded but the turn didn't,
   or the turn succeeded but tool activity failed it) is abandoned, never referenced by the
   task, and needs no explicit cleanup call since nothing points to it.

### `codex` → `zcode` (or directly to a specific `zcode` provider)

The reusable primitive here already exists and does **not** invoke a model:
`persistImportedSessionHistory` (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts:996`),
used today by Codex-history _import_ to write a flat message history as ordinary persisted
`Message`/`Part` rows before a session ever starts. This spec reuses that same
persist-then-start pattern, but targets the **existing** task's session store instead of
creating a new session:

1. Build the `BackendHandoffTranscript` from Codex's **live** projected history
   (`CodexThreadProjection`'s row log, not the JSONL-file import parser — that parser is a
   different data source entirely and is not touched by this spec), filtering out reasoning
   rows, tool raw output, and any prior handoff turn (per the canonical-history rule above) at
   conversion time. `phase = "prepared"`.
2. Write the (compacted-if-needed) transcript as persisted message rows into the existing
   task's session store, in the same format normal zcode conversation turns already persist
   as (**confirm at implementation**: exact insertion function — sibling to whatever
   `persistImportedSessionHistory` calls internally, but parameterized by an existing
   `taskId`/session rather than a freshly created one). No model call, so `phase` moves
   straight to `"destinationCreated"` once the rows are written — there is no separate
   in-flight "running" state the way Codex's real turn has one.
3. Start (or confirm already-running) the zcode-cli process for that session/workspace with
   the selected provider — `phase = "handoffRunning"` while spawn/readiness is pending — and
   confirm it reaches a ready state (the same signal used for today's "prewarm" path when a
   draft first becomes a real task). On success, `phase = "readyToCommit"`.
4. Only after that readiness signal commits, in one write: `executionBackend: "zcode"`, the
   selected `provider`/`modelSelection`, append `backendTransitions` (`status: "committed"`),
   clear `pendingBackendTransition`.
5. On any failure (process fails to spawn, provider rejects the config, persisted-row write
   fails): the Codex task/thread is untouched and still fully usable; any partially-written
   persisted rows for the failed attempt are deleted, not left as an orphaned duplicate of the
   conversation; `backendTransitions` gets a `status: "failed"` record with a `failureReason`.

## Switch confirmation UX

Provider-to-provider switching within `zcode` (already shipped) stays a plain click — no
confirmation, because it has no extra cost. Switching to Codex specifically consumes one real
Codex turn, so it gets one confirmation step naming that cost plainly (not alarmingly):
"Codex requires one initialization turn to receive this conversation's context" with a
Switch button. Codex → `zcode` has no such cost (seeding is a silent persisted-row write, no
model call) and stays a plain click like provider-to-provider switching.

This confirmation is for **manual** switching only. A future automatic-fallback feature (e.g.
auto-retry on a different provider when one hits a rate limit) must not consume a Codex turn
on the user's behalf without the user having separately, explicitly opted into automatic
fallback with cost — this spec does not build automatic fallback, only leaves the one-click
manual path from a confirmed switch decision.

## Acceptance scenarios

1. Z.ai → Azure OpenAI mid-conversation (already shipped): conversation continues in place,
   no transcript conversion, no task-meta write beyond the existing model-selection path.
2. zcode (Z.ai) → Codex: task keeps its id, sidebar entry, and title; the visible transcript
   shows prior zcode turns, one collapsed "switched to Codex" marker, then Codex's replies;
   `executionBackend` reads `"codex"` only after the seed turn succeeded.
3. Codex → zcode (Command Code): same task id; prior Codex turns appear as ordinary persisted
   history (tool-call rows summarized, no reasoning rows); the next reply comes from Command
   Code; `executionBackend` reads `"zcode"` only after the zcode process confirmed ready.
4. Oversized transcript (either direction): migration succeeds, `compacted: true`, older
   content is a one-line-referenced summary, the most recent turns are verbatim.
5. Destination fails to become ready (Codex turn errors; zcode-cli fails to spawn): task is
   unchanged, still on its original backend, still fully usable; user sees a clear failure, not
   a stuck or duplicated task.
6. App restarts with `pendingBackendTransition` set (crash mid-migration): on next load, the
   field is cleared, the task resumes on whichever backend was authoritative before the
   attempt — never on a half-configured destination.
7. Two migration attempts on the same task cannot race: the existing per-task write queue
   (`enqueueWrite`, `taskIndexRepo.ts:664-682`) serializes them; the second attempt reads
   `pendingBackendTransition` already set by the first and is rejected outright rather than
   started concurrently.
8. `backendTransitions` on a task that migrated twice shows both transitions in order, each
   with `from`/`to`/`transcriptCompacted` — enough to explain "why is this Codex now" without
   guessing.
9. A handoff turn that triggers a tool call is treated as a failed migration
   (`failureReason: "unexpected_tool_activity_in_handoff"`), even though `turn/start` itself
   returned a normal terminal state — a "successful-looking" turn is not sufficient if it
   touched files or ran commands.
10. Chain: `Agent(Z.ai) → Agent(Command Code) → Codex → Agent(Azure) → Codex`, one task id
    throughout. Of the four hops, only the first (`Z.ai → Command Code`) is provider-only and
    produces no timeline entry, per the "already shipped, unaffected" rule above — the other
    three all cross the `zcode`/`codex` boundary. After the full chain: `backendTransitions`
    has exactly **three** entries, `[zcode→codex, codex→zcode, zcode→codex]`, all `status:
"committed"`; the second Codex handoff's (the fourth hop's) transcript contains the
    Azure-answered turns plus everything before them **except** the first Codex handoff's own
    prompt/acknowledgement (excluded by the canonical-history rule); no artifact or workspace
    reference is lost; a simulated failure at each phase of the _third_ hop
    (`Codex → Agent(Azure)`: `prepared`/`destinationCreated`/`handoffRunning`/`readyToCommit`,
    and a restart injected at each) leaves the task on Codex, never on a half-configured
    `zcode`/Azure destination.

## Explicitly out of scope for this phase

- Making `turn/start`'s destination-side reply _not_ count as a visible turn — not possible
  given the protocol; scope is to render it distinctly, not to eliminate it.
- A context-window number for Codex models in `CODEX_MODEL_OPTIONS` — needed for precise
  compaction sizing on the `zcode → codex` direction; tracked as a prerequisite, not solved
  here (a conservative fixed budget is used until it exists).
- Migrating a task that has a currently in-flight (unfinished) turn on the old backend —
  migration should be blocked while a turn is running, the same way other draft-only actions
  already are; not designing the interrupt-and-migrate case in this phase.

## Amendment 3 (2026-09-24): live persistence wiring

Written before the TaskIndexRepo wiring, after reading the real write paths. Facts found
during investigation, then the decisions they force.

### Facts found in the real code

- `syncTaskMeta` writes `{ ...params.meta }` wholesale. The zcode snapshot syncer
  (`zcodeTaskIndexSyncer.ts#buildMetaFromSnapshot`) builds meta from a runtime snapshot that
  never carries `executionBackend`/`codexThreadId`/transition fields. Any snapshot sync on a
  migrated task would therefore silently revert `executionBackend` to "zcode" and erase
  `pendingBackendTransition`/`backendTransitions`. The spec's "use syncTaskMeta" instruction is
  unsafe as written.
- `tasks-index` is shared by every window's Local Host (`PRAGMA busy_timeout` comment in
  `TaskIndexRepo.initialize`). The in-process `enqueueWrite` chain serializes writes only within
  one Host process, so it cannot by itself stop two Hosts from starting two migrations, nor stop
  one Host's startup recovery from clearing another live Host's in-flight migration.

### Decisions

1. **Migration-owned fields have exactly one writer.** `pendingBackendTransition` and
   `backendTransitions` are written only by `TaskIndexRepo.applyBackendMigrationPatch`.
   `syncTaskMeta` always carries them over from the existing row, and carries
   `executionBackend`/`codexThreadId` over when the incoming meta omits them (Codex task
   creation still sets them explicitly on a new row).
2. **Fenced compare-and-set writes.** `applyBackendMigrationPatch` runs inside
   `BEGIN IMMEDIATE` (the SQLite write lock is the cross-Host serializer) and takes a fence:
   - `{ kind: "begin" }` — succeeds only if no `pendingBackendTransition` exists; this is the
     durable admission check, and it holds across Hosts.
   - `{ kind: "owned", requestedAt, ownerInstanceId }` — succeeds only if the stored pending
     transition is still the caller's. A writer whose transition was cleared (by recovery or
     anything else) gets `BackendMigrationFenceError` and must not commit.
     Transition records are appended inside the same transaction from the row's current list,
     never from a caller-held copy.
3. **Owner identity.** `PendingBackendTransition.ownerInstanceId` (`<pid>:<bootUuid>`) is written
   at `begin`. Recovery clears a pending transition only when its owner is not alive (a
   different boot of this Host, or a pid that no longer exists). A live Host's in-flight
   migration is never recovered from under it. There are no time-based heuristics.
4. **Recovery result.** An orphaned pending transition is closed with a `failed` record,
   `failureReason: "restart"`, and `executionBackend` untouched, per "Restart-during-migration".
   Destination cleanup is best-effort and keyed by the record's `destinationExecutionRef`.
5. **Orchestrator write contract.** `writeTaskMetaPatch` takes a typed patch
   (`pendingBackendTransition` / `appendTransition` / commit fields). It does not take a full
   replacement `backendTransitions` array. A failed intermediate write ends the attempt:
   destination cleanup, then a best-effort failure record with `failureReason:
"persistence_failed"`. If the commit write throws, the outcome is in doubt. The
   orchestrator re-reads the row and reports what is actually persisted, instead of assuming
   either outcome.
6. **Success marker after commit.** The "success" timeline marker is written only after the
   commit write returns. A marker must never claim a switch the task row does not reflect.

### Resolved: open questions from the first draft of this amendment

Both were resolved by Amendment 4 (assembled timeline) below.

## Amendment 4 (2026-09-24): AceVra owns the visible timeline

Approved direction: a migrated task renders as **ordered execution segments + persisted
transition markers**. It never renders as "whatever rows the current backend returns". No second
canonical transcript store is added. The migration layer persists only ownership, segment
boundaries, execution identities and transition records. Rows are always read from the backend
that produced them.

### Segment model (derived, not stored)

`deriveBackendTimelineLayout(meta)` (pure, `packages/shared/src/backend-timeline.ts`) derives the
segments from `executionBackend`/`codexThreadId` plus the **committed** `backendTransitions`
records, in order. Failed records never open a segment.

| Segment source                         | Rows that belong to it              | Hidden inside it                                 |
| -------------------------------------- | ----------------------------------- | ------------------------------------------------ |
| `zcode` session (`sessionId = taskId`) | `afterRowId < rowId ≤ throughRowId` | nothing else (the range excludes seeds)          |
| `codex` thread (`threadId`)            | every row of that thread            | rows whose `sourceTurnId` is the handoff turn id |

Boundaries come from facts recorded at commit time:

- `zcode → codex` record: `sourceLastRowId` = last zcode row id of the closing Agent segment
  (its `throughRowId`); `destinationExecutionRef` = new thread; `handoffTurnId` = the **Codex**
  turn id of the handoff turn.
- `codex → zcode` record: `sourceExecutionRef` = the Codex thread being left;
  `destinationSeedLastRowId` = last zcode row id after the seed rows were written. The new Agent
  segment is `rowId > destinationSeedLastRowId`. Everything at or below it is either an earlier
  Agent segment (already shown with its own range) or migration-seeded context. Seeded
  replicas are therefore excluded by a deterministic row-id boundary. That boundary survives
  restart because zcode row ids are a deterministic function of the persisted event log. The
  destination's first real user message and reply are always above the boundary, so they stay
  visible.
- Segment 0 of a zcode-origin task has no lower bound. Segment 0 of a Codex-origin task is the
  first record's `sourceExecutionRef`.

zcode row ids are stable across restart. Historical Agent segments are read only through
row-id ranges, and rows in a historical segment lose their `actions` (no edit/rewind/fork into a
closed segment). A rewind in the live segment therefore cannot cross a boundary.

### Stable Codex turn identity

Rows gain an optional `sourceTurnId` (execution-backend-native turn id; additive, ignored by
old clients). The Codex projection fills it from `item/*` notifications and from the
`{turnId, item}` wrapper of `thread/items/list`. It also back-fills the user-input and turn-header
rows of a host-started turn once `turn/start` returns the Codex turn id. The UI `turnId` and
`rowId` stay as they are; `sourceTurnId` is a separate field. Rebuilt history no longer loses the
turn identity to `"codex-history"`.

### Composed row ids

The UI store orders by `rowId` ascending and pages with `beforeRowId`. The composer keeps the
**live** segment's row ids unchanged. Live commands, deltas, plans, rewind targets and
pagination cursors therefore need no translation. Historical segments and markers get negative ids:

- `STRIDE = 2^40`, `n` = segment count, live segment = `n-1`
- historical row: `(k − (n−1))·STRIDE + 1 + sourceRowId`
- marker opening segment `k ≥ 1`: `(k − (n−1))·STRIDE − 1`

Source row ids must be in `[0, STRIDE − 2)`. Rows outside that range are dropped and logged,
never wrapped. The composed `logEpoch` is `<liveEpoch>::bt<committedCount>`, so a commit
(layout change) invalidates cached windows and resume bases.

### Markers from persisted task meta only

Transition markers are synthesized from `backendTransitions` records by the composer. Nothing
is appended to a backend's own row log (the orchestrator's `appendBackendTransitionMarker`
dependency is removed). The marker carries status, from/to backend, from/to provider id and
`transcriptCompacted`. "Show handoff details" resolves the handoff rows on demand by the
record's `handoffTurnId` against the destination thread. It is never keyed by UI row ids.

Failed transitions do **not** create a segment and do not insert a timeline marker. They stay
in `backendTransitions` for diagnostics, and the switch control reports the failure inline
("Switch to Codex failed, the original Agent session remains active"). A failed destination
thread is never a read source.

### Canonical history for later migrations

The handoff transcript is built from the **composed** timeline (all segments, handoff turns and
seeds already excluded), not from the source backend's raw row log. This replaces the
`detailRowIds` exclusion rule. Repeated `Agent → Codex → Agent → Codex` therefore carries exactly
one canonical history.

### Read vs write authority

- **Write authority**: only `task.executionBackend`. Commands (send, stop, approvals, edit)
  route to the live segment's backend only.
- **Read history**: any segment source listed by the layout, read-only. Reading a historical
  Codex thread uses a read-only `thread/items/list` rebuild that never registers a runtime.
  Only thread ids named by the task's own committed records are accepted.
- The routing cache is keyed by the task's `layoutVersion`. A commit, observed through the task
  meta change, replaces the live subscription and emits a fresh composed snapshot.

### Pagination

The initial window is the live snapshot's window. When the live window is short, it is
prefilled with the tail of earlier segments, bounded by the protocol's tail window size.
`rowsRange(beforeRowId)` pages backwards across segments and markers. zcode segments page
natively with `beforeRowId` clamped to the segment range. A historical Codex thread is read
whole: the Codex API only offers forward paging, and the live rebuild path already does the same.
The result is cached per `(threadId, layoutVersion)`. Follow-up: bounded Codex reads need a
reverse cursor from Codex.

### Public share / export

The share projection consumes the composed rows. User/assistant/tool rows from committed
segments project normally. Reasoning stays excluded. Handoff turns and seeds are never present
because the composer already removed them. The marker projects in the minimal compact-like form:
status, from/to backend and compaction flag only. It carries no thread id, no turn id and no
provider-private data.

### Normal turns during a migration

While `pendingBackendTransition` exists, a normal send is rejected with the typed command
rejection `backendTransitionInProgress`, and a second migration is rejected by the begin fence.
No queueing: there is no serialized queue that survives an ownership change. The UI keeps the
draft and re-enables send when the transition resolves.

### Composer controls (UI)

- **Entry points.** The provider/backend menu is the only place a migration starts. In a draft
  it keeps writing the local draft exactly as before (no migration — there is no task yet). In a
  live task the same menu routes through `switchTaskBackend`; selecting Codex opens a cost
  confirmation ("Switch to Codex — Codex requires one initialization turn to receive this
  conversation's context."), selecting an Agent provider migrates back without a confirmation
  because Codex→Agent spends no inference turn. Both are one transactional request; the UI never
  writes `executionBackend` itself. A Codex→Agent provider selection must use the normal completed
  model-selection serializer (including required reasoning-level options); it must not hand-build
  `providerId/modelId` and drop provider-required selection fields.
- **Menu visibility.** On a live Codex task the provider menu is normally hidden (Codex's own
  model/effort controls take over). It becomes visible only when the Host registered the
  migration service, because then it is the sole path back to Agent
  (`shouldShowComposerProviderMenu(..., backendMigrationAvailable)`).
- **No optimistic completion.** The dialog reflects persisted state: a `pendingBackendTransition`
  (from any window/device) renders a progress state and cannot be dismissed; the backend shown in
  the composer does not flip until the commit event arrives. `rejected` and `inDoubt` each render
  their own message; `failed` renders "Switch to X failed — the original Y session remains active"
  with the original backend still authoritative.
- **Disabled during pending.** While this window's request is in flight or a persisted transition
  is pending, the composer is disabled (send + all backend/provider controls). The Host rejects
  too, but the UI refuses first for a deterministic experience.
- **Marker details.** "Show handoff details" is only offered on a committed Agent→Codex marker
  that recorded a handoff turn, and loads the real handoff request/acknowledgement by Codex turn
  id. It is never keyed by UI row ids.
