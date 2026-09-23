# Custom fork remote boundary

The fork remote experience is intentionally a thin boundary around the existing
web shell and replayable RPC transport. `/fork` serves the same built Web SPA;
`/fork/ws` exposes the existing `web-remote-replayable` channel server. No new
provider or agent-runtime path is introduced.

`@zcode/shared` owns the product defaults (`AceVra Dev`, `/fork`, `/fork/ws`,
telemetry disabled). Desktop, server, and Web consume that contract rather than
duplicating identity strings. The `zcode://` OAuth callback remains an intentional
compatibility identifier and is not renamed with the product label.

## Clerk boundary

The route verifies a Clerk session JWT sent as `Authorization: Bearer` using
`@clerk/backend` `verifyToken` (`customForkClerkAuth.ts`). A verified user must
also appear in the `ZCODE_FORK_ALLOWED_CLERK_USER_IDS` allowlist: missing or
invalid tokens get 401, verified-but-not-allowlisted users get 403. Replacing the
verification call stays isolated to `customForkClerkAuth.ts`. With no token the
route stays closed unless `ZCODE_FORK_ALLOW_UNAUTHENTICATED=1` is explicitly set,
which only trusts `localhost`/`127.0.0.1`/`::1` requests (`isCustomForkLocalBypass`).
No Clerk secret or session token belongs in the repository.

## Local relay development transport

`/fork/relay/*` puts the browser and the Mac on opposite ends of a relay so the
browser path under test is byte-identical to a deployed relay: the browser never
reaches the Mac directly, it only exchanges the same RPC frames through
forwarding sockets. Presence, pairing, and attachment scheduling live in
`customForkRelay.ts`; the relay keeps no task, session, or snapshot state.

Three sockets participate:

| Socket                                     | Peer                 | Auth                    | Payload             |
| ------------------------------------------ | -------------------- | ----------------------- | ------------------- |
| `GET /fork/relay/device`                   | Mac presence/control | `x-zcode-device-token`  | JSON control frames |
| `GET /fork/relay/device?...&attachmentId=` | Mac attachment       | `x-zcode-device-token`  | raw RPC frames      |
| `GET /fork/relay/ws?deviceId=&ticket=`     | Browser              | single-use relay ticket | raw RPC frames      |

```text
browser              relay (customForkRelay/http)          mac presence      mac attachment
  |  POST /fork/api/relay-ticket (Clerk + device online)          |                |
  |---------------------------------------------------------->    |                |
  |  ws /fork/relay/ws?deviceId&ticket                            |                |
  |---------------------------------------------------------->    |                |
  |                        create attachment, send {type:attach}  |                |
  |                                                          ---> |                |
  |                                                               |  ws /fork/relay/device?attachmentId
  |                                                               |-------------> |
  |                        pair + byte pipe                       |  setupChannelServer + Initialize
  |  <============================= RPC frames ==================================> |
  |                        {type:detach} on browser close         |  close + dispose scope
```

### Why one device socket per browser attachment

`ChannelServer` emits its one-shot `ResponseType.Initialize` in the constructor
(`packages/rpc/src/channelServer.ts`) and `ChannelClient` refuses to write any
request before it arrives (`packages/rpc/src/channelClient.ts`). A channel server
created once per device session consumes that Initialize while no browser is
attached, so every later browser stays `Uninitialized`, sends no frame, and hangs
with an empty shell. One attachment per device socket gives each browser its own
Initialize frame, its own `createZCodeAgentConnectionScope`, and isolation from
concurrent browsers.

### Rejections and lifecycle

- The browser path requires a valid single-use relay ticket bound to the same
  `deviceId`; missing, replayed, mismatched, or expired tickets close with 4001,
  and the device must be online (4004 otherwise).
- The relay only schedules attachments for an online device; the Mac opening an
  unknown or already-paired `attachmentId` closes with 4004.
- If the Mac does not attach within the setup deadline (10s) the browser closes
  with 4008 so the client fails fast instead of hanging.
- Browser close removes both pipe listeners, closes the attachment socket, and
  sends `{type:detach}` so the Mac disposes the channel server and connection
  scope. Device offline closes that device's active attachments and browsers.
- Direct `/fork/ws` stays available as a fallback when `/fork/api/relay-ticket`
  is unavailable or the device is offline.

Official routes, providers, relay behavior, and agent behavior are unchanged.

## Phase 6 Web stabilization contract

The `/fork` browser shell owns only connection lifecycle and presentation state. It does not own
workspace, task, session, or conversation state. Those remain projections of the Mac attachment's
existing services. The shell state is one of:

- `authentication-required`: Clerk is configured and there is no current session/token.
- `relay-unavailable`: the fork API cannot be reached or rejects bootstrap for a reason other than
  authentication.
- `offline`: the API is reachable but the registered Mac is offline.
- `connecting`: the Mac is online and a fresh single-use relay ticket is being exchanged.
- `online`: the replayable RPC socket is initialized and the shared application shell is mounted.
- `reconnecting`: a previously-online socket closed and automatic recovery is in progress.
- `restored`: the first successful connection after `reconnecting`; it is announced briefly before
  returning to `online`.

Mutable connection state has one owner: the `/fork` Web connection controller. Presence polling and
socket close events send transitions to that owner; React UI reads the resulting state. A reconnect
never reuses a relay ticket or RPC accessor.

```text
socket close / presence poll
          -> Web connection controller
          -> fetch authenticated device presence
          -> issue fresh relay ticket when online
          -> open fresh browser attachment
          -> receive ChannelServer Initialize
          -> mount one fresh service accessor generation
```

Reconnect attempts are single-flight and use bounded exponential backoff. A stale attempt may only
commit if its generation is still current. Unmount/page teardown invalidates the generation and
closes the active socket. Relay unavailability and device offline are visible recoverable states;
neither clears browser-side navigation/cache state. The direct `/fork/ws` route remains the
capability-safe fallback for a reachable fork server when no relay ticket can be issued.

`window-controller` is a Desktop Local Host aggregation channel and is not part of the
`web-remote-replayable` attachment contract. The Web client must therefore mark that capability as
absent and let UI consumers use their existing sessions-index/task-service paths. It must not create
a proxy that sends calls to an unknown channel, and absence must settle loading state immediately.

Onboarding hooks must be unconditional across the transition from an unresolved workspace to the
resolved relay workspace. The dialog may remain closed on Web when the first-run record is already
handled, but connection initialization must never leave a stale loading/onboarding overlay.

At widths below 768 px the `/fork` shell is a mobile workspace, not a scaled desktop: the connection
banner wraps without clipping, respects safe-area insets, and does not steal height from the app;
navigation/project/task surfaces can occupy the viewport, composer controls remain reachable, and
dialogs/popovers are bounded by the visual viewport. Desktop geometry remains unchanged above that
breakpoint.

Acceptance requires desktop and iPhone-sized coverage for project/task navigation, task creation,
composer send/response, model and usage controls, dialogs, and all seven connection states. Restarting
the Mac-side relay/worker must recover without a browser reload and leave the selected task usable.
