# AceVra agent execution on the Run-on target — M2F

Status: implemented with this change. Closes the M2E "honest gap" (`acevra-execution-ux-m2e.md`):
the agent's process-execution tools now run on the target picked in the composer "Run on" control.
Reuses M2D/M2E infra end to end: `ExecutionTarget`, `TaskView`, `TaskEvent`,
`IRemoteProcessService` (desktop main `createAccountTasks`), the control-plane Task queue, the Node
shell service and the conversation task card. No new DB table, no new Node task protocol, no cloud,
no conversation sync, no remote graphical Computer.

## Product rules

- **Automatic / This Mac: unchanged.** With `Automatic` or this device selected, every tool behaves
  exactly as before (Bash runs locally; no new tool is offered for that turn's routing, no prompt
  text changes routing). The agent may still list targets so "run this on <node>" works.
- **Remote node selected:** for that conversation, _process execution_ goes to the selected node
  through a control-plane Task. Only process/shell tools are routed. Read, Write, Edit, Grep, Glob,
  Computer, Browser and MCP tools keep running on this Mac. The agent is told so in a provider-only
  context block (see Capabilities), never in the visible transcript.
- **No silent local run.** While a remote node is selected, `Bash` refuses with a structured
  message that names the selected target and tells the agent to use `RunOnTarget`. An offline,
  revoked, unpaired or shell-less target fails the call truthfully (`target_offline`,
  `target_revoked`, `target_not_found`, `target_lacks_shell`, `not_signed_in`); nothing falls back
  to this Mac.
- **Agent decides the command.** The agent chooses executable, args, cwd, env and timeout. The user
  never fills a form. Device names are never hardcoded: the agent resolves "run this on Dell" by
  calling `ExecutionTargets` and matching the user-given `displayName`.
- **Chat stays responsive.** `RunOnTarget` waits a bounded time (default 60 s, max 300 s). Finished
  tasks return the result; longer tasks return a task handle and keep running. The conversation
  card shows live progress and has a working Stop; the agent can later `TargetTask wait|stop`.
- **Local-only keeps working.** No account / account-api down: Bash works as before; the target
  list is just this device; `RunOnTarget` fails with `not_signed_in` / `account_unavailable`.
- Rendering the composer, selector or card never starts a task or tool call.

## Tool contract (return-at-finish with bounded wait, then handle)

| Tool               | Input                                                                               | Result                                                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ExecutionTargets` | none                                                                                | `targets[]: {id, displayName, kind: thisDevice/node/desktop, online, available, unavailableReason?, capabilities, selected}`, `selectedTargetId?`, routing note. Read-only, auto-approved. |
| `RunOnTarget`      | `targetId`, `executable`, `args?`, `cwd`, `env?`, `timeoutSeconds?`, `waitSeconds?` | `{taskId, targetId, targetName?, state, finished, exitCode?, reason?, output (tail, ≤16 KiB), outputTruncated, message}`. Same approval class as Bash (high risk).                         |
| `TargetTask`       | `taskId`, `action: wait/stop`, `waitSeconds?`                                       | Same result shape. Only tasks started by this session are accepted (`task_not_in_session`).                                                                                                |

- `RunOnTarget` refuses this device (`target_is_local` → "use Bash"); local work keeps the Bash path.
- Abort of the agent turn while `RunOnTarget`/`TargetTask wait` is polling cancels the task
  (`cancelTask`, not forced) and the tool reports the observed state.
- Tools are registered only for the main conversation (not subagent children) and only when the
  host declares the capability (`workspace/updateExecutionTargetPolicy enabled=true`): Desktop with
  an account bridge and a local workspace. Web/remote-workspace hosts never get them.

## Remote cwd rule

`cwd` is required and must be an absolute path **on the node** inside a root configured with
`acevra-node --allow-root`. It never defaults to the local workspace path (the node does not have
this Mac's files; there is no file sync). Outside the allowed roots the node rejects the task and
the tool reports `rejected (policy)`. Allowed roots are not exposed by the control plane today, so
the agent learns them from the user or from a policy rejection (known gap).

## Capabilities described to the model

When the session's selected target is a remote node, each turn gets a provider-only
`<execution-target-context>` block: target name and id, that process commands must use
`RunOnTarget` on it, the cwd rule, and that file/Computer/browser tools and subagents act on this
Mac. With Automatic/This Mac no block is added. Tool descriptions state the same capabilities.

## State owners

| State                                   | Owner                                                            | Notes                                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Run-on selection (UI)                   | Renderer `executionTargetStore.selectionByScope` (M2E)           | Unchanged owner.                                                                                           |
| Session's selected target (agent truth) | CLI session record `executionTarget`                             | Written only by v4 `sendText` / `createSession.firstInput` carrying `executionTarget`; absent = unchanged. |
| Session ↔ agent task fencing            | CLI per-session execution-target port (`startedTaskIds`)         | read/cancel of tasks not started by this session are refused.                                              |
| Targets, tasks, events, cancel          | Desktop main `createAccountTasks` → control plane / local runner | Unchanged owner; the agent reaches it through the host reverse request.                                    |
| Conversation ↔ task card attachment     | Renderer `executionTargetStore.tasksByScope`                     | Agent-started tasks are attached from Main's `AgentTaskStarted` push to `session:<sessionId>`.             |
| Host capability                         | Services (`executionTargetExecutor` option) → CLI policy flag    | Fail-closed default in CLI: no tools until the host enables them.                                          |

Main still holds no task/session business state: it forwards the request with the Clerk token
already held by the account module and pushes a one-shot attach notification.

## Wire changes (minimal, strictly typed, runtime validated)

1. v4 command field `executionTarget` on `sendText` and `createSession.firstInput`:
   `{kind:"automatic"} | {kind:"target", targetId, displayName?}`. Renderer sends `automatic` for
   Automatic or this device, `target` only for a remote node; only when an account bridge exists and
   the workspace is local. Justification: selection must travel with the user turn so the CLI owner
   fences it per session (applies to queued turns, survives renderer reloads mid-turn).
2. Reverse request `interaction/executionTarget` (agent → host), discriminated by `op`:
   `list | start | read | cancel`; params carry `requestId, sessionId, turnId?, toolCallId?,
workspacePath, workspaceIdentity?`. Result union `{op, ok:true, ...} | {op, ok:false, reason,
detail?}`. Same pattern as `interaction/browserExecute`.
3. Policy notification `workspace/updateExecutionTargetPolicy {workspace, enabled}` (same shape as
   `workspace/updateOffPeakToolPolicy`; `-32601` tolerated by older CLIs).
4. Host↔Main messages `ExecutionTargetRequest` / `ExecutionTargetResult` (validated in
   `packages/shared/src/validation.ts`) and account push channel `AgentTaskStarted
{sessionId, taskId, targetId}`.

No change to the control-plane API or the Node channel protocol. Main maps the existing 409 body
(`{error: target_offline|target_revoked|target_not_node|target_lacks_shell}`) through instead of
collapsing it.

## Event order

```text
user picks node ──► renderer store.select(session|draft scope, nodeId)          (no IPC)
user sends ───────► SessionPane.dispatchCommand(sendText|createSession,
                      executionTarget = {kind:"target", targetId, displayName})
                 ──► CLI v4 handler: record.executionTarget = {targetId, displayName}
                 ──► turn: provider-only <execution-target-context> block
model calls RunOnTarget{targetId, executable, args, cwd}
  CLI port.startProcess ──► interaction/executionTarget{op:start, sessionId}
     ──► services ──► host bridge ──► Main accountTasks.startRemoteProcess ──► POST /v1/tasks
     ◄── {taskId} ── Main pushes AgentTaskStarted{sessionId, taskId} ──► renderer attachTask(session:<id>)
  port remembers taskId (session fencing)
  loop every 0.75 s until terminal or waitSeconds:
     port.readTask ──► Main GET /v1/tasks/:id + GET /v1/tasks/:id/events?after=n
  card (independent): polls listTasks / getTaskEvents (M2E), Stop ──► cancelTask
  ◄── tool result: finished result | still-running handle (card keeps live state)
agent abort ──► port.cancelTask ──► POST /v1/tasks/:id/cancel ──► cancelling ──(node ack)──► cancelled
node disconnect while running ──► control plane running_unknown ──► tool/card show "connection lost"
```

Idempotency/staleness: `attachTask` ignores duplicates; draft→session adopt now merges (agent
attach may arrive before adopt); event cursor only moves forward; a tool poll after abort only
cancels once; Bash refusal reads the live session record so a later `automatic` turn restores Bash.

## Acceptance scenarios

1. Automatic / This Mac: Bash runs locally exactly as before; no `<execution-target-context>`; no
   control-plane call is made by Bash.
2. Node selected, agent runs `RunOnTarget` → task created on that node, card "<node> · Running"
   with live output, tool returns exit code + output tail when done.
3. Long command → tool returns a handle after `waitSeconds`; card keeps streaming; `TargetTask
stop` or card Stop → cancelling → cancelled; agent abort cancels too.
4. Node offline/revoked → tool error `target_offline` / `target_revoked`, no local run; Bash in
   that session still refuses and names the target.
5. Another session cannot wait on or stop this session's task (`task_not_in_session`); another
   account's task is invisible (control plane scoping).
6. Node disconnect mid-run → `running_unknown` reported by tool and card ("Connection lost").
7. "Run this on <name>" with Automatic selected → agent calls `ExecutionTargets`, then
   `RunOnTarget` with the matching id.
8. Rendering composer/card/menu triggers no tool call and no task.
9. Local-only (no account): chat and Bash work; `RunOnTarget` reports `not_signed_in`.

## Known limits

- No file sync: the project must already exist on the node; allowed roots are not listed to the
  agent. One task at a time per node (queued tasks wait).
- Subagents and background commands (`Bash run_in_background`) run on this Mac; the context block
  says so. `TaskOutput`/`TaskStop` do not see node tasks (use `TargetTask`).
- Tasks started before a CLI restart can no longer be waited on by the agent (card still shows them
  for the renderer lifetime).
- Remote workspaces (`workspaceIdentity` set) and Web/mobile clients do not get these tools.
