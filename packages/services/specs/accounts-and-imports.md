# Accounts & Imports (Phase 9)

Status: **implemented (phase 9, see HANDOFF.md).** Codex/Claude account bridges,
sanitized status, and Claude/Codex history discovery are live.

## Settings placement

Model Settings distinguishes two concepts that used to be conflated:

- **Providers** — model API / plan configuration (`preset` and `custom` navigation groups).
- **Connected accounts** — authenticated external execution accounts: Codex, Claude Code.
  The `account` variant of `ModelProviderNavItem`
  (`packages/ui/src/settings/model-provider-section/constants.ts`) carries a `source`, so each
  account is its own navigation node rendered by the static (non-sortable) list in
  `Navigation.tsx` and dispatched in `Detail.tsx` to
  `packages/ui/src/settings/account-bridge/AccountBridgeDetail.tsx`. The standalone top-level
  `accounts` Settings section stays removed; its old id migrates to `modelProvider`.

`connectionSelectionMatchesNavigationItem` excludes account nodes, so account nodes never
participate in provider drag-reorder and provider-family connection resolution never selects
one. The init/fallback path (`pickInitialConnectionNavigationItem`) only ever returns a
plan or preset node, so the default selection lands on account nodes only in the degenerate
case where no provider node exists at all.

**Command Code has exactly one presence.** It is a real personal model provider
(`command-code`, seeded by `officialProviderMetadataImporter`) _and_ a CLI account held
separately by `~/.commandcode/auth.json`. Previously both were surfaced in Model Settings —
the provider under `custom` and a look-alike "Command Code" account card — which read as a
duplicate. The CLI status now renders as a compact strip inside the Command Code provider
detail (`model-provider-section/CommandCodeCliStatus.tsx`) and is no longer part of the
accounts screens.

The compact provider detail must retain all useful fields from the supported local CLI
status payload: authenticated state, user, version, default model, and context window. The
default model and context window are metadata about the CLI execution account, not duplicate
provider identity or quota data; render them as a wrapping metadata line rather than restoring
the former multi-row account card. Quota and plan figures remain absent unless a supported
local status surface returns them.

Two _distinct_ features, deliberately not conflated:

1. **Account connection** — sign in to Codex / Claude Code through their own supported
   mechanisms. The source app owns and refreshes its credentials. ZCode never reads, copies
   or stores raw tokens, and receives only sanitized status.
2. **History import** — pull past conversations from each tool's local store. No credentials
   involved at all.

## Correction to the earlier investigation

An earlier pass concluded that "import" meant session import only, and that Codex account
connection should be avoided because it would require copying OAuth tokens. The first half
stands; **the second half was wrong**. Codex exposes a first-class account API through its
App Server that performs the browser OAuth flow itself. No token copying is required, so an
account bridge is both possible and safe.

## Codex — account connection via App Server

Installed client: `codex-cli 0.155.0-alpha.9.2`, bundled at
`/Applications/ChatGPT.app/Contents/Resources/codex`. Not on `PATH`; address it by that
absolute path. `codex login status` currently reports "Logged in using ChatGPT".

The protocol is self-describing, which is why none of this is guesswork:

```bash
codex app-server generate-json-schema --out <dir>   # JSON Schema
codex app-server generate-ts --out <dir>            # TypeScript bindings
```

`ClientRequest.json` defines 101 request methods. The relevant ones:

| Method                    | Purpose                       |
| ------------------------- | ----------------------------- |
| `account/login/start`     | begin login                   |
| `account/login/cancel`    | cancel an in-flight login     |
| `account/logout`          | disconnect                    |
| `account/read`            | sanitized account info        |
| `account/rateLimits/read` | plan limits / usage allowance |
| `account/usage/read`      | token usage summary           |

Transport: `codex app-server --listen` accepts `stdio://` (default), `unix://PATH` or
`ws://IP:PORT`. `codex app-server daemon` manages a shared local daemon and
`codex app-server proxy` bridges stdio to its control socket.

### The flow

`account/login/start` takes `LoginAccountParams`, whose variants include
`{ type: "chatgpt", … }`, `{ type: "apiKey", apiKey }`, plus Bedrock and device-code forms.
For subscription sign-in we send `{ type: "chatgpt" }` and get back:

```jsonc
{
  "type": "chatgpt",
  "authUrl": "…", // schema description: "URL the client should open in a browser
  //  to initiate the OAuth flow."
  "loginId": "…",
}
```

ZCode opens `authUrl` in the user's browser. Completion arrives as
`AccountLoginCompletedNotification { success, loginId, error }`. `AccountUpdatedNotification`
and `AccountRateLimitsUpdatedNotification` push later changes.

### What ZCode is allowed to see

`account/read` returns an `Account` union. The ChatGPT variant is exactly:

```jsonc
{ "type": "chatgpt", "email": string|null, "planType": PlanType }
```

`PlanType` ∈ free, go, plus, pro, prolite, team, business, enterprise, edu, … , unknown.

**There is no token field anywhere in that response.** Codex holds the OAuth material in its
own `~/.codex/auth.json` and refreshes it (`ChatgptAuthTokensRefresh*` is Codex-internal).
This satisfies every stated requirement: credentials stay Mac-host-only, nothing raw crosses
the relay, nothing is stored in the repo, no token can be logged or rendered, and Codex's own
login is preserved because ZCode never writes to it.

### Included usage surfaced to the UI

`account/rateLimits/read` is read alongside `account/read` (its failure is not an account
error — usage is an optional data plane). The response's `rateLimits` snapshot is mapped by
`packages/services/src/accounts/accountBridgeMapping.ts` into `AccountBridgeUsage`:

| Backend field                                                                         | Contract field                                                               |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `ordinaryUsageAllowed`                                                                | `ordinaryUsageAllowed`                                                       |
| `rateLimits.primary.usedPercent` / `.resetsAt` (Unix seconds) / `.windowDurationMins` | `primaryUsedPercent` / `primaryResetsAt` (ISO) / `primaryWindowDurationMins` |
| `rateLimits.secondary.*`                                                              | `secondaryUsedPercent` / `secondaryResetsAt` / `secondaryWindowDurationMins` |
| `rateLimits.rateLimitReachedType`                                                     | `blockedReason`, allowlisted to the documented enum values                   |

The acceptance read on 2026-09-23 used the installed Codex App Server directly over stdio
(`initialize`, `account/read`, `account/rateLimits/read`) without invoking inference. Its
sanitized response shape was:

```json
{
  "ordinaryUsageAllowed": true,
  "rateLimits": {
    "primary": { "usedPercent": 2, "windowDurationMins": 300, "resetsAt": 1790164641 },
    "secondary": { "usedPercent": 16, "windowDurationMins": 10080, "resetsAt": 1790729023 },
    "rateLimitReachedType": null
  },
  "rateLimitsByLimitId": {
    "codex": {
      "primary": { "usedPercent": 2, "windowDurationMins": 300, "resetsAt": 1790164641 },
      "secondary": { "usedPercent": 16, "windowDurationMins": 10080, "resetsAt": 1790729023 }
    }
  }
}
```

Account identifiers, account email, and credential material are deliberately omitted. This
live response confirms that this connected account currently supplies both percentages, reset
times, and the window durations. The UI names a window from its returned duration (300 minutes
→ 5 hours; 10080 minutes → weekly), not from primary/secondary position. Unknown durations
remain generic. A window is rendered only when `usedPercent` exists, and a reset is shown only
when `resetsAt` exists; neither is synthesized.
`account/rateLimits/updated` push notifications are still not consumed; usage is read on
demand with the rest of the status.

### Sign-in state honesty

Codex answers `account/read` only while its app-server child process is running. The harness
link preference is persisted in app settings, without credentials. On upgrade, a missing Codex
preference defaults to enabled so an existing Codex sign-in is recognized; an explicit disconnect
persists disabled across host and app restarts. Claude Code keeps its prior disabled default.
When the Codex link is disabled, `sourceSignInChecked` remains false because the source is not
asked. The UI only states "Signed in"/"Signed out" when it was actually checked.

The account service owns link transitions and reads/writes the preference through the settings
service. On Connect, it checks `account/read` first. An existing account enables the link and
returns connected without starting OAuth. A missing account starts browser sign-in; completion
then re-reads the source. A source read failure is an error and must not trigger another OAuth
round trip. Disconnect persists disabled and never logs out of Codex. Local task execution
still checks Codex sign-in directly, independent of this optional settings link.

```mermaid
sequenceDiagram
  participant UI as Settings
  participant A as Account service
  participant P as Settings service
  participant C as Codex app-server
  UI->>A: read status
  A->>P: read link preference
  P-->>A: enabled (missing Codex value = true)
  A->>C: account/read
  C-->>A: source account or error
  A-->>UI: verified status
  UI->>A: Connect (if needed)
  A->>C: account/read
  alt already signed in
    A->>P: persist enabled
    A-->>UI: connected, no OAuth
  else signed out
    A->>P: persist enabled
    A->>C: account/login/start
    A-->>UI: browser sign-in result
  end
```

## Claude Code — account connection via the CLI auth surface

Installed: `claude 2.1.202` at `~/.local/bin/claude`. Officially supported commands:

| Command                                                          | Purpose                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| `claude auth login [--claudeai\|--console\|--sso] [--email <e>]` | browser sign-in; `--claudeai` (subscription) is the default   |
| `claude auth logout`                                             | disconnect                                                    |
| `claude auth status --json`                                      | sanitized status                                              |
| `claude setup-token`                                             | long-lived token for programmatic use (subscription required) |

`claude auth status --json` on this machine returns:

```json
{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "email": "…",
  "orgId": "…",
  "orgName": "…",
  "subscriptionType": "pro"
}
```

Again **no token is exposed** — the status surface carries login state, auth method, API
provider, email and subscription tier only. Claude Code owns its credentials (keychain / its
own store) and ZCode reads status only. `email` and `subscriptionType` are mapped onto the
shared `AccountBridgeIdentity.email` / `.planType` slots so the Claude account card shows the
same account tokens as Codex.

`setup-token` is deliberately **not** the recommended path: it mints a long-lived token that
ZCode would then hold, which is the credential-custody outcome we are avoiding. Prefer
`auth login` + `auth status`.

### Claude quota: do not invent unavailable values

The installed `claude 2.1.202` documents `claude auth status --json` as a local status
surface; its observed output reports login, auth method, provider, and subscription identity,
but no quota fields. Do not generalize this observation into a claim about every Claude usage
API. The account screen should say only that usage information is not available through this
connection, and must show no estimated 5-hour or weekly figures.

Disconnect is available only while the harness bridge is connected. It stops that bridge and
does not invoke `claude auth logout`; source sign-in and harness connection are distinct states.
At approximately 420 px, detail metadata must remain readable, action rows must wrap, and no
nested action button should become full width through a broad descendant selector.

### Asymmetry worth designing around

Codex offers a structured JSON-RPC API with push notifications. Claude Code offers CLI
commands with JSON output and no event stream. The reusable service therefore defines one
interface and two adapters, with Claude's status obtained by polling on demand (on Settings
open, and after an explicit connect/disconnect) rather than by subscription. The asymmetry is
visible in the UI: Codex can show included-usage windows, Claude cannot.

## History import — separate feature

Claude (already built): `importClaudeNativeSessions`
(`packages/services/src/session/claude-native/claudeNativeSessionImportService.ts`) copies
Claude's `.jsonl` transcripts into the workspace as ZCode tasks. It is already shared by
onboarding (`OnboardingDialog.tsx:61`) and Settings (`MigrationSection.tsx:61`, rendered by
`AccountBridgeDetail` for the Claude account node, which is the Model settings split-panel
`account` variant in `model-provider-section/Detail.tsx`) through the
`useClaudeSessionMigration` hook, so it is already re-runnable after onboarding. Per
"do not duplicate it", this stays as is; only its presentation moved with the section.

Codex history import reads local rollout JSONL files under the effective Codex home. The App Server
bridge's initialized `codexHome` is the source of truth when present; history scanning never
mutates `CODEX_HOME` or reads credentials.

The Codex migration key is `workspaceIdentity?.trim() || workspacePath`. The same key is used for
scan deduplication and deterministic task IDs, so two remote identities sharing a filesystem path
cannot import into each other's task scope. A legacy path-keyed task is accepted as an
already-imported match only when it has Codex migration provenance and no conflicting workspace
identity; new remote identities never reuse another identity's task.

## Command Code execution status

Command Code's `status --json` execution distinguishes a missing executable from a present but
failed executable. `ENOENT` is the only failure mapped to `installed: false`; timeout, non-zero
exit, permission, and protocol failures map to `installed: true`, `authenticated: false`, and a
bounded error so the UI does not claim a broken CLI is not installed.

## Proposed shape

- `packages/services/src/accounts/accountConnectionService.ts` — provider-agnostic
  interface: `connect()`, `cancelConnect()`, `disconnect()`, `readStatus()`, returning only
  `{ connected, accountLabel?, planType?, authMethod?, lastCheckedAt, usage? }`.
- Adapters: `codexAppServerAccountAdapter` (JSON-RPC over the app-server socket) and
  `claudeCliAccountAdapter` (spawn `claude auth …`, parse `--json`).
- Credentials: none stored by ZCode. Where any local state is unavoidable, reuse
  `createCredentialService` (`packages/services/src/credential/credentialService.ts`) rather
  than adding a second secret store.
- Relay boundary: the RPC surface exposed to the browser carries only the sanitized status
  object above. `authUrl` is opened **host-side**; it is a one-time OAuth initiation URL, and
  the decision on whether it may cross to the browser is called out as an open question below.
  The host opener is platform-specific: `open` on macOS, `explorer.exe` on Windows, and
  `xdg-open` on Linux. Windows URLs are passed as an argument rather than through `cmd.exe`, so
  query metacharacters cannot split the OAuth URL. A missing platform opener is a bounded
  connection error, not a successful connection.
- Settings section "Accounts & Imports": Import from Claude Code, Import from Codex,
  connection/import status, re-import / reconnect, disconnect from this harness. Connect and
  import both require an explicit click; nothing runs automatically.
  connection/import status, re-import / reconnect, disconnect from this harness. Connect and
  import both require an explicit click; nothing runs automatically.

## Open questions before implementation

1. **Remote browser flow.** The relay is used from a phone. `authUrl` must be opened in a
   browser that can complete the OAuth and hand back to the _local_ Codex daemon. Opening it
   on the phone will likely fail, because the callback targets localhost on the Mac. Options:
   restrict connect to host-side sessions, or surface a QR/copy-link for the Mac. Needs a
   decision.
2. **Disconnect semantics.** "Disconnect from this harness" could mean forget ZCode's link
   only, or call `account/logout` / `claude auth logout` and sign the user out of the source
   app. The latter mutates the source login, which the brief says to preserve. Recommend
   default = forget the link only, with source logout behind a clearly separate control.
3. **App Server lifecycle.** Whether ZCode spawns `codex app-server` per request, attaches to
   the shared `daemon`, or requires the user to have Codex running.

## Command Code catalogue — clarification

The `command-code` provider added in Phase 8 is a real GOAT Provider API integration. Only
two models (`deepseek/deepseek-v4-flash`, `z-ai/glm-5.3-flash`) were exposed, purely as a
validation subset. The account's actual capability is the full catalogue: 76 models from
`GET /provider/v1/models`, of which 68 support `/chat/completions` and 8 (the Claude family)
are `/messages`-only. Exposing more is a configuration change requiring no code; the
`/messages` models additionally need a second provider entry with `anthropic-messages`.

## Live account status termination and Codex history parity (2026-09-23)

### Account status ownership and terminal behavior

`createAccountBridgeService` owns host-side harness-link state; the source CLI/App Server owns
source sign-in state and credentials. Renderer `useAccountBridge` owns only request presentation
state and sanitized snapshots. Every host status read must resolve to exactly one status for its
source. `readAllStatuses` may combine independent source reads, but each adapter has bounded
process/request timeouts so one source cannot strand the other. A connected state requires an
enabled harness bridge and a verified signed-in source account; signed-out or disabled links are
disconnected. Missing executables are not-installed. Launch/protocol failures are error and can
be retried. Codex usage is optional: `account/rateLimits/read` failure leaves a signed-in account
connected without usage.

```mermaid
sequenceDiagram
  participant UI as Account hook
  participant S as Accounts service
  participant C as Codex bridge
  participant L as Local source
  UI->>S: readAllAccountStatuses
  par Codex
    S->>C: resolve executable / start / initialize
    C->>L: app-server stdio JSON-RPC
    S->>C: account/read
    C-->>S: account or bounded error
    opt signed-in account
      S->>C: account/rateLimits/read
      C-->>S: usage or partial failure
    end
  and Claude
    S->>L: claude auth status --json (bounded)
    L-->>S: sanitized auth state or bounded error
  end
  S-->>UI: terminal per-source status
```

### Executable discovery

Codex discovery must consider an explicit configured path, executable names found on the
process PATH, and known macOS app-bundle locations without assuming one Homebrew prefix. Claude
uses the same host PATH lookup and configured-path precedence. Child processes inherit the
normalized host environment. Never put a user-specific home path into source.

For Codex, the supported ChatGPT macOS bundle currently places its app-server-capable CLI at
`ChatGPT.app/Contents/Resources/codex-cli/bin/codex`. Check both `/Applications/ChatGPT.app`
and `~/Applications/ChatGPT.app`, while retaining the previous
`Contents/Resources/codex` locations for older installations. The CLI candidate order remains
after PATH lookup, and `~/.local/bin/codex` / `~/.cargo/bin/codex` remain supported. A configured
executable continues to take precedence over all discovered candidates; an invalid configured
path remains not-installed rather than silently selecting a different CLI. Discovery checks
execute permission only and does not inspect account state or credentials.

### Codex local import boundary

Codex history import reads rollout JSONL session files only. The observed format starts with a
`session_meta` header (`payload.session_id`, `cwd`, `timestamp`, `cli_version`); conversation
records include `response_item` messages and tool-call/result payloads plus `event_msg` and
`turn_context`. The scanner must use Codex's configured home when supplied by the existing
App Server initialization, otherwise the standard per-user Codex home; it must never inspect
`auth.json` or import credentials. The adapter passes the initialized `codexHome` through the
same import request rather than reading or mutating global process environment. It filters by
workspace, activity range, and limit, and marks an already imported `codex` source session by
stable source identity.

A source adapter parses Codex records into the existing import-history/task creation contract.
Migration UI remains one shared `MigrationSection` with source-specific scan/import adapters;
Claude's existing parser and Codex's rollout parser stay source-specific. Imported tasks carry
`migrationSource = codex` and `migrationSourceSessionId` in task `meta_json`; task-index reads and
snapshot syncs preserve both provenance fields. The task index is the idempotency owner: derive
the deterministic task id from `(source, workspace key, original session id)`, where the
workspace key is `workspaceIdentity?.trim() || workspacePath`, check it before creation, and use
it so a retry cannot create a second task. Two remote identities that share one path therefore
remain distinct import scopes. Only user-visible user/assistant text
is converted; tool calls/results, reasoning, metadata, unknown record types and credentials are
ignored.

### Candidate previews and expansion

History scan candidates expose only deterministic, display-only preview metadata derived from
the same sanitized user/assistant message extractors used by import. The candidate contract may
contain a bounded title and at most one visible user and one visible assistant preview message;
each preview body is capped at 240 Unicode code points including its truncation marker. Full
source paths, reasoning, tool calls/results, metadata, credentials, raw records, and source
offsets remain excluded from preview metadata. The title is the existing bounded
first-visible-user-message title, with the first eight session-ID characters as fallback. Preview
generation performs no model/provider/account call.

Expansion is local UI state owned by the shared migration hook. It does not trigger another file
read, import, or network request. The candidate card renders previews as escaped plain text, keeps
selection and expansion as separate controls, preserves already-imported/duplicate provenance, and
prioritizes workspace/date metadata over full local paths. Malformed or missing sessions remain
bounded candidates or visible scan errors according to the existing import error contract.

Claude uses the same shared candidate presentation and, when the existing sanitized head parser
can provide the same bounded fields without duplicating parsing logic, the same preview policy.
Otherwise Claude parity is explicitly deferred rather than introducing a second parser.

Codex rollout sessions are local Codex history only. Account/App Server APIs do not establish
availability of general chatgpt.com conversations; no browser scraping, cookie copying, or
invented cloud-history endpoint is permitted.

### Isolated test filesystem boundary

Codex history scanner/import tests and account tests that may launch a Codex client must set
`CODEX_HOME` to a temporary directory before exercising the code and remove it afterward.
In a Node test runner process, resolving the Codex sessions directory without an explicit home
or `CODEX_HOME` fails with a clear isolation error. This guard is test-only: normal application
execution retains the standard `~/.codex` fallback. The regression suite verifies the isolated
scanner cannot discover or read entries from the user's real Codex sessions directory.

### Canonical visible conversation projection (2026-09-26)

Codex and Claude keep source-specific parsers because their records have different
semantics, but each source must produce one normalized ordered list of visible user and
assistant messages. Scan candidates, title/preview, and imported session creation must all
be derived from that same normalized list. Candidate preview is its bounded first visible
exchange; the imported timeline begins with precisely those same messages in the same order.

The visibility contract is:

- Include human-authored prompts and follow-ups, and assistant text actually exposed in the
  source conversation. Preserve their order and source timestamps when present.
- Ignore tool calls/results, system/developer/project instructions, AGENTS.md content,
  meta/context attachments, environment context, provider bootstrap, hidden reasoning,
  compaction summaries, protocol bookkeeping, and handoff/init sentinels as ordinary chat.
- Retain trustworthy source/session/workspace/model metadata as provenance, not chat text.
  Never synthesize absent timestamps or model values in the normalized message projection.
- For Codex, `response_item` message role alone does not prove human authorship: recognized
  initialization/context payloads are excluded. Tool/action events remain excluded until a
  matching imported timeline representation exists.
- For Claude, retain source-specific filtering of `isMeta`, sidechains, tool results,
  commands, IDE-injected file tags, and synthetic no-response placeholders. Assistant text
  blocks are aggregated per user turn as already required by its transcript semantics.
- Sessions with no visible human-authored user message are not import candidates. Malformed
  or truncated records are skipped without contaminating the remaining ordered projection.

The task index remains the idempotency owner. Import identity remains `(provider,
workspaceIdentity?.trim() || workspacePath, original source session ID)`. Rescans expose
that exact source session as already imported; a retry must neither create another task nor
mix different source sessions. Preview remains local, bounded, escaped plain text and never
exposes raw records, source paths, tool output, or internal context.

Event flow:

```mermaid
flowchart LR
  A[Codex rollout / Claude transcript] --> B[Source-specific parser and visibility filter]
  B --> C[Normalized visible messages plus provenance]
  C --> D[Candidate title and bounded preview]
  C --> E[Imported task history]
  E --> F[Task index provenance and deterministic identity]
```

Acceptance scenarios cover internal-context exclusion, first genuine prompt title, multiple
alternating user/assistant turns, interleaved tool/protocol records, preview/import prefix
parity, no-user sessions, malformed lines, timestamps/provenance, and repeat-import identity
for both providers where their formats support each case.

### Codex logical-session rollout selection (2026-09-26)

`scanCodexImportableSessions` owns the choice of one physical rollout for each Codex
`session_meta.session_id`. The header's physical `id` and `source.subagent`/`thread_source`
describe the rollout, while `session_id` is the logical import identity. A guardian review
rollout that refers to its parent session is not a standalone conversation candidate, even if
its `response_item` records contain user/assistant text. It must not replace the parent or
create a task under the parent's identity. A normal rollout with no visible user prompt is
also ineligible.

For eligible rollouts sharing a logical ID, prefer a physical rollout whose header `id`
matches `session_id`; otherwise prefer the projection with both visible roles and greater
visible-message coverage. Break remaining ties by latest visible-message timestamp, then
header creation time, filesystem mtime, and source path. This is one deterministic choice,
not a transcript merge. The selected path supplies both the bounded preview and the full
imported projection. Import re-scans with the same rule and the task index continues to own
`(provider, workspace key, logical session ID)` idempotency.

Candidate `updatedAt`, activity-range filtering, and sorting use the latest timestamp on a
normalized visible message when available, falling back to the header creation time. File
mtime is only a final selection tie-breaker; copying or rewriting a rollout must not change
its displayed conversation activity. The scanner applies the result limit after grouping and
sorting. No source file is modified.

```mermaid
flowchart LR
  A[Physical rollout files] --> B[Header and visible projection]
  B --> C[Exclude guardian review and no-user rollouts]
  C --> D[Choose one physical path per logical session ID]
  D --> E[Sort by visible activity and apply limit]
  E --> F[Candidate preview]
  D --> G[Import re-scan chooses the same path]
  G --> H[Task index checks logical session ID]
```

Regression coverage includes a multi-turn parent and a newer-mtime guardian review with
the same `session_id`, preview/import parity, one candidate and one task, and activity order
when file mtime disagrees with visible-message time.

### Imported assistant segments remain visible (2026-09-27)

An imported user turn can contain multiple visible assistant messages. They are ordered
segments, not competing answers. Preserve each segment as its own V4 `assistantText` row
within the same product turn; show all imported segments by default. Only the existing
terminal action target receives turn actions. Do not concatenate unrelated messages, infer
source phases, or change preview selection. Ordinary runtime work-history folding is unchanged.

The session store remains the durable owner. Existing text-part `metadata.migrationSource`
(`codex` or `claudeCode`) is the provenance authority, including already imported sessions.
Transcript hydration derives an optional literal `importedHistory: true` on text-start events;
ProductProjection carries it into the validated assistant row. UI work segmentation excludes
those rows from collapsed history and following-work groups. No new database field or repair
write is needed. Absent provenance keeps the existing behavior; no ID-prefix guessing.

```mermaid
sequenceDiagram
  participant P as Source parser
  participant S as Session store (owner)
  participant H as Transcript hydration
  participant V as V4 projection
  participant U as Shared desktop/mobile UI
  P->>S: Ordered importedHistory messages
  S->>S: Distinct message/part IDs, common user parent, monotonic time
  S->>H: Read persisted messages and migrationSource
  H->>V: Ordered text events with importedHistory provenance
  V->>U: Separate assistantText rows, importedHistory=true
  U->>U: Render every imported segment outside collapsed work history
```

Desktop continuous subscriptions and mobile replayable snapshots use the same derived rows;
this change does not affect command admission, owner/lease, stale-run guards, or delivery order.
Repeated hydration must produce the same row order and visibility without changing persistence.

Acceptance: normalized U1/A1-progress/A2-final/U2/B1-progress/B2-final passes through the
real imported-history writer, isolated SQLite, normal readback, hydration, V4 schema and UI
render-unit builder. All six texts remain separately visible in order; preview matches the
first visible exchange. Cover commentary-only turns, missing/equal/out-of-order timestamps,
repeat import, ordinary non-imported folding, and Claude regression. Packaged acceptance:
open a clean imported fixture on desktop and mobile, verify all segments before any expand
click, reload/reconnect, and verify the same order. No real task is mutated by automated tests.
