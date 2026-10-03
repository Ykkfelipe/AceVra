# Personal Bot — milestone spec (M1 foundation, M2 conversation, Bot Workspace V2)

> Roadmap: `docs/roadmap/personal-bot.md`. Sections 1–12 are **M1** (foundation); section 13 is
> **M2 Phase 1** (the persistent Bot conversation). The contract is extended here rather than
> rewritten: every M1 invariant stays authoritative unless section 13 explicitly narrows or
> supersedes it.

## 1. Product rule for M1

The user experiences **one persistent personal Bot**, not a team of agents and not a coding
workspace. M1 establishes the _identity and boundaries_ that make that possible, and a Bot section
in the app that is visibly separate from Coding Sessions.

M1 ships:

1. A persistent Bot identity, separate from any conversation.
2. A Bot profile structure (name, avatar reference, style/persona descriptor).
3. A persistent Bot conversation shell: the Bot owns _which_ session is its conversation; the
   session runtime owns the messages.
4. Personal-memory interfaces with explicit write/read boundaries and **bounded retrieval**
   instead of injecting the whole store.
5. A declared capability surface (web / email / calendar / files / devices) with availability and
   approval semantics — declarations only, no new integrations.
6. A Bot section in the app that is clearly distinguished from Coding Sessions.

M1 explicitly does **not** ship: email/calendar integrations, device registry integration, voice,
goals/ideas surfaces, Bot self-customization, or Cross-Mode wiring.

## 2. Ownership (one owner per piece of state)

| State                                  | Owner                                                              | Notes                                                                      |
| -------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Bot identity + profile                 | `bot` module (single JSON document, single writer)                 | Never derived from a chat transcript.                                      |
| Bot conversation pointer (`sessionId`) | `bot` module                                                       | The pointer only. The Bot module never writes messages.                    |
| Conversation messages / turns          | CLI `AgentRuntime` → `SqliteSessionStore`                          | Unchanged ownership. The Bot module must not persist messages.             |
| Personal memory records                | `bot` module                                                       | Separate document from identity; separate from Project (coding) Memory.    |
| Capability availability facts          | Re-projected from existing capability sources                      | The Bot module declares the surface; it does not become a second registry. |
| Bot workspace path / identity          | `@zcode/shared` constant + `packages/services/src/paths.ts` helper | One canonical value so the host and the runtime agree.                     |

**Explicitly not the owner:** `packages/services/src/memory` (Project Memory for coding
workspaces) and `packages/services/src/session` (desktop task-index shadow + automations). Personal
memory is a different concern and must not be folded into either.

## 3. Module layout

New managed module `bot` at `packages/services/src/bot` (layers `domain → app → adapters`,
registered in `architecture-policy.yaml`):

```text
bot/
  contract.ts          public entrypoint: value types + IBotService + descriptor
  module.ts            manifest
  CONTRACT.md          invariants types cannot express
  domain/              pure: no IO, no await on the world
    identity.ts        default identity, profile normalization, patch application
    memory.ts          memory normalization + bounded relevance selection + rendering
    capabilities.ts    declarative capability surface projection
    shell.ts           conversation-shell value construction
  app/
    ports.ts           BotStorePort
    botService.ts      orchestration + single-writer serialization
  adapters/
    fileBotStore.ts    JSON documents on disk, atomic write, tolerant read
```

## 4. Persistence boundary

Root: `{dataBaseDir}/.zcode/personal-bot`, three independent documents:

```text
identity.json       { version, identity, profile }
conversation.json   { version, shell }
memory.json         { version, records[] }
```

Rules:

- **Identity is separate from conversation state.** A new/cleared conversation never resets
  identity, profile, or memory; editing the profile never rewrites conversation data.
- Writes are atomic (temp file + rename) and serialized per document by the app layer.
- Reads are tolerant: a missing file yields defaults; an unparseable or schema-invalid file is
  reported as a read error to the caller, never silently overwritten.
- Corrupt documents must not delete user data: the adapter keeps the bad file and surfaces the
  error.
- `version` is present from day one so later migrations are explicit.

## 5. Bot conversation shell

```ts
interface BotConversationShell {
  workspacePath: string; // dedicated Bot workspace, never a coding repo
  workspaceKey: string; // workspaceIdentity?.trim() || workspacePath
  sessionId: string | null; // pointer to the Bot's conversation session
  createdAt: number;
  updatedAt: number;
}
```

Semantics:

- The Bot workspace is dedicated: `{dataBaseDir}/.zcode/workspace/personal-bot`. It is never a
  user repository. The M1 workspace is local and has no separate identity, so `workspaceKey`
  equals `workspacePath`; a future remote Bot workspace would carry its remote identity here
  without changing caller semantics.
- `sessionId` is a **pointer**, set by `setConversationSession`. The module does not create
  sessions; it records which existing session the Bot surface resumed last.
- Setting the same id twice is idempotent; setting `null` clears the pointer without touching
  identity/memory.
- A stale pointer (session deleted along another path) must degrade to "start a new Bot
  conversation", not to an error loop. The surface clears the pointer when a resume fails.

## 6. Personal memory

### 6.1 Record shape (M1)

```ts
type PersonalMemoryCategory =
  | "person"
  | "project"
  | "goal"
  | "preference"
  | "routine"
  | "place"
  | "decision"
  | "event"
  | "situation";

interface PersonalMemoryRecord {
  id: string;
  category: PersonalMemoryCategory;
  title: string;
  summary: string;
  details?: string;
  tags: string[];
  pinned: boolean;
  source: "user" | "bot";
  createdAt: number;
  updatedAt: number;
}
```

The category union is closed in code but intended to grow; adding a category is additive and must
not change retrieval semantics for existing categories.

### 6.2 Bounded retrieval (the core M1 rule)

Retrieval is a **pure projection**, never a dump:

```ts
selectRelevantPersonalMemory(records, query, limits) -> { selected, omittedCount }
renderPersonalMemoryContext(selection, limits) -> string
```

Invariants:

- Hard caps: at most `DEFAULT_MAX_MEMORY_RECORDS` (8) records and
  `MAX_MEMORY_CONTEXT_BYTES` (4096) bytes of rendered context. The rendered text is truncated at a
  record boundary, so the cap is always honoured.
- Pinned records are always eligible; unpinned records must earn selection by relevance.
- Selection is deterministic: score desc, then `updatedAt` desc, then `id` asc.
- The result always reports how many relevant records were omitted, so a caller can tell the model
  "more exists" without shipping it.
- An empty query returns only pinned records — never the whole store.
- Byte accounting is UTF-8 accurate; multi-byte content must not exceed the cap.

Cross-Mode and any future turn-time injection consume this interface; they must not re-implement
scoring or bypass the caps.

## 7. Capability surface

`listCapabilitySurface()` returns a declarative projection over the roadmap domains:

```ts
interface BotCapabilityEntry {
  domain: "web" | "email" | "calendar" | "files" | "devices";
  label: string;
  availability: "available" | "not_configured" | "planned";
  access: "read" | "read_write";
  requiresApproval: boolean;
  summary: string;
}
```

Rules:

- This is a **declaration surface**, not a tool registry. It must never claim a capability is
  executable when no implementation exists: M1 marks `web`/`files` `available` (existing native
  tools), `email`/`calendar` `not_configured`, `devices` `planned`.
- Consequential actions (`requiresApproval: true`) are an explicit property of the declaration so
  later approval UX has one source.
- Later milestones replace `availability` inputs with real probes; the shape stays stable.

## 8. Session kind for Bot conversations

- `SESSION_TASK_TYPES` gains `personal_bot`; the legacy protocol schema mirrors it.
- Bot sessions are created with `taskType: "personal_bot"` **at creation time**, decided by the
  surface that creates the Bot conversation. The V4 `createSession` payload carries an optional,
  fail-closed `taskType` restricted to an allowlist; an older CLI silently drops the key and the
  session is a normal `interactive` session (degraded, not broken).
- `personal_bot` is **not** in `TASK_LIST_SESSION_TYPES`: Bot conversations must not appear in the
  Coding Sessions list.
- Bot sessions are excluded from Project (coding) Memory by the existing
  `isMainMemoryTaskType` predicate — this is intended, not a regression.
- Title generation treats `personal_bot` like `interactive` so Bot conversations get real titles.

## 9. UI boundary

- The Bot is a peer surface, not a coding session: a dedicated sidebar entry and a dedicated main
  view (`WorkspaceMainView = "bot"`), never the session list.
- The Bot section renders Bot identity/profile, personal memory, the capability surface, and the
  Bot conversation bound to the shell.
- Bot UI reads state through `IBotService` only; it must not read the Bot JSON files or the session
  database directly.
- Strings are localized in both `en-US` and `zh-CN`.

## 10. Failure semantics summary

| Failure                          | Behaviour                                                     |
| -------------------------------- | ------------------------------------------------------------- |
| Bot documents missing            | Create with defaults on first write; reads return defaults.   |
| Bot document unparseable         | Surface a read error; keep the file; do not overwrite.        |
| Memory store empty               | Retrieval returns empty selection; no context is injected.    |
| Conversation pointer stale       | Surface clears the pointer and starts a new Bot conversation. |
| Older CLI without `personal_bot` | Session is created as `interactive`; Bot UI still works.      |

## 11. Acceptance scenarios (M1)

1. First open creates identity + profile with defaults; reopening returns the same identity after
   restart.
2. Editing the profile changes name/style but leaves memory and conversation pointer untouched.
3. Bot conversations are sessions in the Bot workspace and do not appear in the Coding Sessions
   list.
4. Personal memory with 200 records and a narrow query injects at most 8 records / 4096 bytes and
   reports the omitted count.
5. Pinned records survive an empty query; unpinned records do not.
6. A corrupt `memory.json` produces an error and is not overwritten.
7. Capability surface reports email/calendar as not configured and never as available.
8. The Bot section is reachable from the sidebar and is visually distinct from Coding Sessions.

## 12. Deferred (explicitly out of M1)

Voice notes (both directions), goals/ideas objects, Bot appearance/self-customization tooling,
device registry integration, real email/calendar providers, memory management UI beyond listing,
Cross-Mode turn-time injection, and the Bot "space" sections beyond what M1 renders.

---

## 13. M2 Phase 1 (approved): the persistent Bot conversation

Phase 1 turns the M1 foundation into the first genuinely usable persistent Ace conversation. It
adds hosting, the conversation surface, and the pointer lifecycle — nothing else.

### 13.1 Scope

Ships: Bot workspace creation at startup; the Bot conversation surface; the conversation-pointer
lifecycle; a Cross-Mode adoption helper at the published-contract level.

Does **not** ship: turn-time personal-memory injection (gated to Phase 2 — it touches shared
protocol and CLI bootstrap files another worker is actively changing), capability probes,
email/calendar/devices integrations, any change to the Bot tool surface, any Cross-Mode admission
record or `HandoffExecutionPort`, voice, goals/ideas, self-customization.

### 13.2 Bot workspace hosting

- The Bot workspace `{dataBaseDir}/.zcode/workspace/personal-bot` is created at desktop startup,
  **mkdir-only**, mirroring how `conversationWorkspaceDir` is created. A failure to create it is
  logged and does not abort startup.
- It must **not** be added to `initialWorkspacePath`, `workspacePurpose`, `agentWarmupTargets`, the
  tab store, or the Coding task/session index. It is a backing directory, not a workspace the user
  opens.
- The runtime stays **lazy**: the CLI process for the Bot `workspaceKey` is spawned by the first
  conversation subscription, exactly like any other workspace. No always-on agent process is
  created for the Bot.
- Rationale for mkdir at all: the spawn path falls back to the conversation directory when the
  requested cwd does not exist, while the session's `workingDirectory` stays the Bot path — which
  would make relative file operations resolve against the wrong directory.

### 13.3 Conversation surface

- The Bot section hosts a **single-pane conversation** built from the existing primitives
  (`V4ChatPane` = `V4ConversationProvider` + `SessionPane`). The workbench host
  (`V4WorkspaceChatArea`) is **not** used: its pane tree and workbench groups are global and not
  workspace-scoped, so embedding it would render and mutate the user's coding split panes.
- Composer, streaming, tool rendering, permission dialogs, rewind and draft prewarm are **reused as
  is**. The Bot adds no message persistence, no streaming path, no tool renderer, no permission
  handling, and no second conversation runtime.
- The Bot conversation is created with `taskType: "personal_bot"` (M1 §8) in the Bot workspace.
- Bot conversations stay outside the Coding Sessions index in Phase 1 (M1 §8 unchanged). The
  consequence — no session list, search or notifications for Bot conversations — is accepted for
  this phase; a Bot-scoped projection is a separate decision.

### 13.4 Conversation-pointer lifecycle

`BotConversationShell.sessionId` remains the **sole durable authority** for which session the Bot
uses. The lifecycle is:

```text
open Bot
  → read shell pointer
      ├─ null           → draft (first send creates the session)
      └─ non-null       → bind it; the subscription resolves it
                            ├─ resolves → conversation continues
                            └─ sessionNotFound → clear pointer → draft
  → onSessionCreated  → setConversationSession(newId)
  → onSessionDeleted  → setConversationSession(null)
  → session disappears while open (reactive race) → clear pointer → draft
```

Invariants:

- **There is deliberately no preflight validation.** An `existing-only` session read reports whether
  a runtime is _alive_, not whether a session exists — verified from source during implementation.
  Because the Bot runtime is lazily spawned, a preflight on a cold start would misreport a valid
  pointer as stale and erase it. Validation is therefore part of the normal open: showing the
  conversation requires subscribing anyway, so the subscription's own `sessionNotFound` is the
  authoritative signal, and no throwaway runtime is created just to validate.
- Only `sessionNotFound` clears the pointer. Transport hiccups, turn failures and other error states
  must not, otherwise a recoverable error would escalate into a lost conversation.
- The unavailable signal is reported at most once per session id, so a host that has not yet finished
  clearing does not receive a storm of repeats.
- Clearing a stale pointer touches **only** `conversation.json`. Identity, profile and personal
  memory are never affected by pointer recovery (M1 §4 separation is preserved).
- Recovery is silent and forward-moving: the user gets a fresh draft, not an error loop.
- A session that was opened but never sent into is still a server-side draft and legitimately
  disappears; falling back to a draft is correct, not a fault.
- The pointer is written on the accepted create/delete boundaries only — never optimistically
  before the CLI acknowledges the session.

### 13.5 `activeTaskId` containment (CQ2 resolution)

Verified from source during implementation:

- `SessionPane` never reads or writes `zcodeSessionStore.activeTaskId`; it reports a created session
  through its `onSessionCreated` prop and the shell decides what to do. `V4ChatPane` and
  `V4ConversationProvider` have zero `activeTaskId` coupling.
- Every `paneId`-keyed state in `SessionPane` (scroll memory, draft prewarm) is additionally keyed
  by `workspaceKey`, so reusing `paneId="workspace-main"` for the dedicated Bot workspace cannot
  collide with a coding pane.
- The only store write on the draft-send path is `promoteGroupedDraftTask`, gated on a per-workspace
  `groupedDraftTask`. Only the coding grouped-draft feature sets it, and it is never set for the Bot
  workspace key.

Therefore the Bot module stays the sole authority for "which session the Bot uses", and
`activeTaskId` is not involved at all. **No containment change is required.**

### 13.6 Cross-Mode adoption (published-contract level only)

- The Bot conversation reference is `{ kind: "conversation", id: <shell.sessionId> }`, conforming to
  Cross-Mode's published `handoffObjectRefSchema` (id charset/length and the `conversation` object
  kind). The helper is a pure projection of the shell; it adds no state.
- Personal Bot creates **no** Cross-Mode admission records and implements **no**
  `HandoffExecutionPort`. Destination work creation stays with Cross-Mode's executor milestone.
- Personal memory must **never** be carried into handoff context automatically. The frozen contract
  starts `personal`/`sensitive` context items excluded and requires explicit user inclusion; auto
  carrying memory would bypass that rule and M1 §6.2's bounded-retrieval boundary.
- The adoption is verified against the frozen contract rather than a hand-written copy of its rules.

### 13.7 Failure semantics (Phase 1)

| Failure                                   | Behaviour                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| Bot workspace directory cannot be created | Logged; startup continues; the Bot surface reports the failure when opened. |
| Shell pointer points at a missing session | Pointer cleared; fresh draft; identity/memory untouched.                    |
| Session disappears while the Bot is open  | Same clear-and-draft reaction via the subscription error.                   |
| `conversation.json` unusable              | M1 behaviour: `BotStoreCorruptError`, file preserved, no silent reset.      |
| `IBotService` unavailable (old host)      | Bot entry hidden (M1 behaviour).                                            |
| Bot workspace runtime fails to start      | Surfaced by the normal conversation error path; no Bot-specific retry loop. |

### 13.8 Acceptance scenarios (Phase 1)

1. First Bot launch: the Bot workspace directory exists after startup; the Bot section shows a draft
   with no error; identity and profile render.
2. Send a message: a `personal_bot` session is created in the Bot workspace, the pointer is
   persisted, and the reply streams through the ordinary path with tool rows and permission prompts.
3. Restart and resume: after relaunch the Bot binds the same session with an intact transcript and
   no second session created.
4. Bot ↔ Coding navigation: opening the Bot and returning to a coding session leaves the coding
   transcript and its split panes untouched; the Bot conversation never appears in the Coding
   Sessions list.
5. Stale pointer recovery: deleting the pointed-at session and reopening the Bot clears the pointer
   and produces a fresh draft, with identity and memory unchanged.
6. Cross-Mode reference: the helper returns a ref that satisfies the frozen contract for a shell
   with a session, and `null` without one; it never contains memory content.

### 13.9 Deferred to M2 Phase 2 (gated)

Turn-time personal-memory injection. It is designed (a per-turn system-reminder source mirroring
`capability_context`, fed by a CLI→host read of `IBotService.buildMemoryContext()` with defaults,
fail-open and text-only on the wire) but must not be implemented while another worker holds the
shared protocol and CLI bootstrap files. It must not be implemented against a private or in-progress
sibling implementation.

Also deferred: Bot tool-surface decisions (whether the Bot may invoke `Multitask`/`Agent`/`Task`),
a Bot-scoped session projection, capability probes, and every domain expansion.

---

## 14. M2 Phase 2 (approved): turn-time personal-memory injection

Makes Ace's bounded personal memory available to the model on every `personal_bot` turn, while
retrieval, scoring and privacy stay entirely inside the Bot module.

### 14.1 Ownership

| Concern                                          | Owner                                         |
| ------------------------------------------------ | --------------------------------------------- |
| Retrieval, scoring, record count and byte budget | `bot` module (`domain/memory.ts`) — unchanged |
| Rendering into context text                      | `bot` module                                  |
| Transporting the rendered text to the model      | CLI runtime (a per-turn reminder)             |
| Deciding whether memory exists at all            | `bot` module (empty text = nothing)           |
| Raw `PersonalMemoryRecord[]`                     | **never leaves the host**                     |

The CLI never reads, selects, ranks or truncates personal memory. Its only job is to carry the
already-rendered string and to enforce the gate, the dedupe and the failure policy.

### 14.2 Wire contract

`interaction/personalMemoryContext` (CLI → host), strict schemas on both sides.

- Params: `{ requestId, sessionId, query, turnId? }`. `query` is the turn's canonical user input,
  the same text the capability and plugin reminders use.
- Result: `{ text, omittedCount, byteLength }`.
- **No budget parameters cross the boundary.** `maxRecords` / `maxBytes` are not in the schema, so a
  caller cannot widen them; a request carrying them is rejected outright rather than silently
  accepted.
- The host handler re-projects the response onto exactly `text` / `omittedCount` / `byteLength`, so
  even a resolver that returns a whole context object (including `selected`) cannot put raw records
  on the wire. This is a structural guarantee at the boundary, not a convention.

### 14.3 Injection point and timing

- Per turn, never at runtime/conversation initialization. The reminder is a
  `per_current_turn` / `current_turn` source computed fresh for each turn, so memory that changes
  between turns is reflected.
- Injected immediately after the capability context, inside the same
  `options?.inputVisibility !== "model-only"` guard, preserving the established
  `user → system` causal ordering.
- Attached as a model-only system-reminder attachment: it is **not** persisted as ordinary
  user-visible conversation content.
- The same body is not re-appended when it is already in history; a changed body is appended, so the
  transcript records when memory actually changed.

### 14.4 Gating

`taskType === "personal_bot"` is required, enforced twice and independently:

1. The port is only installed on sessions created with `taskType: "personal_bot"`, so any other
   session has no way to reach the host (structural).
2. The injection method re-checks the task type before touching the port, so the invariant does not
   depend on a call site remembering to check (behavioural).

A non-Bot session therefore neither receives Bot memory nor causes a host round trip.

### 14.5 Failure semantics

Memory is an enhancement, never a precondition. Fail-open is enforced at three layers: the protocol
port adapter (RPC error, old host, timeout → no context), the injection method (any throw → debug log,
turn continues), and the host handler (resolver absent or throwing → empty context, not an error).
A memory failure must never prevent a user turn or a model response.

The port uses a short timeout (1s, the same order as the execution-target refresh) because retrieval
is a local file read; waiting longer is never worth delaying the user's turn.

Malformed request params are still reported as a protocol error — "the request was invalid" and
"there is no memory" are different facts and must not be conflated.

### 14.6 Unchanged from earlier milestones

Pointer authority (§13.4), the `V4ChatPane` conversation host, no Bot message persistence, the
lazy-runtime mkdir-only Bot workspace, `personal_bot`'s exclusion from the Coding Sessions index, and
the rule that personal memory is never automatically carried into Cross-Mode handoffs (§13.6) all
stand. Project (coding) memory is a separate subsystem and is not affected: it is keyed to coding
workspaces and its `isMainMemoryTaskType` gate excludes `personal_bot` exactly as before.

### 14.7 Acceptance scenarios (Phase 2)

1. A Bot turn whose query matches a stored memory receives the bounded context; the block is visible
   in the provider request and is not user-visible conversation content.
2. With 200 stored records and a narrow query, the injected context still respects the Bot module's
   record and byte limits and reports omissions.
3. A query with no match injects nothing (no empty block).
4. A failing or unavailable memory path leaves the turn working and logs at debug only.
5. A non-`personal_bot` session never receives Bot memory and never queries the host.
6. Repeated turns with unchanged memory do not accumulate duplicate blocks.
7. No raw personal-memory record crosses the protocol boundary.
8. Coding sessions and Project Memory behave exactly as before.

## 15. M2+ (approved direction): Bot surface redesign

The first-pass Bot surface (stacked header + chat + report-card sidebar) did not match the product's
intended feel. Three reference products were reviewed; their shared structure is: a **dominant chat
column**, a **slim identity header**, and a **tabbed context panel** on the right (profile / memory /
computers). The Bot surface is redesigned onto that structure in AceVra's own visual language
(`DESIGN.md` tokens only, no hardcoded reference palettes, light and dark both correct).

### 15.1 Layout

- Chat is the dominant region and always renders first (`BotConversation`, the `V4ChatPane` host,
  unchanged from §13). Context data never gates the conversation.
- A slim header carries the Ace identity (avatar, name, descriptor, style badges, refresh). It is
  chrome, not content; no actions beyond refresh.
- The right panel (`w-80`, borders via `border-border`, stacks below chat under `md`) is a Tabs
  surface with exactly three tabs: **Memory**, **Computers**, **Capabilities**. Tab labels, presence
  labels, roles, platforms and capability chips are localized (`bot.*` keys, en-US/zh-CN parity is
  enforced by the presentation test).

### 15.2 Computers tab (read-only)

- Lists the machines Ace can work with, from the existing account device registry via
  `IPlatformService.account.listDevices()` (`AccountDevicesView`). No new registry, no second data
  path, no state owner.
- **Read-only + status only** (user-approved scope): presence dot (online uses the success token),
  display name, role (this computer / AceVra desktop / server node), platform label, and capability
  chips. Pairing, renaming, revoking stay in the account Computers section — the Bot surface links
  nothing and mutates nothing.
- Failure semantics match the rest of the Bot surface: `listDevices()` unavailable or throwing
  renders an unavailable note, never blocks the chat or other tabs, and never shows credentials
  (the view type is descriptive facts only).
- Future servers (e.g. an SSH Dell) are `type: "node"` rows in the same registry; they need no
  special-casing here. The empty state says future machines will appear here.

### 15.3 Unchanged invariants

One persistent Ace (no multi-bot list, despite the references); identity separate from conversation
state; `BotConversationShell.sessionId` remains the sole durable conversation authority; personal
memory retrieval stays behind `IBotService.buildMemoryContext()` with §14's wire limits; no Bot
entries in Coding Sessions; Computer Use execution is untouched (this surface only _displays_ the
device registry).

---

## 16. Bot Workspace V2 (approved): a separate workspace, many Ace conversations

V1 of the surface was functionally correct but still read as "another coding chat": the coding
Project/Tasks sidebar and the coding `WorkspaceHeader` stayed on screen around the Bot. V2 makes the
Bot a separate AceVra workspace. The rule:

> **Global navigation stays global; the secondary workspace navigation changes completely when Bot
> is selected.**

Information architecture is inspired by reference personal-assistant products; the visual language is
AceVra's own (`DESIGN.md` tokens only, light and dark both validated).

### 16.1 Shell structure

```text
Global rail | Secondary sidebar              | Main                         | Inspector (Bot only)
(always)    | Coding → New task, Group/      | Coding → WorkspaceHeader +   |
            |   Project, Projects, Tasks     |   V4WorkspaceChatArea        |
            | Bot    → Ace, + New            | Bot    → Ace header +        | Memory
            |   conversation, Today /        |   V4ChatPane (unchanged)     | Computers
            |   Yesterday / Previous 7 days /|                              | Capabilities
            |   Older                        |                              |
```

- **Global rail** (`GlobalNavRail`, narrow, always visible on desktop and wide Web): owns the top-level
  destinations — Coding, Bot, Search (command center), Scheduled (Automations), Plugins — and, at the
  bottom, the account menu and Settings. It only dispatches the **existing** handlers
  (`handleSelectTask` / chat view, `handleOpenBot`, `onOpenCommandCenter`, `handleOpenAutomations`,
  `handleOpenPluginStore`, the existing footer account menu, `openSettingsTab`); it adds no new
  navigation state. Bot appears only when `IBotService` exists (M1 rule unchanged).
- **Secondary sidebar** is contextual and keeps its resizable/collapsible panel. Collapsing hides only
  the secondary sidebar; the rail stays. Under the mobile breakpoint the rail travels with the
  drawer (it is hidden whenever the drawer is closed) so a phone never loses horizontal space.
- When **Bot** is the main view, nothing coding-specific renders: no `WorkspaceSidebar` content
  (Group/Project toggle, Projects, Conversations, pinned tasks), no coding `WorkspaceHeader`
  (project/task title, git, terminal, side-pane toggles), no terminal panel, no side pane.
- Coding, Automations and Plugins keep their current content; only their entry buttons move to the
  rail.

### 16.2 Ownership (one owner per fact)

| State                                                      | Owner                                                                           | Notes                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Which conversation is selected (durable)                   | `bot` module — `BotConversationShell.sessionId` (`conversation.json`)           | Unchanged sole authority (§13.4). Now means "the selected Ace conversation".                   |
| Bot conversation history (which exist, title, times)       | CLI `SqliteSessionStore`, read through `session/list` projection `personal-bot` | Derived on read. No Bot-side copy, cache file or index.                                        |
| Messages / turns                                           | CLI `AgentRuntime` (unchanged)                                                  |                                                                                                |
| Coding task index (`tasks-index.sqlite`)                   | Host task-index syncer, fed only by `sessions-index`                            | `sessions-index` membership stays `TASK_LIST_SESSION_TYPES`; Bot never enters it.              |
| Bot workspace UI state (rows on screen, pending selection) | `BotWorkspaceProvider` (React, renderer)                                        | A mirror of the two owners above; it writes only through `IBotService.setConversationSession`. |
| Device registry (Computers tab)                            | Account (`IPlatformService.account.listDevices()`)                              | Unchanged (§15.2).                                                                             |

### 16.3 History projection: `session/list` with `projection: "personal-bot"`

- `zcodeSessionListParamsSchema` gains an optional, closed `projection` enum:
  `"task-list"` (default, today's behaviour) | `"personal-bot"`. The schema stays `.strict()`, so a
  caller cannot pass arbitrary task types; there is no free-form `taskTypes` on the wire.
- `"personal-bot"` returns only `taskType === "personal_bot"` sessions, from the store **and** the
  live, non-deferred runtime records, filtered to the requested workspace. It requires `workspace`
  (the Bot workspace from the shell); a request without it is a protocol error.
- `"task-list"` (or no projection) is byte-for-byte today's membership: `personal_bot` stays excluded,
  so Coding Sessions, the command center and the task index are unaffected.
- The `sessions-index` topic and the host task-index syncer are **not** touched. They feed
  `tasks-index.sqlite`; widening them would write Bot sessions into the coding index.
- The host passes `projection` through `IZCodeSessionService.listSessions` →
  `zcodeAgentService.listSessions` unchanged. The Bot UI composes `IBotService` (for the workspace
  path and pointer) with `IZCodeSessionService` (for the list) in a UI hook; the `bot` module takes no
  dependency on the session service.
- Rows carry `sessionId`, `title`, `titleSource`, `createdAt`, `updatedAt` (`ZCodeSessionInfo`). The
  sidebar shows title (fallback "New conversation") and a relative timestamp; grouping is by
  `updatedAt` in local time: Today / Yesterday / Previous 7 days / Older, newest first.
- Reading the list starts the Bot workspace runtime if it is not running. This is still lazy (§13.2):
  it happens when the user opens Bot, never at app startup.

### 16.4 Event order

```text
open Bot
  ├─ IBotService.getConversationShell()          → pointer (selected id | null)
  └─ zcodeSessionService.listSessions(personal-bot) → rows        (parallel; generation-guarded)
  pane binds pointer (null → draft)

select row R           → UI selects R immediately → setConversationSession(R) → pane binds R
                          (sessionNotFound → §13.4 clear pointer → draft → refresh rows)
+ New conversation     → UI selects draft         → setConversationSession(null)
                          previous rows stay: they come from the store, not from the pointer
first send in draft    → SessionPane creates personal_bot session → onSessionCreated(id)
                          → setConversationSession(id) → refresh rows
title / turn settles   → SessionPane onSessionPresentationChange({sessionId,title,sessionEnded})
                          → refresh rows (coalesced: one in flight + one trailing)
delete current         → onSessionDeleted → setConversationSession(null) → refresh rows
```

Rules:

- Pointer writes still happen only on accepted boundaries (selection click, CLI-acknowledged
  create/delete). The service serializes writes per document; the last click wins.
- List reads are generation-guarded: a slower, older response never overwrites a newer one.
- A refresh failure keeps the last rows on screen and shows an inline error; it never clears the
  pointer and never blocks the conversation.
- No timers or polling. Freshness comes from the events above.
- The new pane callback `onSessionPresentationChange` is a narrow, read-only notification (same
  precedent as `onSessionUnavailable`): it fires when `(sessionId, meta.title,
control.sessionEnded)` changes. Coding hosts do not pass it.

### 16.5 Main conversation and inspector

- The conversation stays `V4ChatPane` with `createSessionTaskType="personal_bot"`, unchanged
  streaming, restart/resume, memory injection (§14) and pointer semantics (§13.4).
- Header: a single slim, draggable row with a small Ace avatar, the conversation title (or "New
  conversation") and, on the trailing side, a reserved actions slot, refresh, and an inspector toggle.
  It replaces the coding `WorkspaceHeader` for this view.
- Composer: assistant-oriented placeholder copy through a narrow placeholder-variant prop —
  "What can I help you with?" (empty), "Reply…" (idle with history), "Keep typing — I'll read it
  next" (turn running); no new composer.
- Inspector: the same Memory / Computers / Capabilities tabs (§15). The **Computers tab hosts the
  live Computer pane** from `acevra-agent-computer.md` §3.3 — the same `ComputerPane` the coding
  side pane uses (live screen stream, Working / Idle / Offline status, Take control / Give back /
  Resume / Stop), reading the same SSH computer list the user configures in Settings → Computers.
  No second machine registry: the account-device pairing stays in Settings. The pane's **Stop ends
  the owning chat turn** (only when that job's session is the selected Bot conversation), and the
  pane's expand/collapse widens/narrows the inspector (per-viewer convenience, not persisted).
  **Auto-open:** when the agent's first `RemoteComputer` action of the selected conversation is
  announced by Main (`computers.onSessionStarted`, once per conversation), the Bot view reveals the
  inspector if hidden, switches it to the Computers tab and selects that computer — the same
  surface contract as the coding side pane. It can be hidden from the header; the choice
  is a per-viewer convenience kept in `localStorage` (wrapped in try/catch).
- **Cross-Mode:** the header's trailing actions slot (`data-testid="bot-conversation-actions"`)
  hosts the explicit **Work on this** action (Bot → Coding), specified in
  `docs/specs/cross-mode-bot-to-coding.md`. Bot still creates no admission record and implements no
  execution port (§13.6): it only builds the frozen-contract draft from its own conversation and hands the
  confirmed snapshot to the target Coding runtime. It never writes `conversation.json` for a handoff and
  never offers personal memory or profile data as context.

### 16.6 Failure semantics (V2)

| Failure                                      | Behaviour                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| History read fails (runtime down, old CLI)   | Inline "couldn't load conversations" + retry; conversation still usable.  |
| Old CLI rejects `projection`                 | Same as above (strict schema); no fallback to the coding list.            |
| Selected row's session was deleted elsewhere | §13.4 self-heal: pointer cleared, draft, rows refreshed.                  |
| Pointer write fails                          | Logged at warn; UI keeps the selection for this session (as §13.4).       |
| `IBotService` missing                        | Bot rail entry hidden; nothing else changes.                              |
| Coding workspace folder missing (read-only)  | Coding composer stays hidden as today; Bot (own workspace) is unaffected. |

### 16.7 Acceptance scenarios (V2)

1. Selecting Bot removes every coding Project/Task/session element and the coding header.
2. Bot shows its own sidebar with Ace, "+ New conversation" and grouped history.
3. "+ New conversation" then a first message creates a distinct `personal_bot` session.
4. Several Bot conversations stay visible and selectable.
5. Switching conversations restores the matching transcript.
6. Restart keeps the history and reopens the selected conversation.
7. Bot sessions never appear in Coding Sessions/Tasks, the command center or `tasks-index.sqlite`.
8. Personal memory injection stays `personal_bot`-only (§14 tests unchanged).
9. Memory / Computers / Capabilities still work.
10. Bot → Coding → Bot keeps the coding selection and the Bot selection.
11. Auth sign-in/out behaviour is unchanged.
12. Workflow / Multitask / Cross-Mode code paths are unchanged.
13. Light and dark modes have no obvious layout defects.

### 16.8 Out of scope

Automatic mode routing, Cross-Mode handoff behaviour, Multitask changes, Auth changes, avatar
customization, routines/cron jobs, new assistant/persona systems, renaming/deleting conversations from
the sidebar, and unrelated visual redesigns of Coding, Automations or Plugins.
