# Custom fork remote boundary

The fork remote experience is intentionally a thin boundary around the existing
web shell and replayable RPC transport. `/fork` serves the same built Web SPA;
`/fork/ws` exposes the existing `web-remote-replayable` channel server. No new
provider or agent-runtime path is introduced.

`@zcode/shared` owns the product defaults (`ZCode Fork Dev`, `/fork`, `/fork/ws`,
telemetry disabled). Desktop, server, and Web consume that contract rather than
duplicating identity strings.

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
