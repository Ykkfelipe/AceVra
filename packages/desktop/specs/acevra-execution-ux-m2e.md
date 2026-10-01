# AceVra execution UX realignment — M2E

Status: implemented with this change. Builds on M2D (`acevra-task-routing-m2d.md`). UI only: no new
table, task protocol, IPC task command, remote service or agent tool. Reuses `ExecutionTarget`,
`TaskView`, `TaskEvent`, `IRemoteProcessService` and the existing cancellation path.

## Product rules

- AceVra is chat-first. Users ask for outcomes in a conversation; the agent decides executable,
  arguments, cwd and target. Devices are infrastructure, managed (not operated) from Settings.
- Settings → AceVra Account shows identity, sign in/out, private-alpha status and Devices
  management only: name, Online/Offline/Revoked, "This device" vs "Node", Pair, Rename, Revoke.
  "Continue locally" semantics are unchanged; local work never waits on the account.
- The M2D raw "Run a process" form (Program / Arguments / Working directory) is an engineering
  harness, not product UX. It is rendered only when engineering tools are enabled (see Gating).
- The composer has a compact, secondary "Run on" control: `Automatic` plus the real execution
  targets (this desktop, paired nodes by their user-given names). Unavailable targets are listed
  but disabled and labelled (Offline / Can't run tasks). Names are never hardcoded. Default is
  `Automatic`; the user is never asked to pick per turn.
- Work started for a conversation shows as a compact live card above that conversation's
  composer: `<target name> · <status>`, the latest output/progress lines and a Stop button. It never
  shows executable, arguments or cwd. Status text is AceVra-owned i18n, never invented narration.
- Rendering the selector or the card never starts a task, a capture or a tool call; it only reads
  `listTargets`, `listTasks` and `getTaskEvents`, and Stop calls `cancelTask`.

## Honest gap (unchanged from M2D)

The main agent's tool registry does not call `startRemoteProcess`; agent tools always run where the
agent runs (this desktop or the remote workspace host). Therefore the Run-on selection today:

1. is the conversation's declared preference, held in the renderer (see owners);
2. is the default target of the engineering runner, the only caller of `startRemoteProcess`;
3. does NOT change where agent tool calls execute. When a non-local target is selected the menu
   states this ("Agent tools still run on this device for now"). No prompt text is injected and no
   routing is faked. Wiring the agent tool path is a separate milestone.

## State owners

| State                             | Owner                                                                               | Notes                                                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Targets (availability, names)     | Desktop main `createAccountTasks.listTargets` (derived from Devices + local runner) | Renderer reads through `useExecutionTargets`; refreshed on mount, every 30 s while mounted and on menu open.          |
| Run-on selection per conversation | Renderer `executionTargetStore.selectionByScope`                                    | In-memory, keyed by execution scope; default `auto`.                                                                  |
| Conversation ↔ task attachment    | Renderer `executionTargetStore.tasksByScope`                                        | Written only by the code that started the task (today: engineering runner). Never inferred from the global task list. |
| Task state and events             | Control plane (node tasks) / desktop main local runner (local tasks)                | Card reads `listTasks` + `getTaskEvents(after)`; the event cursor is hook-local and transient.                        |
| Cancellation                      | Existing `cancelTask(taskId)` path                                                  | queued → cancelled; running → cancelling → node ack → cancelled.                                                      |

Execution scope key: `session:<sessionId>` for an existing conversation, `draft:<workspaceKey>` for
the new-conversation draft (`workspaceKey = workspaceIdentity?.trim() || workspacePath`). When the
composer of a workspace moves from its draft scope to a new session scope and that session has no
selection or tasks yet, the draft's selection and attached tasks are adopted by the session and the
draft resets to `auto` (a first message keeps what the user picked). Scopes never share tasks: a
task attached to session A is never rendered in session B. Selection is not persisted across app
restarts (it is a draft-like preference; tasks themselves stay in their real owner).

Hidden: the selector and card are not rendered when the platform has no account bridge (Web /
mobile remote control) or for remote workspaces (`workspaceIdentity` set), where "this device" is
not where the agent runs.

## Event order

```text
composer mount ──► useExecutionScope(workspaceKey, sessionId)
                    ├─ draft→session adopt (once, idempotent: only if the session scope is empty)
                    └─ noteActiveScope(scope)            (renderer store)
menu open ───────► listTargets() ──► main: local target + GET /v1/targets (if account ready)
select target ───► store.select(scope, targetId)        (no IPC, no task)

engineering runner Run:
  startRemoteProcess({targetId: selection(activeScope) or chosen}) ──► main ──► local runner | POST /v1/tasks
  ◄── {taskId} ──► store.attachTask(activeScope, taskId)
card (scope) ────► poll listTasks() (state)  ─┐  1.5 s while active, stop when terminal
               └─► poll getTaskEvents(id, after) ─┘ 0.7 s while active, one trailing poll after
Stop ────────────► cancelTask(id) ──► main ──► local kill | POST /v1/tasks/:id/cancel
                    state: cancelling ──(node ack)──► cancelled   (card shows each truthfully)
```

Idempotency: `attachTask` ignores a task id already attached; adopt runs only into an empty scope;
events are deduplicated by `sequence` (cursor only moves forward). Stale results: a poll that
resolves after the card unmounted or switched task is dropped.

## Gating of the engineering runner

`ACEVRA_ENGINEERING_TOOLS=1` is honoured only when the app is not packaged (same rule as
`ACEVRA_ACCOUNT_TEST_TOKEN`). Main exposes it as `IAccountPlatform.engineeringTools()`. Installed
alpha builds never render the runner. The underlying services, IPC and E2E stay unchanged.

## Acceptance scenarios

1. Settings → AceVra Account (signed in) shows profile, status, sign out and Devices; no Program /
   Arguments / Working directory fields. Signed out or local-only: no runner either.
2. Devices rows show name, "This device"/"Node" and Online/Offline/Revoked text; Pair, Rename and
   Revoke work as in M2B/M2C. Capabilities are not listed as admin text.
3. Composer shows "Run on: Automatic" by default; the menu lists Automatic, this Mac (by its
   device name) and paired nodes by name; an offline node is disabled and labelled Offline.
4. Selecting a node persists for that conversation across turns and is adopted from the draft on
   the first send; another conversation stays on Automatic.
5. With engineering tools, a task started on a node appears as a card in the conversation it was
   attached to: "<node> · Running", latest output from TaskEvents, then Completed; Stop on a long
   task ends in Cancelled and the process is gone. The card never shows the command line.
6. Rendering the composer/card performs no `startRemoteProcess` and no capture.
7. Local-only / account offline: composer and chat work; the selector lists only this device.
