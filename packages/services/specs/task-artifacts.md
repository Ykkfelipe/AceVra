# Task artifacts — first-class tool/agent output delivery (phase 11)

Status: implemented as a host-side registry + retrieval channel with renderer
integration. No protocol-breaking change: the v4 conversation contract already
defines `artifactRowSchema` (kind:"artifact") and this phase only *produces*
those rows where the harness owns the projection, plus a new task-scoped
delivery channel for byte retrieval.

## Motivation

Tools and agent backends create real files (browser screenshots, Codex-created
files), but the harness only ever returned a local path string to the model.
Users — especially on /fork — never see the file. This phase makes structured
task output a first-class, remotely deliverable artifact without exposing the
host filesystem.

## Existing concepts reused (survey results)

| Concept | Reuse |
| ------- | ----- |
| `artifactRowSchema` (v4 frozen contract: artifactVersionId/logicalArtifactKey/displayName/artifactType/mimeType/sizeBytes/sha256/ref/state) | the conversation representation; already rendered by `ArtifactRowView` |
| `attachmentRefSchema` (`ref`/`fileName`/`mime`/`bytes`, opaque refs only) | the ref discipline: content never travels in frames, only opaque ids |
| `conversationAttachmentReadV4` chunked authorized read + `PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes` | the retrieval shape (offset/limit → dataBase64/totalBytes/mediaType) |
| `browserCommandResult.image {base64, mimeType:"image/png"}` | screenshot bytes already arrive at the host in the `interaction/browserExecute` result — no filesystem dependency |
| share-layer artifact row construction (sha256, sizeBytes, `zcode-artifact://` refs) | descriptor discipline |
| codex module pattern (channel facade + host-internal impl + relay passthrough) | service layout |

## Architecture

```
integrations (host process only)            renderer (/fork · desktop)
─────────────────────────────               ─────────────────────────
browser-use: interaction/browserExecute     useTaskArtifacts(taskId)
  result.image {base64} ──┐                   │ listTaskArtifacts (channel)
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

| State | Owner | Persisted |
| ----- | ----- | --------- |
| artifact metadata + bytes | host task-artifact store (`<dbDir>/task-artifacts/<taskId>/<artifactId>.bin` + `index.json`) | yes |
| artifact rows (codex tasks) | `CodexThreadProjection` (in-memory, host-owned) | no |
| artifact list (zcode tasks) | renderer fetch, id-keyed | no |

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
