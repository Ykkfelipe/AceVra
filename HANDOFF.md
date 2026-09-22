# Fork handoff (custom ZCode fork)

Continuation guide for the next agent. Phase 6 (web stabilization + reconnect) is
implemented and validated on this machine; read `packages/server/specs/custom-fork-remote.md`
first, then this file for the working loop, evidence and remaining work.

## State

| Phase | Commit               | Scope                                                                                          |
| ----- | -------------------- | ---------------------------------------------------------------------------------------------- |
| 2     | `921842e`            | fork identity isolation                                                                        |
| 3/4   | `7a80c2a`, `ca3b55b` | fork remote foundation + Clerk-authenticated access                                            |
| 5     | `0af265d`            | `/fork/relay/*` attachment transport: browser gets a working workspace/task UI through a relay |
| 6     | `4652e03`, `ca6154e` | hook-order fix, web reconnect controller, capability-safe accessor, `/fork` mobile shell        |

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
