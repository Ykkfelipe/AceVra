# Fork handoff (custom ZCode fork)

Continuation guide for the next agent. Phase 5 (relay development transport) is
implemented and validated on this machine; read `packages/server/specs/custom-fork-remote.md`
first, then this file for the working loop, evidence and remaining work.

## State

| Phase | Commit               | Scope                                                                                          |
| ----- | -------------------- | ---------------------------------------------------------------------------------------------- |
| 2     | `921842e`            | fork identity isolation                                                                        |
| 3/4   | `7a80c2a`, `ca3b55b` | fork remote foundation + Clerk-authenticated access                                            |
| 5     | `0af265d`            | `/fork/relay/*` attachment transport: browser gets a working workspace/task UI through a relay |

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

1. `OnboardingDialog` hook-order violation → `TypeError: Cannot read properties of
undefined (reading 'length')` inside zustand `useStore` → `useCallback`, caught by
   `ScopedErrorBoundary:onboarding-dialog`. Hook diff shows the sequence drifting at
   position 8 (`useRef` → `useContext`). Skipping the wizard still reaches the shell.
2. `window-controller` channel is absent on `web-remote-replayable`, so
   `useGlobalTaskList` logs `Unknown channel … timed out after 1000ms`.

## Remaining work for the public relay milestone

- Deploy the relay outside the Mac process (today `ZCODE_FORK_RELAY_URL` points at the
  server's own port), with TLS, device-token rotation, and shared presence/attachment
  state instead of in-process maps.
- QR/pairing UX: `POST /fork/api/pairing-token` + `consumePairingToken` exist but no
  client uses them yet.
- Reconnect UX: the web fork path has no reconnection (`onClose: () => {}`), so a Mac or
  relay restart needs a page reload; tickets live 30s and attachments are single-use.
