# Fork handoff (custom ZCode fork)

Continuation guide for the next agent. Phases 2-9 are implemented and validated on this
machine. Read this file first, then the specs it points at:

- `packages/server/specs/custom-fork-remote.md` — relay transport and Phase 6 contract
- `packages/provider/specs/azure-openai.md` — Azure provider, GPT-5 quirks, capability rules
- `packages/provider/specs/command-code.md` — Command Code Provider API
- `packages/services/specs/accounts-and-imports.md` — account bridges and history import
- `packages/services/specs/codex-execution.md` — Codex execution backend (phase 10)

**START HERE for the next task:** see "Immediate next steps" at the end of this file. The
top item is UI, not plumbing: the user explicitly disliked the current Accounts placement.

## State

| Phase | Commit               | Scope                                                                                          |
| ----- | -------------------- | ---------------------------------------------------------------------------------------------- |
| 2     | `921842e`            | fork identity isolation                                                                        |
| 3/4   | `7a80c2a`, `ca3b55b` | fork remote foundation + Clerk-authenticated access                                            |
| 5     | `0af265d`            | `/fork/relay/*` attachment transport: browser gets a working workspace/task UI through a relay |
| 6     | `4652e03`, `ca6154e` | hook-order fix, web reconnect controller, capability-safe accessor, `/fork` mobile shell        |
| 7     | `edd57c9`, `dfcf0e1` | Azure OpenAI provider (config only), gpt-5-mini + gpt-5.4-nano                                  |
| 8     | `5d085c7`            | Command Code provider via its documented Provider API                                          |
| 9     | `86f120a`, `5392bcc` | Accounts & Imports: Codex/Claude account bridges, Settings section, Codex history discovery    |

Tags: `fork-relay-v1`, `fork-azure-agent-v1`, `fork-azure-nano-v1`, `fork-commandcode-v1`,
`fork-accounts-v1`. Each tag's annotation is a full phase report — `git tag -n99 <tag>`.
Branch: `custom-fork/phase-1`. `main` is the untouched upstream snapshot.

Phase 5 verified on this machine (macOS, `mise` pinned Node 24, local relay in the
same server process):

- `/fork` → `POST /fork/api/relay-ticket` → `ws /fork/relay/ws` → relay schedules an
  attachment → Mac opens a dedicated `/fork/relay/device?...&attachmentId=…` socket →
  byte pipe carries RPC both ways. Browser log: 136 frames out / 107 in; first inbound
  frame is the 19-byte `Initialize`. Server log: `browser_bound` → `attachment_paired`
  → `first_mac_to_browser_frame {bytes: 19}` → `first_browser_to_mac_frame {bytes: 42}`.
- Workspace/task UI renders through the relay (task list, project groups, command palette).
- Direct `/fork/ws` fallback still works when the relay ticket is unavailable
  (device reported offline): banner shows `○`, socket is `/fork/ws`, UI still renders.
- Ticket hygiene: missing/replayed/expired/wrong-device tickets all close with 4001
  without pairing; unknown device on `/fork/api/relay-ticket` is 404; fork API routes
  return 401 without a token when `ZCODE_FORK_ALLOW_UNAUTHENTICATED` is off.

## Why the relay needed attachments (root cause of the Phase 4 "device banner only" bug)

`ChannelServer` sends its one-shot `ResponseType.Initialize` **in its constructor**
(`packages/rpc/src/channelServer.ts:29`) and `ChannelClient` refuses to write any
request until it arrives (`State.Uninitialized` → `whenInitialized()` in
`packages/rpc/src/channelClient.ts`). Creating one channel server per _device_
session consumed that frame while no browser was attached, so every browser stayed
uninitialized, sent zero frames, and the page showed only the static device banner
(`shouldOnboard` then times out after 3s). Fix: one device socket **per browser
attachment**, so each browser gets its own channel server, its own
`createZCodeAgentConnectionScope`, and isolation from concurrent browsers.

## Running the dev loop

Server (terminal 1). `must` be restarted after env changes:

```bash
cd /Users/felipemore/Projects/ZCode-Fork
set -a; source .env.local; set +a                       # Clerk keys, gitignored
export ZCODE_FORK_ALLOWED_CLERK_USER_IDS=user_3Jf3aAXOGiPHUSjYDqLcGTmmYRe
export ZCODE_FORK_CLERK_AUTHORIZED_PARTIES=http://localhost:5173
export ZCODE_FORK_RELAY_URL=ws://localhost:3030
export ZCODE_FORK_RELAY_DEVICE_TOKEN=local-relay-development-token
export ZCODE_FORK_RELAY_DEBUG=1
export ZCODE_SERVER_WORKSPACE=/Users/felipemore/Projects/ZCode-Fork
export PORT=3030
mise exec -- pnpm --filter @zcode/server dev
```

Web (terminal 2). `VITE_*` names are injected through vite `define`, so the shell
export is what activates them:

```bash
cd /Users/felipemore/Projects/ZCode-Fork
set -a; source .env.local; set +a
export VITE_CLERK_PUBLISHABLE_KEY="$CLERK_PUBLISHABLE_KEY"
export ZCODE_FORK_RELAY_DEBUG=1
mise exec -- pnpm --filter @zcode/web dev --host localhost
```

Headless/agent verification without a Clerk session (localhost-only bypass; the Mac
must register under the same owner id):

```bash
export ZCODE_FORK_ALLOWED_CLERK_USER_IDS=local-development
export ZCODE_FORK_ALLOW_UNAUTHENTICATED=1
# web shell: do NOT export VITE_CLERK_PUBLISHABLE_KEY → app runs as local-development
```

Diagnostics contract: `ZCODE_FORK_RELAY_DEBUG=1` enables `[fork-relay]` server logs
(redacted, abbreviated ids) and `VITE_ZCODE_FORK_RELAY_DEBUG=1` enables
`[fork-relay-web]` browser logs. Both are inert by default and must stay opt-in.

## Pitfalls (all hit during Phase 5)

- `tsup` watch restarts the server on every save; in-flight probes then see 502 from
  the vite proxy. Stop editing before probing.
- A browser probe must never run while another browser holds an attachment check you
  are reasoning about; reloads create new attachments and the old one detaches.
- Playwright: the repo's `playwright-core@1.59.1` expects `chromium-1217`, which is not
  installed. Use the cached shell instead:
  `PW_EXECUTABLE=~/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell`.
- Vite needs a restart after `vite.config.ts` or env changes, otherwise the `/fork/relay`
  ws proxy route and `VITE_ZCODE_FORK_RELAY_DEBUG` are missing from the running server.

## Known pre-existing defects (not caused by the fork, reproduce on `/ws` too)

1. ~~`OnboardingDialog` hook-order violation~~ — fixed in `4652e03`; pinned by
   `packages/ui/test/onboardingHookOrderRegression.test.ts`. Original symptom:
   hook-order violation → `TypeError: Cannot read properties of
undefined (reading 'length')` inside zustand `useStore` → `useCallback`, caught by
   `ScopedErrorBoundary:onboarding-dialog`. Hook diff shows the sequence drifting at
   position 8 (`useRef` → `useContext`). Skipping the wizard still reaches the shell.
2. ~~`window-controller` channel is absent on `web-remote-replayable`~~ — Phase 6 makes
   the absence an explicit capability instead of a failed RPC probe.
3. ~~Sidebar footer clipped on `/fork`~~ — fixed in `a8a4584`. Shell components below
   `#root` re-declared viewport height (`h-dvh`/`h-screen`), so under the connection banner
   the app row was shorter than its children and `overflow:hidden` sliced off the bottom
   strip containing the sidebar footer. Now only `#root`/`.fork-remote-shell` own `100dvh`;
   everything below fills its container (`h-full min-h-0`), and the footer keeps `shrink-0`
   with `pb-[calc(1rem+env(safe-area-inset-bottom))]`. Pinned by
   `packages/ui/test/shellViewportHeightContract.test.ts`.

## Phase 6 (reconnect + web stabilization)

`packages/web/src/customForkRemoteApp.tsx` now owns the whole `/fork` connection
lifecycle; `main.tsx` just delegates the route to it. States:
`authentication-required` / `relay-unavailable` / `offline` / `connecting` / `online` /
`reconnecting` / `restored`.

Invariants, which the drills below check directly:

- Every attempt mints a **fresh single-use relay ticket** and opens a **fresh browser
  attachment**. No ticket and no service accessor is ever reused. This is forced by the
  Phase 5 root cause: one `ChannelServer` (and therefore one `Initialize`) per attachment.
- A monotonic `generationRef` fences stale attempts, so a socket that closes after its
  generation was superseded cannot schedule a retry or overwrite newer state.
- Retries use bounded backoff `500ms -> 1s -> 2s -> 4s -> 8s -> 15s` (capped), reset to 0
  on a successful connect. `/fork/ws` remains the per-attempt fallback when the relay
  ticket is unavailable.
- 401 from `/fork/api/ws-ticket` or `/fork/api/device` goes to `authentication-required`
  and **stops** retrying; it never spins against a dead Clerk session.
- The `windowController` capability is now explicit. `RemoteServiceAccess` takes a
  capability set, so a web replayable attachment no longer builds a proxy for a channel
  the host deliberately does not expose. This closes pre-existing defect 2 below:
  `useGlobalTaskList` ends hydration instead of logging an unknown-channel timeout.

### Validating reconnect without disturbing a running dev server

Do **not** test reconnect against the dev server on `:3030` — killing it to simulate a Mac
restart kills the loop you are working in. Run a second, fully isolated instance instead.
The relay keeps attachment/presence state in in-process maps, so a second process on
another port is a genuinely independent relay:

```bash
cd /Users/felipemore/Projects/ZCode-Fork/packages/server
PORT=3031 \
ZCODE_FORK_RELAY_URL=ws://localhost:3031 \
ZCODE_FORK_RELAY_DEVICE_TOKEN=isolated-relay-validation-token \
ZCODE_FORK_ALLOWED_CLERK_USER_IDS=local-development \
ZCODE_FORK_ALLOW_UNAUTHENTICATED=1 \
ZCODE_FORK_RELAY_DEBUG=1 \
ZCODE_FORK_DEVICE_NAME=isolated-test-mac \
ZCODE_SERVER_WORKSPACE=/tmp/iso-ws \
mise exec -- node dist/entry-http.js
```

It must run from `packages/server` — the bundle resolves its externals through the repo's
`node_modules`, so a copy outside the tree dies on `ERR_MODULE_NOT_FOUND: yaml`. Node 24
has a global `WebSocket`, so a drill script needs no `ws` dependency. Both drills below
passed on this machine against that instance (`2026-09-22`):

Transport contract, 8/8:

- fresh ticket opens an attachment and receives the 19-byte `Initialize`
- a replayed ticket is refused with 4001 without pairing
- a reconnect mints a distinct ticket and gets a fresh `Initialize`
- a concurrent second browser gets its own attachment, and the first stays open
- `relay-ticket` for an unknown device is 404

Mac-restart recovery, 6/6:

- `SIGKILL` on the Mac closes the live browser socket with **1006 in 9ms**
- presence and ticket mint both fail closed with `ECONNREFUSED` — they never hang
- after restart, the first backoff tick reconnects and receives a fresh `Initialize`
- the device id is stable across the restart, so the UI does not see a new Mac

### Browser-level end-to-end (verified)

Run against an isolated stack so the dev server on `:3030` is never involved: the isolated
relay on `:3031` plus a static host that serves `packages/web/dist` and proxies only
`/api`, `/fork/api`, `/fork/ws` and `/fork/relay` upstream. `/fork/` itself must fall back
to `index.html` — proxying the whole `/fork` prefix returns 404, because the server only
owns the API and socket routes under it. This avoids touching `vite.config.ts`, whose
proxy targets are hardcoded to `:3030`.

One minimal request (`Reply exactly with: RELAY_E2E_OK`, GLM-5.3, effort Low, scratch
workspace) returned `RELAY_E2E_OK` in 4s. Chain confirmed: browser composer -> relay ->
Mac agent -> model request -> streamed response -> browser UI. Cost: 1% of the 5-hour
window; weekly and MCP meters unchanged.

Responsive pass at 375x812, measured through `getBoundingClientRect` rather than
screenshots: navigation fills the viewport (375), selecting a task gives a full-width
conversation with navigation unmounted, the composer computes to exactly 16px (iOS
input-safe, no zoom-on-focus), and the model, effort and usage popovers all sit inside the
viewport (174-367, 174-302, 28-348) with `scrollWidth === innerWidth` throughout.

### Pitfall: the browser drill's Enter key

A drill appeared to show Enter-to-send broken in the `/fork` composer. It was **not** a
product bug. The automation sent the key name `"Return"`, which produces no keydown in the
page at all — a window-capture probe recorded zero events for `"Return"` and trusted
`key: "Enter"` events for `"Enter"` and `"shift+Enter"`. Use `"Enter"`.

Enter semantics are correct and now pinned by
`packages/ui/test/composerEnterSubmitSemantics.test.ts`: `composerSend` defaults to
`["Enter"]`, an absent or `{}` override resolves to defaults, and only a deliberate rebind
(explicit `[]`, or `["Ctrl+Enter"]`) releases bare Enter to newline. That file needs
`TSX_TSCONFIG_PATH=packages/ui/tsconfig.json` because the shortcut kernel imports through
the `@/` Vite alias.

To probe Enter without spending model quota, register a window-capture `keydown` listener
that calls `preventDefault()` and `stopImmediatePropagation()` for `Enter`. Capture at
window runs before the event can reach Lexical's editor listener, so the keystroke is
observable but can never submit.

### Recovery note

The Phase 6 slice was written, then lost before it was committed when the working tree was
reset to `main`. It was recovered verbatim from the Codex thread history
(`~/.codex/thread_history_1.sqlite`, table `thread_items`, `item_type = 'fileChange'`;
each row's `changes[].diff` is a unified hunk, and for `kind = 'add'` the field holds the
whole file). Replaying them in `rollout_ordinal` order reproduced the reported
12 files / +583 / -16 exactly. **Commit each slice before switching branches.**

## Remaining work for the public relay milestone

- Deploy the relay outside the Mac process (today `ZCODE_FORK_RELAY_URL` points at the
  server's own port), with TLS, device-token rotation, and shared presence/attachment
  state instead of in-process maps.
- QR/pairing UX: `POST /fork/api/pairing-token` + `consumePairingToken` exist but no
  client uses them yet.
- ~~Reconnect UX~~ — done in Phase 6; see above.

## Providers (phases 7-8)

All three are **configuration only**. No adapter was written and no runtime code was changed
to support any of them, which is the point the phases were proving.

| Provider id | API type | Base URL | Models |
| --- | --- | --- | --- |
| Z.ai (builtin) | — | — | GLM-5.3, GLM-5.3-Flash |
| `azure-openai` | `openai-chat-completions` | `https://<resource>.services.ai.azure.com/openai/v1` | gpt-5-mini, gpt-5.4-nano |
| `command-code` | `openai-chat-completions` | `https://api.commandcode.ai/provider/v1` | 59 (GOAT plan) |

Config lives in `~/.zcode/v2/provider_config.json`, mode 0600, **outside the repo**. The
server does not hot-reload it: restart after editing.

### Things that will bite you

- **Azure endpoint shape.** The user's endpoint is an AI Foundry *project* URL
  (`.../api/projects/<name>`). The OpenAI-compatible surface lives on the **resource root**,
  so strip the project path. The legacy `/openai/deployments/{d}/...?api-version=` shape
  would need a real adapter; the v1 surface does not.
- **GPT-5 parameter names.** GPT-5 models reject `max_tokens` and require
  `max_completion_tokens`. Option maps are restricted-CEL JSON **merge patches**, so this is
  fixed in config: `{"max_completion_tokens": maxOutputTokens, "max_tokens": null}` — the
  null deletes the offending key. Non-GPT-5 models use plain `max_tokens`.
- **`reasoningLevel` cannot be empty.** The schema requires at least one value. When a
  provider publishes no reasoning ladder, declare one nominal value with map `"{}"` so the
  patch is empty and `reasoning_effort` is never sent. Do not invent a ladder.
- **Command Code plan gating.** GOAT does not include every catalogue model. 9 of the 68
  chat-completions models need Pro/Provider, and **all 8 Claude models are Pro/Provider**, so
  the `anthropic-messages` provider entry was removed. `supported_endpoints` in
  `GET /provider/v1/models` tells you which models can use which api type.
- **"GOAT" is a plan, not a model.** No model by that name exists.

## Accounts & Imports (phase 9)

Two deliberately separate concerns: **account connection** and **history import**. History
import works whether or not the account bridge is connected, and there is a test asserting it.

### Code map

| File | Role |
| --- | --- |
| `packages/shared/src/accountBridge.ts` | the sanitized wire contract — the security boundary |
| `packages/services/src/accounts/codexAppServerBridge.ts` | `codex app-server` stdio JSON-RPC process manager |
| `packages/services/src/accounts/accountBridgeService.ts` | Codex + Claude adapters |
| `packages/services/src/accounts/commandCodeStatusAdapter.ts` | Command Code `status --json` parsing |
| `packages/services/src/accounts/codexHistoryImportRepo.ts` | Codex rollout discovery |
| `packages/services/src/accounts/accountsServiceImpl.ts` | `IAccountsService` host implementation |
| `packages/ui/src/settings/AccountsAndImportsSection.tsx` | Settings UI (placement is provisional) |

Registered in `createLocalServices` (`packages/services/src/node.ts`) and exposed on the
client accessor (`packages/client/src/remoteServiceAccess.ts`), channel `"accounts"`.

### Codex

The bundled CLI is at `/Applications/ChatGPT.app/Contents/Resources/codex` and is **not on
PATH**. Version 0.155.0-alpha.9.2.

The protocol is self-describing — never guess it:

```bash
/Applications/ChatGPT.app/Contents/Resources/codex app-server generate-json-schema --out <dir>
/Applications/ChatGPT.app/Contents/Resources/codex app-server generate-ts --out <dir>
```

Transport is **newline-delimited JSON-RPC over stdio** (not LSP Content-Length framing).
`initialize` returns `{userAgent, codexHome, platformFamily, platformOs}`.

Methods used: `account/read`, `account/login/start`, `account/login/cancel`, `account/logout`
(never called), `account/rateLimits/read`, `account/usage/read`. The completion notification
is **`account/login/completed`** — an earlier guess of `account/loginCompleted` was wrong and
silently never fired, so take names from `ServerNotification.json`.

`account/read` returns `{type:"chatgpt", email, planType}`. **No token field exists**, which
is what makes the boundary structural rather than a matter of discipline.

`account/login/start {type:"chatgpt"}` returns `{authUrl, loginId}` **even when already
signed in**, so the signed-in path exercises the full OAuth round trip and you do not need to
sign the user out to test it. `account/login/cancel` cleanly aborts and leaves the account
signed in.

### Claude Code

Version 2.1.202 at `~/.local/bin/claude`. Use only `claude auth status --json`,
`claude auth login --claudeai`, and `claude auth logout` (not used). **Do not use
`setup-token`** — it mints a long-lived credential ZCode would then hold.

`auth status --json` **exits non-zero while signed out but still prints valid JSON**, so a
non-zero exit must not be treated as failure when stdout parses. `auth login` works
headlessly: it opens a browser and prints a fallback URL.

### Command Code

`commandcode status --json` is the documented automation surface and returns
`{authenticated, version, user, model, context_window}`. `whoami` ignores `--json`. The
`/usage` slash command holds plan/credits/usage but **refuses to run headlessly** and points
at a web view, so plan and quota are reported UNAVAILABLE rather than inferred. Parsing is
isolated in a tested adapter so CLI drift fails loudly.

### Security boundary — do not weaken this

- Only `AccountBridge*` shapes cross the relay. `AccountBridgeConnectResult` has **no
  `authUrl` field** by design: Codex's OAuth callback targets localhost on the Mac, so the
  host opens the URL and it never reaches a remote browser. Do not add a QR code for it.
- **"Disconnect from harness" must never log the source app out.** It calls neither
  `account/logout` nor `claude auth logout`. A test asserts the source login survives a
  disconnect/reconnect cycle. This is why the bridge has a non-terminal `stop()` separate
  from the terminal `dispose()` — an early version used `dispose()` and made the bridge
  unrestartable.
- Error strings are scrubbed of URLs, paths and long opaque blobs before they can reach a
  client.
- How the boundary was actually verified: secret fingerprints computed host-side, then 380
  secret-shaped DOM strings hashed **in the page** and compared, so no secret value entered
  the browser. Repeat that technique rather than eyeballing.

### Credentials

| Secret | Location |
| --- | --- |
| Azure key | `.env.azure.local` (gitignored) + `provider_config.json` |
| Command Code key | `provider_config.json` (user replaced the CLI-issued one with their own) |
| Codex OAuth tokens | `~/.codex/auth.json` — **owned and refreshed by Codex, never read** |
| Claude credentials | Claude's own store — never read |

Azure rotation lesson: propagation is **not instant**. After
`az cognitiveservices account keys regenerate --key-name key1` the old key still returned 200
for roughly 20 seconds before 401. Confirm a rotation by polling, not one check.

## Provider-managed effort (2026-09-22)

A user reported seeing "Low" on a model whose ladder is a single `"default"`. Fix shipped in
the working tree (not committed): the thought-level control is now **hidden** for models
whose declared ladder is exactly `["default"]`, i.e. provider-managed effort, and `"default"`
got a localized word ("Default" / "默认") for the two text surfaces that still print a raw
level (subagent labels, `list_models` rows).

What changed:

- `packages/ui/src/lib/modelThoughtOption.ts` — new exported predicate
  `isProviderManagedThoughtOption` (exactly one option, value exactly `"default"`). The
  resolver is untouched.
- Hide sites, all reading that one predicate: `V4ComposerToolbar.tsx` (composer chip),
  `OffPeakEditView.tsx`, `AutomationEditView.tsx`, `WorkflowRunSettingsPopover.tsx` (nulls the
  option it passes to the fields component) and `SubagentReasoningField.tsx` (renders `null`
  while keeping state kind `"supported"`).
- `chat-input-toolbar/thoughtLevelOptions.ts` + both locales — the `default` label.
- New tests: `packages/ui/test/providerManagedThoughtOption.test.ts`,
  `packages/model-option-map/test/optionMaps.test.ts`,
  `packages/provider/test/providerManagedReasoningLevel.test.ts`. The ui test registers
  `packages/ui/test/uiAssetStubLoader.mjs` because the label table imports `display.tsx`,
  which reaches real `.svg` files that plain `node --import tsx` cannot load.

**The two regression traps — do not "simplify" this by returning `null` from the resolver.**
Both were verified before choosing the presentation-layer fix:

1. `OffPeakEditView.tsx` derives `effectiveThoughtLevel` from `thoughtLevelOption?.currentValue`
   and `canSubmit` requires it. A `null` option permanently disables create/save for
   single-`"default"` models — today it works because the option resolves with
   `currentValue: "default"`.
2. `SubagentsSection.tsx`: a persisted subagent override with
   `options.reasoningLevel === "default"` becomes state kind `"unsupported"` once the option is
   `null`; `isSubagentThoughtLevelAvailable()` returns false for `"unsupported"`, so
   `thoughtLevelInvalid` blocks `canSave` and shows a spurious "select a supported reasoning
   level" error.

Config was **not** touched: `config/provider/zcode-builtin.json` and the personal
`~/.zcode/v2/provider_config.json` are unchanged (mtime still `Sep 22 03:50`, 76957 bytes).
A throwaway read-only audit resolved every personal rule through the real resolver and
compiled every declared value: **183/183 assertions passed, 0 violations** — 61
`providerModelRules`, 0 `manualProviderModelRules`, 60 `["default"]` entries each emitting
zero reasoning paths with their max-output map intact; `gpt-5-mini` still emits
`reasoning_effort: low` plus the `max_completion_tokens`/`max_tokens` rewrite; the builtin
GLM-5.3/5.3-Flash ladder still emits `output_config.effort`.

Unverified: the original "Low" sighting itself. The composer cannot paint "Low" for a model
whose projected ladder is `["default"]` — the label comes from the option entries, and a
one-entry `"default"` list renders "default"/placeholder. Strongest supported explanation:
either the model was `gpt-5-mini` (genuinely `["low"]`, legitimately a fixed "Low" chip), or
the painter saw a stale ladder. A reproduction was not obtained.

## Testing

```bash
mise exec -- node --import tsx --test \
  packages/services/test/accountBridgeSecurityBoundary.test.ts \
  packages/services/test/commandCodeStatusAdapter.test.ts \
  packages/client/test/webReplayableCapabilities.test.ts

# these two need the ui tsconfig because the shortcut kernel imports through the @/ alias
TSX_TSCONFIG_PATH=packages/ui/tsconfig.json mise exec -- node --import tsx --test \
  packages/ui/test/onboardingHookOrderRegression.test.ts \
  packages/ui/test/composerEnterSubmitSemantics.test.ts \
  packages/ui/test/providerManagedThoughtOption.test.ts

mise exec -- node --import tsx --test \
  packages/model-option-map/test/optionMaps.test.ts \
  packages/provider/test/providerManagedReasoningLevel.test.ts
```

Full gate before committing: `pnpm run typecheck`, `pnpm run lint` (**baseline is 70
warnings, 0 errors — do not regress it**), `pnpm run architecture:check -- --changed`,
`pnpm --filter @zcode/web build`, `git diff --check`.

Tests that need the local Codex/Claude clients skip cleanly when absent.

## Immediate next steps

1. ~~**Relocate the Accounts UI into the Model settings split panel.**~~ **Done.** The user
   disliked the standalone section of plain cards, so Accounts & Imports now lives in the
   Model settings split panel: `ModelProviderNavItem`
   (`packages/ui/src/settings/model-provider-section/constants.ts`) gained an `account`
   variant, rendered by the static (non-sortable) list in `Navigation.tsx` and dispatched in
   `Detail.tsx` to the existing `AccountsAndImportsSection` (Codex card + scan, Claude Code
   card, Command Code card, Claude history migration — no second accounts UI was built).
   `connectionSelectionMatchesNavigationItem` excludes the account node and default selection
   never lands on it. The standalone `"accounts"` entry is gone from
   `settingsPageConfig.ts` / `SettingsPage.tsx`; legacy `accounts` ids migrate to
   `modelProvider` in `lib/settingsNavigation.ts` (plugins precedent). i18n key:
   `settings.accounts.navGroup`. Spec refreshed in
   `packages/services/specs/accounts-and-imports.md`.
2. **Make Codex history actually importable.** `scanCodexImportableSessions` only discovers
   candidates; nothing writes them into tasks yet. Mirror
   `importClaudeNativeSessions`, reusing `ZCodeImportSessionsResult` with `provider: "codex"`
   (the union already accepts it). Keep it independent of the account bridge, and keep
   selection explicit — do not bulk-import all rollouts.
3. **Claude migration reports "desktop only" over the relay.** The existing
   `MigrationSection` gates itself to desktop, so Claude history import is not usable from
   `/fork`. Decide whether to lift that gate for the relay path.
4. **Usage dashboard is partial by evidence, not by omission.** Codex supplies
   `ordinaryUsageAllowed`; Command Code supplies nothing headless; Azure has no trustworthy
   quota source; Z.ai coding-plan usage already exists in `UsageStatsSection` and was not
   merged in. Do not invent percentages.
5. **Agent execution has not been started** for Codex or Claude, by instruction. Phase 9 was
   account/auth/status/history/usage only.

## Codex execution backend (phase 10, 2026-09-22)

Spec: `packages/services/specs/codex-execution.md`. Vertical slice implemented: harness
task → Codex thread (`thread/start`) → streamed Codex notifications projected into the v4
conversation contract → shared task UI, with approvals surfaced as pendingInteractions.
Codex does NOT go through the ZCode model adapter or the zcode-cli runtime.

- Code map: `packages/services/src/codex/` (contract/domain/app), channel
  `codex-execution`, shared types `packages/shared/src/codex-execution.ts`, renderer
  routing transport `packages/ui/src/v4/codexConversationTransport.ts` +
  `backendRoutingConversationTransport.ts`, composer backend selector in
  `ConversationComposer`/`V4ComposerBackendControls`.
- The protocol shapes are typed from binary strings of the installed Codex; payloads are
  **not yet E2E-verified**. The first real inference run is blocked on explicit approval —
  the E2E checklist in the spec lists every method/event to confirm.
- Regression trap: snapshot sections the slice does not model must stay empty/null; the
  first frame after subscribe must carry deliveryKind "initial" or the projection store
  treats it as a gap and enters recovery; deltas frames must carry
  `(fromSeq, toSeq] = (prevSeq, commitSeq]` or streaming degrades into a resync storm
  (the store only applies deltas when `frame.fromSeq === current.seq`).
- Independent review pass done (review-agent): all 11 findings fixed, including the P0
  frame-sequence contract, atomic runtime rebuild after bridge restart, failed-ack for
  rejected turn/start, approval deny-on-unroutable, and the respond() generation fence.
- E2E validated 2026-09-22 (text-only + file create/read) with the real ChatGPT Plus
  login. Protocol shapes are now OBSERVED, not assumed — see "Observed App Server
  shapes" in the spec. Gotchas proven live: `requiresOpenaiAuth:true` is returned even
  when signed in (gate on `account` presence); thread id is nested at
  `thread/start → result.thread.id`; `thread/resume` returns `{}`; items live under
  `thread/items/list → data[].item`; default threads run `approvalPolicy:"never"` +
  full-access sandbox so no approval requests fire (approval round-trip still needs a
  drill with a restrictive policy). Pre-E2E checkpoint: `fork-codex-exec-v1`.

## Environment note

The dev stack is started from the two commands in "Running the dev loop". When those are
launched from an agent session they are children of that session and die with it — which has
already happened once. For a durable setup run them in your own terminals.
