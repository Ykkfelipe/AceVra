# Task artifacts — first-class tool/agent output delivery (phase 11)

Status: implemented as a host-side registry + retrieval channel with renderer
integration. No protocol-breaking change: the v4 conversation contract already
defines `artifactRowSchema` (kind:"artifact") and this phase only _produces_
those rows where the harness owns the projection, plus a new task-scoped
delivery channel for byte retrieval.

## Motivation

Tools and agent backends create real files (browser screenshots, Codex-created
files), but the harness only ever returned a local path string to the model.
Users — especially on /fork — never see the file. This phase makes structured
task output a first-class, remotely deliverable artifact without exposing the
host filesystem.

## Existing concepts reused (survey results)

| Concept                                                                                                                                     | Reuse                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `artifactRowSchema` (v4 frozen contract: artifactVersionId/logicalArtifactKey/displayName/artifactType/mimeType/sizeBytes/sha256/ref/state) | the conversation representation; already rendered by `ArtifactRowView`                                            |
| `attachmentRefSchema` (`ref`/`fileName`/`mime`/`bytes`, opaque refs only)                                                                   | the ref discipline: content never travels in frames, only opaque ids                                              |
| `conversationAttachmentReadV4` chunked authorized read + `PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes`                                       | the retrieval shape (offset/limit → dataBase64/totalBytes/mediaType)                                              |
| `browserCommandResult.image {base64, mimeType:"image/png"}`                                                                                 | screenshot bytes already arrive at the host in the `interaction/browserExecute` result — no filesystem dependency |
| share-layer artifact row construction (sha256, sizeBytes, `zcode-artifact://` refs)                                                         | descriptor discipline                                                                                             |
| codex module pattern (channel facade + host-internal impl + relay passthrough)                                                              | service layout                                                                                                    |

## Architecture

```
integrations (host process only)            renderer (/fork · desktop)
─────────────────────────────               ─────────────────────────
browser-use: interaction/browserExecute     useTaskArtifacts(taskId)
  result.image {base64?, hostPath?} ──┐        │ listTaskArtifacts (channel; refreshes
                                      │        │ while an active task can add artifacts)
                          ▼                   │ readTaskArtifact (chunked)
        registerTaskArtifact ──────────▶ task-artifacts channel
        (verify · copy · index)         (list/read only; registration
                                          is NOT channel-exposed)
Codex: turn/completed + user-named          ConversationTimeline
  fileChange match ──▶ register +           ├─ codex tasks: real artifact
  append artifact row (host projection)     │  rows (kind:"artifact")
                                            └─ zcode tasks: renderer-side
                                               artifact cards joined by turnId
```

### State ownership

| State                       | Owner                                                                                                        | Persisted |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ | --------- |
| artifact metadata + bytes   | host task-artifact store (`<appConfigDir>/task-artifacts/<canonicalTaskId>/<artifactId>.bin` + `index.json`) | yes       |
| artifact rows (codex tasks) | `CodexThreadProjection` (in-memory, host-owned)                                                              | no        |
| artifact list (zcode tasks) | renderer fetch, id-keyed                                                                                     | no        |

Bytes are **copied** into the store at registration. The original host path is
used only for the existence check and the copy; it is never persisted, logged,
or transmitted. `displayName` is the source basename.

## Registration

`registerTaskArtifact(params)` — host-internal API (not channel-exposed):

- inputs: `taskId`, `workspacePath`/`workspaceIdentity` (scope), `origin`
  (`"browser-use" | "codex" | "tool"`), `fileName`, `mimeType`, and exactly one
  of `bytes` (preferred) or `hostPath` (stat-verified, size-capped, copied).
- validates: task scoping present, fileName is a basename (no separators),
  mimeType against an allowlist (png/jpeg/webp for inline images; pdf/zip/txt/md
  and generic `application/octet-stream` for cards), size ≤ `maxArtifactBytes`.
- produces: `artifactId` (UUID), `createdAt`, `sha256`, `byteSize`, stored
  bytes; appends `{artifactId, turnId?}` to the task index entry.

Only explicitly registered files may be retrieved. There is no path query
parameter anywhere in the retrieval surface; artifact ids are UUIDs and the
store layout is derived from `(taskId, artifactId)` internally.

### Task scope normalization

Real ZCode runtime sessions are identified as `sess_<uuid>`; Codex tasks and
older callers use a bare UUID. `resolveTaskArtifactScope(taskId)` is the single
parser for every task-scoped registry operation (register, list, read, meta
lookup, full listing, and the per-task write lock):

| input                                                                    | result                        |
| ------------------------------------------------------------------------ | ----------------------------- |
| `<uuid>` (any hex case)                                                  | canonical `<uuid>` lowercased |
| `sess_<uuid>`                                                            | the same canonical `<uuid>`   |
| anything else (`sess_` without a UUID, `..`, separators, other prefixes) | rejected                      |

Only the canonical UUID is ever used as a filesystem component. The id supplied
by the first registration of an artifact is kept in its stored metadata and
returned as `descriptor.taskId` (for ZCode sessions that is the live `sess_`
id). Deduplicated re-registrations and lookups through the other form return
that same stored value; consumers must not compare `descriptor.taskId` strings
across forms. Rejection maps to `artifact_invalid_scope` on registration and to
the uniform `artifact_not_registered` fault on retrieval.

Known limitation: runtime child sessions whose ids are not `sess_<uuid>`
(`sess_workflow_*`, `sess_subagent_*`, `sess_wf-actor*`) are rejected, so an
explicit screenshot there logs a warning and produces no card. Subagents are
already denied browser access by the broker; mapping workflow children to their
parent task is out of scope for this change.

The store root is resolved once per public operation and passed through, so a
single registration never splits bytes and index across two data roots.

### Store root

The store root is resolved on every operation as
`<getAppConfigDir()>/task-artifacts`. `getAppConfigDir()` follows the process
data base (`setDataBaseDir` › `ZCODE_DATA_BASE_DIR` › fork/home default), so the
AceVra dev host (launched with `ZCODE_DATA_BASE_DIR=~/.zcode-fork-dev-home`)
stores beneath `~/.zcode-fork-dev-home/.zcode/v2/task-artifacts` and never falls
back to the official `~/.zcode`. Tests inject `rootDir` or a temporary data base.

### Explicit vs automatic screenshots

Only explicit screenshots (a model/user `tab.screenshot()` through node_repl or
the browser broker) become artifacts. The runtime's automatic end-of-turn
observation screenshot (`source: "browser_turn_end"`) sets
`captureIntent: "observation"` on its `BrowserControlPort.execute` call; the
agent broker forwards it in `interaction/browserExecute` params; the host
handler passes it to the executor; the artifact hook skips registration for it
and strips the flag before calling the underlying executor. The flag lives in
protocol params, not in `BrowserCommand`, so model-authored cells cannot set it.
Absent means explicit. SHA-256 deduplication is not relied on to hide
observation captures.

### Browser screenshot source selection and timing

The Electron executor currently returns `image: {base64, mimeType:"image/png"}`.
The host integration also accepts a future saved-file form in the same image
object (`hostPath`, with optional `fileName`), but that path is consumed only by
`TaskArtifactRegistry.registerTaskArtifact` and never leaves the host. If both
forms are present, bytes win deterministically; exactly one registration is
attempted. The registry's `(taskId, workspace key, origin, turnId, sha256)`
idempotency key makes retry/replay return the existing descriptor.

Before the result leaves the host, the hook removes `hostPath`; saved-file-only
results instead expose only `artifactDelivery.status` (`delivered` or
`registration_failed`). This lets the model/runtime distinguish capture from
user delivery without a local path or an invented attachment claim.
A registration failure is logged at `warn` by the hook (task id, turn id and
registry reason code only — never a path or bytes); it is never silent.

### Executor interface preservation

`instrumentBrowserExecutorForArtifacts` is a decorator over the full
`BrowserAmbientContextExecutor` interface (`list` + `execute`). It intercepts
only `execute`; every other member (`list` today, anything added later) is
delegated to the original executor with the same `this`, arguments, results
and rejections. The wrapper must never be a partial object cast to the full
type: the host `interaction/browserList` handler calls `executor.list(...)`,
and a missing `list` previously threw `TypeError` synchronously inside the
stdio dispatch path, which tore down the whole agent connection.

Host browser RPC handlers (`interaction/browserList`, `interaction/browserExecute`)
invoke the executor through a promise boundary, so a synchronous executor throw
and an asynchronous rejection produce the same structured error response and
never escape into the transport dispatcher.

### Transport error semantics (stdio)

`ZCodeStdioTransport` distinguishes parse failures from dispatch failures:

| failure                                     | behaviour                                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| invalid JSON / schema-invalid frame         | `protocol_parse_error` close (unchanged)                                                            |
| valid request, handler throws               | `ZCodeProtocolClient` logs the error and replies `-32603` to that request id; connection stays open |
| valid notification/response, handler throws | logged only (no reply is valid for these); connection stays open                                    |

`useTaskArtifacts` refreshes the list while a task is mounted. This closes the
live-turn timing boundary: a successful browser screenshot registered after the
initial conversation mount becomes an inline card without a remount; a failed
registration has no descriptor and therefore no delivery UI to misrepresent.

## Conversation integration

- image/png, image/jpeg, image/webp → inline preview (object URL, mobile-safe
  `max-w-full h-auto`).
- everything else → file card (displayName, byteSize, download via object URL).
- Tasks without artifacts render exactly as before; the row log for zcode tasks
  is untouched (renderer-side join), codex tasks gain real artifact rows.

### Codex delivery policy (no agent-loop change, no inference)

After a Codex turn completes, the harness registers a fileChange item's file
only when the user's turn input **explicitly named** that file (exact relative
path match, or exact basename-with-extension token). Source edits the user did
not name are never uploaded. If registration fails, no artifact row is appended
— the conversation never claims delivery it cannot serve.

## Retrieval (channel `task-artifacts`)

- `listTaskArtifacts({taskId, workspacePath, workspaceIdentity?})` →
  descriptors `{artifactId, taskId, fileName, mimeType, byteSize, sha256,
origin, createdAt, state:"available"|"missing"}`. No host paths.
- `readTaskArtifact({taskId, artifactId, offset, limit, workspacePath,
workspaceIdentity?})` → `{dataBase64, totalBytes, mediaType, nextOffset}`;
  chunk bounded by `PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes`; MIME served
  from stored metadata (preserved, not sniffed).
- Authorization: relay/device auth (existing channel transport) + workspace key
  match against the registration scope + artifact must be registered under that
  task. Deleted backing file → `state:"missing"` / structured fault — never a
  raw fs error, never a path.

## Security boundary (do not weaken)

1. Registration is host-internal. The channel exposes list/read only.
2. Retrieval resolves `(taskId, artifactId)` inside the store only; there is no
   code path from a retrieval request to an arbitrary filesystem read.
3. Host absolute paths never enter descriptors, frames, or the renderer.
4. Byte bound on registration and on every read chunk.
5. The renderer never receives a path it could re-request; downloads come from
   bytes it already fetched over the authorized channel.

## Testing (fixtures, no inference)

Registration (png → image artifact; arbitrary → card), unregistered id fetch,
`../` traversal in ids, cross-task access, deleted backing file, path-free
responses, list idempotence (reconnect), browser-use result hook, codex
user-named delivery (named file registers, unnamed edit does not), and mobile
width assertions on the preview markup.
