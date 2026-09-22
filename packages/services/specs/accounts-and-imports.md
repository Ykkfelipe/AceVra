# Accounts & Imports — investigation (Phase 9)

Status: **investigation only. Nothing implemented.** Two findings below change the shape of
the requested work, so they need a decision before code is written.

## Finding 1 — the Claude Code import is a SESSION import, not an account import

The capability exposed during onboarding is
`importClaudeNativeSessions` (`packages/services/src/session/claude-native/claudeNativeSessionImportService.ts`).
It takes `sessionIds`, resolves candidates through `claudeNativeSessionImportRepo`, copies
Claude's own session `.jsonl` transcripts into the workspace and persists them as ZCode
tasks. Its result type is `ZCodeImportSessionsResult` with `imported` / `skipped` /
`failed`, and skip reasons such as `session_not_found_or_workspace_mismatch`.

**No credential, token, account or login is involved anywhere in that path.** It reads
conversation history.

Consequence: most of the stated security requirements — never send raw source credentials
through the relay, never display tokens, preserve the source app's login — have nothing to
act on for Claude, because no credentials are read. The requirements that *do* apply are
the ordinary ones: transcripts are user data, the import must stay an explicit user action,
and the source files must not be mutated (the current service only copies).

Worth noting: this machine has **no `~/.claude/.credentials.json`**. Claude Code is not
storing a reusable credential on disk here at all.

## Finding 2 — the reusable service and the Settings entry point already exist

The requested refactor ("extract into a reusable service and expose it from Settings, have
onboarding call the same service") is **already the state of the code**:

| Caller | File |
| --- | --- |
| Onboarding | `packages/ui/src/onboarding/OnboardingDialog.tsx:61` |
| Settings | `packages/ui/src/settings/MigrationSection.tsx:61` |
| Settings wiring | `packages/ui/src/SettingsPage.tsx:76, 1880` |

Both call the **same hook**, `useClaudeSessionMigration`
(`packages/ui/src/hooks/useClaudeSessionMigration.ts`), which calls the same task-service
method, which calls the same `importClaudeNativeSessions`. Onboarding additionally layers
`useOnboardingMigration` for its own selection defaults, but the import capability itself is
already shared, already re-runnable after onboarding, and already reachable from Settings.

Given the instruction "Do not duplicate it", the correct action here is to **not** rebuild
this. Any work should be additive: naming/grouping the Settings section, and adding status /
re-import / disconnect affordances if those are genuinely wanted.

## Finding 3 — Codex authenticates with ChatGPT OAuth, not an API key

`~/.codex/auth.json` on the installed client contains:

```
auth_mode      : "chatgpt"
OPENAI_API_KEY : null
tokens         : { id_token (JWT), access_token (JWT), refresh_token, account_id (uuid) }
last_refresh   : 2026-09-18T05:03:46Z
```

Both `id_token` and `access_token` are three-segment JWTs. There is **no API key to reuse**.

This matters for whether an import can copy credentials or use a handoff:

- **Copying is not appropriate.** These are ChatGPT subscription OAuth tokens issued to the
  Codex client. Reusing them from a different application means presenting another client's
  credentials to the provider — undocumented, near-certainly against OpenAI's terms, and
  precisely the "undocumented token format" that must not be hardcoded.
- **There is no documented third-party handoff.** Codex exposes no public token-exchange or
  delegation flow for another harness to obtain its own credential.
- **Refresh would conflict.** `refresh_token` plus `last_refresh` implies rotation. Two
  processes refreshing the same grant can invalidate each other, which would break the
  user's Codex login — violating "preserve the source application's credentials".

**Recommendation: do not implement Codex credential import.** If ZCode should talk to
OpenAI, the supported route is a normal API key or an Azure deployment, which the fork
already supports (see `azure-openai.md`).

## What the Codex equivalent *should* be

The true analogue of the Claude import is Codex **history**, which is stored locally:

- `~/.codex/sessions/{year}/…` — session transcripts
- `~/.codex/thread_history_1.sqlite` (~134 MB) — `thread_items` / `thread_turns`, the store
  already used successfully in this project to recover lost edits

That is user data, needs no credentials, requires no token handling, and mirrors the Claude
path one-to-one. It can reuse the same service shape (`ZCodeImportSessionsResult`,
`provider: "codex"` alongside the existing `provider: "claude"`).

## If credential-backed accounts are still wanted

Reuse `createCredentialService` (`packages/services/src/credential/credentialService.ts`)
rather than adding a second secret store, and keep secrets Mac-host-only: the relay must
carry only sanitized metadata (account label, connection state, last-import time, counts).
The existing provider path already demonstrates this shape — `provider_config.json` lives at
mode 0600 outside the repo and no key is ever rendered.

## Open decision

Before implementing, confirm which of these is wanted:

1. Session/history import for Codex, mirroring Claude (recommended, no credentials).
2. Cosmetic regrouping of the existing Claude migration UI under an "Accounts & Imports"
   heading with status / re-import affordances.
3. Something genuinely credential-backed, which for OpenAI should mean an API key the user
   supplies, not Codex's ChatGPT tokens.
