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
| `stop` | `turn/interrupt` |
| `resolveInteraction` | respond to the matching Codex approval server-request (`decision` approved/denied) |
| `renameSession` | task index title update only (Codex `thread/name/set` deferred) |
| anything else | ack `rejected`, reason `fault.command.unsupportedBackend` |

`createSession` / `createSelectionSideSession` / fork / editUserQuery / rewind / workflow
commands are rejected for Codex tasks in this slice.

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

## E2E checklist (blocked on explicit approval — do NOT run without it)

One real task requires confirming these App Server calls/events and their exact payload
shapes (binary strings prove the names; shapes are the unknown):

1. `initialize` (already proven by the account bridge).
2. `thread/start` — params (cwd/model/approvalPolicy/sandbox shape) and the returned
   thread id field name; the `thread/started` notification.
3. `turn/start` — input items shape; `turn/started`, `item/started`, `item/completed`,
   `item/agentMessage/delta`, `item/reasoning/summaryTextDelta`,
   `item/commandExecution/outputDelta` payloads.
4. `turn/completed` — status field values and usage shape.
5. `turn/interrupt` — params and the interrupted turn completion.
6. Approval server-requests: `item/commandExecution/requestApproval` /
   `item/fileChange/requestApproval` — param shape, the expected **response** shape and
   decision enum, and `serverRequest/resolved`.
7. `thread/resume` + `thread/items/list` — resume-after-restart row rebuild.
8. `account/read` gate: execution must fail closed with a clear error when no ChatGPT
   account is signed in.
