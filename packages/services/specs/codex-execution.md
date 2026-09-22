# Codex execution backend (phase 10)

Status: vertical slice implemented, **not yet E2E-verified against paid Codex inference**.
The App Server protocol facts below come from the installed binary's own protocol strings
(`strings /Applications/ChatGPT.app/Contents/Resources/codex`, codex-cli 0.155.0-alpha.9.2)
and from the shipped account bridge (`accounts/codexAppServerBridge.ts`). Method/event
payload shapes are typed defensively and must be confirmed by the first authorized E2E run
(see "E2E checklist" at the bottom).

## Goal and non-goals

Codex is a **first-class agent backend**, not another model provider:

- Codex keeps its own agent loop: harness task → Codex thread (`thread/start`) → turn
  (`turn/start`) → Codex App Server notifications → projection.
- Codex is NOT routed through the ZCode model adapter / zcode-cli runtime. No
  `IZCodeAgentService` session is created for a Codex task.
- The shared v4 task UI renders Codex tasks: the Codex backend **projects** Codex thread
  items into the frozen v4 conversation contract (`zcode-protocol-v4`: rows, deltas,
  snapshot, command envelope). No new conversation renderer.

Non-goals for this phase: Claude execution backend, composer redesign, Codex model picker
(`model/list`), attachments on Codex turns, workflow/subagent rows, goal/plan state.

## Architecture

```
Renderer (shared task UI)                Host (one process)
─────────────────────────                ──────────────────────────────────
SessionPane ── SessionDataLayer ──┐      codex-execution channel
                                  │      ┌────────────────────────────────┐
              BackendRouting      │      │ ICodexExecutionService         │
              ConversationTransport      │  (codexExecutionServiceImpl)   │
              ├─ zcode topics ────┼──→   │  · task registry (per taskId)  │
              │   agentConversationTransport → zcode-agent channel → CLI
              └─ codex topics ────┼──→   │  · CodexThreadProjection       │
                  codexConversationTransport     (row log + seq + fan-out)
                                       │  · taskIndexRepo sync (meta_json)│
                                       │  · CodexAppServerBridge (shared) │
                                       └──────────┬─────────────────────┘
                                                  stdio NDJSON JSON-RPC
                                                  `codex app-server`
```

- One `codex app-server` child per host process (existing doctrine). `node.ts` constructs
  the `CodexAppServerBridge` once and injects the same instance into the accounts service
  and the Codex execution service. Generation fencing + bounded restart in the bridge are
  preserved untouched; the execution layer treats a generation bump as "thread sessions
  are stale" and rebuilds them lazily via `thread/resume`.
- The routing transport lives in the renderer (`packages/ui/src/v4/`), wraps the agent
  transport + codex transport and routes per topic/session. Every routed call is async, so
  routing resolves codex-ness per call against the codex service (`isCodexTask(taskId)`),
  with a cache. Frames fan into the existing single `SessionDataLayer` by topic — the data
  layer and stores do not know backends exist.
- The Codex execution service speaks the v4 conversation contract at its channel boundary:
  `subscribeConversationV4` / `resyncConversationV4` / `unsubscribeConversationV4` /
  `conversationRowsRangeV4` / `sendConversationCommandV4` / `queryConversationCommandsV4`
  (a subset interface `ICodexConversationV4Facade`), plus notifications shaped as standard
  `ConversationTopicFrame`s (`v4/conversation/frame` semantics). The renderer-side
  `codexConversationTransport` adapts that to the `ConversationTransport` seam.

## State ownership

| State | Owner | Persisted |
| ----- | ----- | --------- |
| harness task row (title/status/meta) | `tasks-index.sqlite` via `TaskIndexRepo` | yes |
| task ↔ Codex thread binding | `ZCodeTaskMeta.executionBackend` + `ZCodeTaskMeta.codexThreadId` inside `meta_json` | yes |
| row log / seq / subscription watermarks | `CodexThreadProjection` (in-memory, per host process) | no |
| pending approvals | `CodexThreadProjection.pendingApprovals` (keyed by Codex approval request id) | no |
| Codex thread itself | Codex App Server (rollout files under `~/.codex/sessions`) | Codex-owned |

After host restart, rows are rebuilt from Codex (`thread/resume` + `thread/items/list`) on
first subscribe; between restarts the in-memory row log serves snapshots directly.
`logEpoch` = `codex-<generation>` so a bridge restart forces clients to re-snapshot.

## Event mapping (domain, pure functions — unit tested)

Codex notification → v4 delta (all parsing tolerant; unknown items are logged at debug and
dropped, never fatal):

| Codex App Server | v4 projection |
| ---------------- | ------------- |
| `turn/start` accepted (host-side, on send) | `row.appended` turnHeader(origin=userInput, state=running) + `row.appended` userInput + `state.updated` control(phase=running, canStop) |
| `item/started` (agentMessage) | `row.appended` assistantText(state=streaming) |
| `item/agentMessage/delta` | `row.delta` path="text" |
| `item/completed` (agentMessage) | `row.upserted` assistantText(state=complete, full text) |
| `item/started` + `item/reasoning/summaryTextDelta`/`textDelta` | `row.appended` reasoning(state=streaming) + `row.delta` path="text" |
| `item/completed` (reasoning) | `row.upserted` reasoning(state=complete) |
| `item/started/completed` (commandExecution) | toolCall row (toolName `codex.commandExecution`), inputText=command, output deltas on `item/commandExecution/outputDelta`, exit code on complete |
| `item/started/completed` (fileChange) | toolCall row (toolName `codex.fileChange`), input=changes summary, structured `display` |
| `item/started/completed` (mcpToolCall / webSearch) | toolCall rows (toolName `codex.mcpToolCall` / `codex.webSearch`) |
| `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` (server→client **requests**) | pendingInteraction(kind=permission, interactionId=`codex-approval-<n>`) + toolCall row status=pendingApproval + `state.updated`. **Never auto-approved.** |
| `turn/completed` | turnHeader upsert (state by Codex turn status) + control(completedSuccess/…, canStop=false) + task index status write |
| `error` notification | control.lastError + turn failed |

Row identity: `rowId` = monotonic per task (projection-local counter); `entityId` =
`codex-item-<itemId>` when the Codex event carries an itemId, else `codex-row-<rowId>`.
`turnId` = Codex turnId when present.

## Commands (v4 envelope → Codex)

| Envelope type | Codex action |
| ------------- | ------------ |
| `sendText` | `turn/start` (or queued: create+`turn/start` when `firstInput` on createTask) |
| `stop` | `turn/interrupt` **{threadId, turnId}** — both required by schema; the Codex turn id is captured from the `turn/start` response (`{turn:{id}}`) and from `turn/started` notifications, cleared on `turn/completed`; when unknown the stop is failed with `codex_interrupt_no_active_turn` rather than sent incomplete |
| `resolveInteraction` | respond to the matching Codex approval server-request with the schema-true body (see approvals below) |
| `renameSession` | task index title update only (Codex `thread/name/set` deferred) |
| anything else | ack `rejected`, reason `fault.command.unsupportedBackend` |

`createSession` / `createSelectionSideSession` / fork / editUserQuery / rewind / workflow
commands are rejected for Codex tasks in this slice.

## Harness execution policy (schema-derived, 2026-09-22)

Field names and enum values below are copied from the installed binary's own protocol
schema (`codex app-server generate-json-schema`, codex-cli 0.155.0-alpha.9.2, v2 bundle) —
not guessed. The harness never invents values outside these enums.

- `thread/start` accepts `approvalPolicy` (`AskForApproval` string variants:
  `"untrusted" | "on-request" | "never"`, plus a granular object variant this backend does
  not use) and `sandbox` (`SandboxMode`: `"read-only" | "workspace-write" |
  "danger-full-access"`).
- `thread/resume` accepts the same two fields plus `excludeTurns: boolean`; its schema text
  explicitly recommends `excludeTurns: true` + pagination via `thread/turns/list` /
  `thread/items/list` because full-history hydration is deprecated. The harness resumes
  with `excludeTurns: true` and **re-asserts the policy** so an old thread cannot come back
  with a looser policy than the host currently runs.
- `turn/start` takes per-turn overrides (`approvalPolicy`, `sandboxPolicy` — the latter is a
  different object shape, `SandboxPolicy` with camelCase `type`); the harness deliberately
  does not duplicate the policy per turn — the thread-level policy persists.
- `turn/interrupt` requires both `threadId` and `turnId`; response `{}`.
- Approval server-request **responses** are not approved/denied:
  - `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` respond
    `{decision}` with `"accept" | "acceptForSession" | "decline" | "cancel"` (plus amendment
    variants the harness never sends). Harness mapping: approved → `"accept"`, denied →
    `"decline"`. `acceptForSession` (silent re-approval) and `cancel` (kills the turn) are
    deliberately never emitted — both weaken the fail-closed posture.
  - `item/permissions/requestApproval` responds `{permissions: GrantedPermissionProfile,
    scope?: "turn"|"session"}` — there is no decision field. Harness mapping: denied →
    `{permissions:{}, scope:"turn"}` (empty grant = nothing additional authorized);
    approved → the request's own `permissions` profile echoed back with `scope:"turn"`.
    The requested profile lives only in the host-side approval record; it never crosses
    the channel.
  - Approvals that cannot be routed to a runtime are answered by the same schema-true
    denial (decline / empty permissions grant) — never dropped, never auto-approved.
- `thread/items/list` pages with `cursor`/`limit` and returns `nextCursor`; history rebuild
  follows `nextCursor` until exhausted (bounded at 50 pages).

The policy itself is a host-side constant domain (`codexPolicy.ts`):

| Preset | approvalPolicy | sandbox | Selected by |
| ------ | -------------- | ------- | ----------- |
| `safeInteractive` (**default**) | `on-request` | `read-only` | everything unless overridden |
| `workspaceWrite` | `on-request` | `workspace-write` | explicit env preset |
| `unrestricted` | `never` | `danger-full-access` | explicit env preset only |

Selection: `ZCODE_CODEX_EXECUTION_POLICY=<preset-name>` on the host process. Unknown or
blank names fail closed to `safeInteractive` with a warning. There is no per-task or
per-client policy surface: a remote client can never widen the sandbox or disable
approvals. The old implicit default (no policy fields sent → Codex default
`approvalPolicy:"never"` + `dangerFullAccess`) is retired.

## Security boundary (do not weaken)

- The channel returns only v4 projection data + task metas. No Codex tokens, no OAuth
  material, no `~/.codex/auth.json` contents, no `codexHome` paths, no raw server-request
  envelopes. The bridge keeps its existing guarantee (see `accounts/codexAppServerBridge.ts`
  header) — the execution layer adds to it: stderr from the child is never surfaced, and
  approval prompts carry only tool name/summary/command text/paths.
- The relay needs **zero changes**: the codex-execution channel is registered in
  `createLocalServices`, so it crosses the relay exactly like every other service, already
  carrying sanitized frames only. Approvals are ordinary v4 pendingInteractions, so the
  existing `PermissionDialog` + `resolveInteraction` envelope resolve them remotely.
- Host-side only: `ZCODE_CODEX_EXECUTABLE` overrides the codex binary path for protocol
  recording/test tees (composition-root wiring in `node.ts`; absent by default).
- Errors are scrubbed before acknowledgement (`codexErrorToCode`): message text is capped
  and stripped of absolute paths.

## Renderer UX (slice)

- `ConversationComposer` gains an execution-backend selector for **new tasks only**
  (draft mode): Agent = ZCode | Codex. It is a structural clone of the mode switch
  (ghost button + dropdown radio), picker union extended with `"backend"`.
- Backend choice lives in the composer draft (`V4ComposerDraft.executionBackend`,
  default `"zcode"`); it does not touch `SessionConfigState` (host session config stays
  ZCode-owned).
- Draft prewarm is skipped while backend=Codex (no zcode-cli session is created).
- First send with backend=Codex: `codexService.createTask({workspace, firstInput, title})`
  → task meta persisted → navigate via the same `handleDraftSessionCreated` path used by
  `createSession` acks → pane subscribes `conversation/<taskId>` and renders streamed rows.
- Subsequent turns/stop/approvals on a Codex task flow through the standard command
  envelope path (routing transport delegates to the codex transport).

## Invariants

1. taskId === harness task id; `codexThreadId` is the only link to Codex — never reuse the
   ZCode sessionId namespace for Codex threads.
2. Approval requests must reach the harness (pendingInteraction) before any decision is
   sent to Codex; silence is never consent. Missing/unknown approval ids are rejected, and
   approval server-requests that cannot be routed to a runtime are answered **denied** with
   a warning rather than dropped.
3. Bridge generation fencing is authoritative: a Codex RPC issued against a dead
   generation fails with `codex_stale_generation`/`codex_process_exited` and the affected
   turn is marked failed — no silent retry against a new generation.
   `bridge.respond()` carries its own fence: only server-requests dispatched by the live
   generation can be answered (the bridge records rawId → generation at dispatch).
4. Frame sequencing follows the v4 contract exactly: snapshot frames carry `fromSeq: 0`;
   every deltas frame carries `(fromSeq, toSeq] = (previousSeq, commitSeq]`. The projection
   store only applies deltas when `frame.fromSeq === current.seq` — violating this turns
   streaming into a resync storm.
5. `ensureRuntime` rebuilds are atomic: the fresh projection is built and the thread
   resumed *before* it is swapped into the runtime cache; a failed resume leaves the cache
   untouched (the next attempt retries) and its error is scrubbed before crossing the
   channel.
6. Snapshot sections the slice does not model (goal, plan, queue, workflowRuns, subagents,
   backgroundWorks) are always empty/null, never fabricated.
7. The codex execution service and the shared app-server bridge are disposed through the
   host shutdown chain (`disposeServiceResources`, side-table registered in `node.ts`).
8. Task reads (`readTask`/`listTasks`) accept workspace scoping and must be scoped by
   workspace identity on remote connections; `git diff --check` clean; no Codex executable
   path/token material in logs.

## Testing

Protocol/unit tests run without Codex inference (pure domain mapping + projection over
recorded fixture notifications):

```bash
mise exec -- node --import tsx --test packages/services/test/codexExecutionProjection.test.ts
mise exec -- node --import tsx --test packages/services/test/codexExecutionService.test.ts
```

`codexExecutionProjection.test.ts` covers: assistant text delta accumulation, command
execution item lifecycle, file-change structure, approval request → pendingInteraction +
pendingApproval row, approval resolution, turn completion states, unknown-item tolerance,
and snapshot build validity (parsed with `conversationSnapshotSchema`).

`codexExecutionService.test.ts` covers: createTask persistence mapping (executionBackend +
codexThreadId in meta), sendText → turn/start mapping, stop → interrupt, approval decision
forwarding, unsupported-command rejection, and generation-bump staleness — all against a
fake bridge; no real Codex process.

## Observed App Server shapes (E2E-verified 2026-09-22, codex-cli 0.155.0-alpha.9.2)

Captured against the real ChatGPT Plus login with two live tasks (text-only; file
create+read). Raw transcripts: `/tmp/codex-e2e/probe1.log`, `probe2.log`.

| Call / event | Observed shape (abridged) |
| ------------ | ------------------------- |
| `initialize` | `{userAgent, codexHome, platformFamily, platformOs}` (unchanged) |
| `account/read` | `{account:{type:"chatgpt",email,planType}, requiresOpenaiAuth:true, workspaceRouting:{chatgptAccountId,…}}` — **`requiresOpenaiAuth` is true even when signed in**; the sign-in gate must key on `account` presence (as implemented) |
| `thread/start {cwd}` | `{thread:{id, sessionId, model:"gpt-5.6-terra", approvalPolicy:"never", sandbox:{type:"dangerFullAccess"}, path:<rollout file>, …}, model, modelProvider, approvalPolicy, sandbox, …}` — **thread id is nested at `result.thread.id`**; `extractCodexThreadId` handles it |
| `thread/started` | `{thread:{id,…}}` — nested, not top-level `threadId` (tolerated) |
| `turn/start {threadId, input:[{type:"text",text}]}` | **accepted as sent** — live turn ran and replied |
| `thread/resume {threadId}` | result is **empty `{}`**; caller must keep the original thread id (as implemented). Emits `deprecationNotice`: full-history hydration is deprecated for paginated threads — pass `excludeTurns: true` and page with `thread/turns/list` + `thread/items/list` (follow-up: add `excludeTurns`) |
| `thread/items/list {threadId}` | `{data:[{turnId, item:{…}}, …], nextCursor, backwardsCursor}` — items under **`data`**, each wrapped in `{turnId, item}`; item types seen: `userMessage {id, content:[{type:"text",text}]}`, `agentMessage {id:"msg_…", text, phase:"final_answer"}`. `normalizeHistoryItem` unwraps `{turnId, item}` (E2E-shaped regression test in `codexExecutionService.test.ts`); `userMessage` history is not replayed as rows — recorded gap (restart-recovery scope) |
| Live notifications | `item/started`, `item/agentMessage/delta`, `item/completed`, `turn/completed` all parsed by the tolerant parser: E2E 1 rendered `CODEX_E2E_OK` exactly once with 0 `resyncConversationV4` calls |
| Approval server-requests | **Not emitted** in either run: the pre-v1.1 threads carried Codex's own default `approvalPolicy:"never"` + `sandbox:{type:"dangerFullAccess"}`. v1.1 retires that default — the harness now sends `approvalPolicy:"on-request"` + `sandbox:"read-only"` explicitly (see "Harness execution policy"); the live approval round-trip drill is part of this phase |

Post-run task metadata check: `tasks.meta_json` contains `executionBackend:"codex"`,
`codexThreadId:"<thread uuid>"`, `status:"completed"` for both E2E tasks.

## Observed approval round-trip (v1.1 drill, 2026-09-22, restrictive default policy)

Live one-turn drill through `/fork` (isolated relay + remote browser, unauthenticated local
mode), default `safeInteractive` policy (`on-request` + `read-only`), scratch workspace,
instruction: create `codex-approval-proof.txt` with exactly `APPROVAL_OK` (no trailing
newline) and read it back. Wire recorded via a pass-through tee in front of the real
app-server (`ZCODE_CODEX_EXECUTABLE`). Observed:

| Step | Observed shape |
| ---- | -------------- |
| `thread/start` | `{cwd, approvalPolicy:"on-request", sandbox:"read-only"}` accepted; thread id at `result.thread.id` |
| `turn/start` response | `{turn:{id:"01a…", items:[], status:"inProgress", …}}` — Codex turn id captured for `turn/interrupt` |
| approval gate | notification `thread/status/changed {status:{type:"active",activeFlags:["waitingOnApproval"]}}` precedes the request |
| server-request | `item/commandExecution/requestApproval` with **id `0`**; params `{kind:"command", threadId, turnId, itemId:"exec-…", startedAtMs, environmentId:"local", reason, command:"/bin/zsh -lc '…'"}` |
| harness response | `{jsonrpc:"2.0", id:0, result:{decision:"accept"}}` — schema-true accept mapping proven live |
| resolution notice | notification `serverRequest/resolved {threadId, requestId:0}` after the response (no answer required) |
| continuation | same turn continues (no second turn): command executed → `item/completed` → final `agentMessage` deltas `APPROVAL_OK` → `turn/completed` |
| file bytes | `codex-approval-proof.txt` = exactly `APPROVAL_OK` (11 bytes, no newline) |
| remote UX | approval surfaced as ordinary v4 pendingInteraction → `PermissionDialog` in `/fork` → remote Allow/Confirm → `resolveInteraction` envelope |

Noise observed on live threads (all parsed as `unhandled`/unknown and dropped, never
answered): `mcpServer/startupStatus/updated` server-notifications, `thread/tokenUsage/updated`,
`account/rateLimits/updated`, `thread/status/changed`, `warning`. Server-request rawIds on a
fresh bridge are small integers starting at 0.

Restart/resume (host restart and bridge-only SIGKILL of the `codex app-server` child, both
drilled): bridge auto-restarts within the restart budget; fresh attachment →
`thread/resume {threadId, approvalPolicy, sandbox, excludeTurns:true}` →
`thread/items/list` returns all 4 wrapped entries (`{turnId,item}`, `nextCursor:null`) →
projection rebuilds commentary/toolCall/final rows (`userMessage` history still not
replayed — known gap, does not lose assistant content) → task rows intact and
non-duplicated across reconnects.

Live cancellation drill: **pending** — `turn/interrupt {threadId, turnId}` is
schema-validated and covered by unit tests (turn id captured from `turn/start` response and
`turn/started`, cleared on `turn/completed`, `codex_interrupt_no_active_turn` when unknown);
no live inference was spent on it per the phase instruction.

## E2E checklist (superseded by "Observed shapes" above; kept for the remaining drills)

Cancellation, crash/restart recovery (`thread/resume` + items rebuild under a live
generation bump), `thread/turns/list` pagination, approval request/response round-trip,
and concurrent Codex tasks remain to be drilled separately after the basic protocol is
proven (basic protocol proven 2026-09-22; pre-E2E checkpoint `fork-codex-exec-v1`).
