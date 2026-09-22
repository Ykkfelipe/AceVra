# Accounts & Imports (Phase 9)

Status: **implemented (phase 9, see HANDOFF.md).** Codex/Claude account bridges,
sanitized status, and Claude/Codex history discovery are live. Settings placement:
the `account` variant of `ModelProviderNavItem`
(`packages/ui/src/settings/model-provider-section/constants.ts`) renders
`AccountsAndImportsSection` in the Model settings split-panel detail pane
(`model-provider-section/Detail.tsx`); the standalone top-level "accounts"
Settings section was removed and its old id migrates to `modelProvider`.

Two *distinct* features, deliberately not conflated:

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

| Method | Purpose |
| --- | --- |
| `account/login/start` | begin login |
| `account/login/cancel` | cancel an in-flight login |
| `account/logout` | disconnect |
| `account/read` | sanitized account info |
| `account/rateLimits/read` | plan limits / usage allowance |
| `account/usage/read` | token usage summary |

Transport: `codex app-server --listen` accepts `stdio://` (default), `unix://PATH` or
`ws://IP:PORT`. `codex app-server daemon` manages a shared local daemon and
`codex app-server proxy` bridges stdio to its control socket.

### The flow

`account/login/start` takes `LoginAccountParams`, whose variants include
`{ type: "chatgpt", … }`, `{ type: "apiKey", apiKey }`, plus Bedrock and device-code forms.
For subscription sign-in we send `{ type: "chatgpt" }` and get back:

```jsonc
{ "type": "chatgpt",
  "authUrl": "…",   // schema description: "URL the client should open in a browser
                    //  to initiate the OAuth flow."
  "loginId": "…" }
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

## Claude Code — account connection via the CLI auth surface

Installed: `claude 2.1.202` at `~/.local/bin/claude`. Officially supported commands:

| Command | Purpose |
| --- | --- |
| `claude auth login [--claudeai\|--console\|--sso] [--email <e>]` | browser sign-in; `--claudeai` (subscription) is the default |
| `claude auth logout` | disconnect |
| `claude auth status --json` | sanitized status |
| `claude setup-token` | long-lived token for programmatic use (subscription required) |

`claude auth status --json` on this machine returns:

```json
{ "loggedIn": false, "authMethod": "none", "apiProvider": "firstParty" }
```

Again **no token is exposed** — only `loggedIn`, `authMethod`, `apiProvider`. Claude Code
owns its credentials (keychain / its own store) and ZCode reads status only.

Note: the CLI is currently signed out here even though the desktop app is in use, so the
Accounts UI must render a genuine disconnected state rather than assume connection.

`setup-token` is deliberately **not** the recommended path: it mints a long-lived token that
ZCode would then hold, which is the credential-custody outcome we are avoiding. Prefer
`auth login` + `auth status`.

### Asymmetry worth designing around

Codex offers a structured JSON-RPC API with push notifications. Claude Code offers CLI
commands with JSON output and no event stream. The reusable service should therefore define
one interface and two adapters, with Claude's status obtained by polling on demand (on
Settings open, and after an explicit connect/disconnect) rather than by subscription.

## History import — separate feature

Claude (already built): `importClaudeNativeSessions`
(`packages/services/src/session/claude-native/claudeNativeSessionImportService.ts`) copies
Claude's `.jsonl` transcripts into the workspace as ZCode tasks. It is already shared by
onboarding (`OnboardingDialog.tsx:61`) and Settings (`MigrationSection.tsx:61`, embedded by
`AccountsAndImportsSection`, which is rendered from the Model settings split-panel
`account` variant in `model-provider-section/Detail.tsx`) through the
`useClaudeSessionMigration` hook, so it is already re-runnable after onboarding. Per
"do not duplicate it", this stays as is; only its presentation moved with the section.

Codex (to build): the equivalent local store is `~/.codex/sessions/{year}/…` plus
`~/.codex/thread_history_1.sqlite` (~134 MB; tables `thread_items`, `thread_turns`). This is
the same store used successfully in this project to recover lost work, so its shape is known.
It should reuse `ZCodeImportSessionsResult` with `provider: "codex"` alongside the existing
`provider: "claude"`.

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
- Settings section "Accounts & Imports": Import from Claude Code, Import from Codex,
  connection/import status, re-import / reconnect, disconnect from this harness. Connect and
  import both require an explicit click; nothing runs automatically.

## Open questions before implementation

1. **Remote browser flow.** The relay is used from a phone. `authUrl` must be opened in a
   browser that can complete the OAuth and hand back to the *local* Codex daemon. Opening it
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
