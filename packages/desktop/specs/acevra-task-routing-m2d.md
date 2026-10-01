# AceVra task routing and remote Node process execution — M2D

Status: implemented with this change. Builds on M2B (devices) and M2C (pairing + device channel).
Scope: a server-owned Task queue, ordered TaskEvents, typed task messages on the device
channel, and ONE remote primitive: a structured process runner on a paired Node. No remote
Computer Use, file sync, browser client, cloud worker, conversation sync or subagent
orchestration.

## Model (PostgreSQL, control-plane owned)

`tasks(id, account_id, target_device_id, created_by, initiating_agent_id NULL, parent_task_id NULL,
type 'process', state, spec JSONB (≤ 8 KiB), idempotency_key, attempt, result JSONB (small),
created_at, started_at, finished_at, updated_at, next_seq)` with composite FK
`(account_id, target_device_id) → devices(account_id, id)` and `UNIQUE(account_id, idempotency_key)`.
`initiating_agent_id` / `parent_task_id` are reserved for future agents/subagents (not populated).

`task_events(task_id, sequence, type, ts, payload JSONB, source_seq NULL)` — ordered, append-only;
`PRIMARY KEY(task_id, sequence)`, partial unique `(task_id, source_seq)` makes node re-sends
idempotent. Raw output lives only in events (bounded), never in the task row.

States: `queued → dispatching → running → completed | failed | cancelled`, plus truthful
`cancelling` (cancel requested, awaiting the node) and `running_unknown` (the node's channel dropped
while running; the process may still exist). Event types: `task.created`, `task.assigned`,
`task.accepted`, `task.requeued`, `task.cancel_requested`, `task.node_disconnected`,
`task.reconciled`, `process.started`, `process.output`, `process.progress`, `process.truncated`,
`process.completed`, `process.failed`, `task.cancelled`.

## Queue (server-owned, no Redis)

The control plane owns the queue; the desktop is never the authority. Tasks survive control-plane
restarts because state is in Postgres. One task at a time per node (serial). Dispatch is a
conditional update `queued → dispatching` (idempotent, attempt-fenced) followed by `task.offer`.
A sweeper (startup + every few seconds) re-queues unacknowledged offers, marks running tasks
`running_unknown` when their device has no live channel, and expires tasks queued longer than the
queue TTL (`failed`, reason `queue_expired`) so a command can never run unexpectedly hours later.
Single control-plane instance for liveness (as in M2C); Postgres remains the source of truth.

Creation requires: account owns the target device, device is an unrevoked node that advertises
`shell`, and is currently online. An offline or revoked target is refused (clear 409).

## Channel protocol additions (typed, schema-validated, size-limited)

Server → node: `task.offer{taskId,attempt,process{executable,args[],cwd,env{},timeoutMs}}`,
`task.cancel{taskId}`, `task.ack{taskId}`. Node → server: `task.accept{taskId,attempt}`,
`task.reject{taskId,attempt,reason}`, `task.event{taskId,attempt,seq,type,payload}`,
`task.complete{taskId,attempt,seq,result}`, `task.fail{taskId,attempt,seq,reason,result}`,
`task.sync{active[{taskId,attempt}]}`. There is no generic "execute" message; unknown types close
the connection. Every handler is fenced by the AUTHENTICATED device id of the connection
(`WHERE id=$1 AND target_device_id=$2`) and by the current attempt, so a compromised node cannot
touch another device's task, even within the same account. Duplicates (accept, event, completion)
are idempotent.

Completion mapping: exit 0 → `task.complete` (state `completed`); non-zero exit, timeout, spawn
failure, rejection, interruption → `task.fail` (state `failed`, reason in result); a node ack of a
cancel → `task.fail{reason:"cancelled"}` → state `cancelled`.

## Reconciliation, disconnect, restart

Channel drop with a running task → `running_unknown` (never an immediate "failed"). On
reconnect the node sends `task.sync{active}`: tasks it still runs resume `running`; tasks the
server believes active but the node does not have → `failed` reason `interrupted` (this is also the
node-restart case: children cannot be recovered); a `dispatching` task the node never saw is
re-queued; tasks the node runs but the server no longer wants → `task.cancel`. A node never runs a
task id twice (it re-accepts an active one idempotently). Terminal results produced while
disconnected are held in a bounded in-memory outbox and re-sent (deduplicated by `seq`).

## Cancellation

`POST /v1/tasks/:id/cancel`. queued → `cancelled` immediately (it never ran). dispatching/running →
`cancelling` + `task.cancel`; the node kills the process tree and reports `cancelled`; only then is
the task `cancelled`. If the node is unavailable the task stays `cancelling`
("cancel requested, node offline"); `force: true` records `cancelled` with `acknowledged:false`
(truthful: the device never confirmed).

## Node shell service (`packages/node`)

Structured API only: `{executable, args[], cwd, env additions, timeoutMs}`; `shell:false`, no
interpolation, no sudo/UAC/TTY/stdin. The node advertises `shell` ONLY after the service is ready:
at least one explicit allowed root (`--allow-root <dir>`, persisted) AND a spawn self-test
passes — never inferred from the OS. `cwd` must resolve (realpath) inside an allowed root.
Environment: the child gets a minimal allowlisted base plus validated additions (names
`[A-Z_][A-Z0-9_]*`; PATH, LD*\*, DYLD*_, NODE*OPTIONS, ComSpec, PATHEXT… refused); `ACEVRA*_`never
leak. Windows: Node ≥ 18.20 refuses`.cmd/.bat`without a shell, so batch files are run through`cmd.exe`only when every argument is free of cmd metacharacters, otherwise refused. Process trees
are killed with`taskkill /T /F` (Windows) or process-group signals (POSIX). Executables are not
allowlisted in M2D (the allowed roots are the consent boundary); this is a deliberate, documented
limit: whoever controls the owning account can run any program in those roots' context.

Backpressure and truncation: output is decoded incrementally and coalesced (≥ 250 ms or 4 KiB) into
≤ 4 KiB events; a bounded send buffer pauses the child's pipes when the WebSocket or the offline
outbox is full; a per-task output cap (1 MiB) emits a `process.truncated` event and a final
`droppedBytes` count instead of silently discarding.

## ExecutionTarget and UI

`ExecutionTarget{id,type 'desktop'|'node',displayName,online,capabilities,isThisDevice,available}`
is derived from Devices; routing never hardcodes machine names. This desktop's local target runs the
same shell service in the main process with the same Task/Event shape and no control plane. Account →
Devices gains "Run a process" (Run on [target ▼], executable, args, cwd), a task list and a live
event view fed only by TaskEvents (polled by `after` sequence). Cloud is not shown.
Superseded for normal UX by M2E (`acevra-execution-ux-m2e.md`): the raw form is engineering-only;
users get a composer "Run on" control and TaskEvent-driven work cards instead.
`IRemoteProcessService.startRemoteProcess()` returns a task handle immediately; the main agent
tool-registry wiring is the next step (the service and its contract exist; the UI is its first
consumer).

## Known limits

No file sync: the project must already exist on the node. Task events are polled (no push to the
desktop yet). Liveness assumes one control-plane instance. Executables are unrestricted inside
allowed roots. The agent harness does not yet call `startRemoteProcess`.
