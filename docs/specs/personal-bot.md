# Personal Bot — Milestone 1 spec (identity, memory boundaries, capability surface, conversation shell)

> Roadmap: `docs/roadmap/personal-bot.md`. This spec covers **M1 only**. It is the contract that
> later milestones (voice notes, goals/ideas, Bot self-customization, live voice, Cross-Mode
> consumption) extend; it deliberately does not implement them.

## 1. Product rule for M1

The user experiences **one persistent personal Bot**, not a team of agents and not a coding
workspace. M1 establishes the *identity and boundaries* that make that possible, and a Bot section
in the app that is visibly separate from Coding Sessions.

M1 ships:

1. A persistent Bot identity, separate from any conversation.
2. A Bot profile structure (name, avatar reference, style/persona descriptor).
3. A persistent Bot conversation shell: the Bot owns *which* session is its conversation; the
   session runtime owns the messages.
4. Personal-memory interfaces with explicit write/read boundaries and **bounded retrieval**
   instead of injecting the whole store.
5. A declared capability surface (web / email / calendar / files / devices) with availability and
   approval semantics — declarations only, no new integrations.
6. A Bot section in the app that is clearly distinguished from Coding Sessions.

M1 explicitly does **not** ship: email/calendar integrations, device registry integration, voice,
goals/ideas surfaces, Bot self-customization, or Cross-Mode wiring.

## 2. Ownership (one owner per piece of state)

| State | Owner | Notes |
| --- | --- | --- |
| Bot identity + profile | `bot` module (single JSON document, single writer) | Never derived from a chat transcript. |
| Bot conversation pointer (`sessionId`) | `bot` module | The pointer only. The Bot module never writes messages. |
| Conversation messages / turns | CLI `AgentRuntime` → `SqliteSessionStore` | Unchanged ownership. The Bot module must not persist messages. |
| Personal memory records | `bot` module | Separate document from identity; separate from Project (coding) Memory. |
| Capability availability facts | Re-projected from existing capability sources | The Bot module declares the surface; it does not become a second registry. |
| Bot workspace path / identity | `@zcode/shared` constant + `packages/services/src/paths.ts` helper | One canonical value so the host and the runtime agree. |

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
  workspacePath: string;        // dedicated Bot workspace, not a coding repo
  workspaceIdentity: string;    // stable Bot identity key
  sessionId: string | null;     // pointer to the Bot's conversation session
  createdAt: number;
  updatedAt: number;
}
```

Semantics:

- The Bot workspace is dedicated: `{dataBaseDir}/.zcode/workspace/personal-bot`, identity
  `personal-bot`. It is never a user repository.
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
  | "person" | "project" | "goal" | "preference" | "routine"
  | "place" | "decision" | "event" | "situation";

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

| Failure | Behaviour |
| --- | --- |
| Bot documents missing | Create with defaults on first write; reads return defaults. |
| Bot document unparseable | Surface a read error; keep the file; do not overwrite. |
| Memory store empty | Retrieval returns empty selection; no context is injected. |
| Conversation pointer stale | Surface clears the pointer and starts a new Bot conversation. |
| Older CLI without `personal_bot` | Session is created as `interactive`; Bot UI still works. |

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
