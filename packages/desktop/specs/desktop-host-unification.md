# Desktop Host Unification

## Behavior and ownership

For custom-fork development, the Electron utility Host is the sole owner of the
local `createLocalServices` graph and therefore of providers, credentials,
accounts, Codex, tasks, and artifacts. The `/fork` Web application is a remote
client of the same Host. The HTTP process in `mise run dev-web` serves the SPA
and brokers authenticated relay attachments only; it must not create a second
provider/task/account service graph.

The custom-fork default data base is `~/.zcode-fork-dev-home`, with app state at
`~/.zcode-fork-dev-home/.zcode` and app configuration at
`~/.zcode-fork-dev-home/.zcode/v2`. Explicit `ZCODE_DATA_BASE_DIR` and
`ZCODE_HOME` overrides remain supported. Official ZCode continues to use
`~/.zcode`; the one-way provider metadata importer may read that source but
never writes there and never imports credentials or authorization headers.

Electron owns manual provider credentials. Credential-bearing values are
accepted only on local Desktop writes, persisted by the Host, and never
returned by provider-setting or model-selection reads. Remote `/fork` may read
configured/missing status and model metadata but cannot read, set, or clear a
manual credential. Generic credential-store RPC is not renderer-authorized.

## State owner and event order

```text
mise run dev-web
  -> HTTP/static + Clerk + relay broker (no createLocalServices)
Electron main
  -> one window-scoped utility Host
  -> createLocalServices(custom-fork data root)
  -> authenticated Host presence socket to relay broker
/fork
  -> authenticated ticket + replayable browser socket
  -> relay broker pairs browser with Host attachment socket
  -> Host ChannelServer exposes the existing services
  -> one provider/task/account/artifact owner for both UIs
```

The Host owns attachment RPC scopes. The relay stores only presence, tickets,
and attachment routing, never tasks, snapshots, provider state, credentials, or
artifacts. Each reconnect creates a fresh attachment and RPC generation;
stale socket events cannot replace a newer generation. If the Host is offline,
`/fork` reports offline/reconnecting and does not silently start local services.

## Provider metadata migration

On custom-fork Host startup, an idempotent import may copy the Azure OpenAI and
Command Code definitions from the official personal-provider file only when the
fork does not already define the provider. It carries provider/model IDs, API
type, base URL, and validated model rules/capabilities. `apiKey`, bearer tokens,
authorization headers, and all other header values are excluded. Existing fork
provider definitions win; official files are read-only.

## Failure semantics

- Custom fork dev-server startup fails closed if its data-root contract is
  ambiguous; it never falls back to official `~/.zcode`.
- Relay outage leaves Electron local services usable and `/fork` visibly
  disconnected; it does not create a server-side replacement Host.
- Invalid/unreadable official metadata is skipped with a secret-free warning;
  existing fork configuration is preserved.
- Secret-write attempts through a remote attachment are rejected before any
  provider config mutation. Secret reads through generic credential RPC are
  rejected for every Renderer attachment.

## Acceptance cases

1. Shared root resolver yields the same custom root for `dev`, `dev-web`,
   standalone custom server, and Electron Host, while explicit overrides win.
2. Official root resolution remains `~/.zcode`; importing metadata does not
   change source bytes and strips fake sentinel secrets from the target.
3. Relay-only server startup does not call `createLocalServices`; Electron Host
   starts one service graph and registers the relay device.
4. Desktop and `/fork` read equal provider/model/effort/account/Codex/task views
   from one Host generation; reconnect creates no duplicate state owner.
5. Provider settings/model selection/relay payloads contain no raw API key or
   authorization header; a fake sentinel credential is absent from every
   serialized response.
6. Desktop can set a credential, receive only `configured` status, and use the
   key host-side. `/fork` can neither read nor mutate it.
7. Existing artifact delivery and replayable mobile behavior remain unchanged.

## Local Host crash recovery (2026-10-01)

Problem (measured on the installed alpha): the window-scoped Local Host process died
(`uncaughtException`, exit code 1) and nothing restarted it. The window kept a dead transcript
turn; every Stop/Esc reached the renderer and went nowhere.

Owner: the window lifecycle in Main (`createWindow` / `desktopWindowLifecycle.ts`) — the same
owner that already spawns the Local Host on `dom-ready` and reattaches or respawns it on renderer
reload. No second host architecture: recovery reuses that path.

Event order:

```text
Local Host exit ─► lifecycle exit observer
   intentional? (app force-quit, host being disposed, window destroyed, superseded generation)
      └─ yes ─► no respawn
   crash ─► bounded policy (≤3 restarts per 2 min; backoff 0.5 s, 2 s, 8 s)
      ├─ restart ─► after delay, if still the current generation and the window is alive:
      │             renderer reload ─► dom-ready ─► no live host in the window map ─► spawn new
      │             Local Host (new generation, new MessagePort, new hardened Helper session)
      └─ exhausted ─► no further respawn; a native message tells the user the background service
                      stopped and offers Reload (resets the budget) or Quit
```

Fencing: the renderer accepts one service port per page load, so the reload is the generation
boundary. Commands issued against the dead host's port are never delivered to the replacement;
the replacement host rehydrates sessions from durable storage and runs no turn on its own, so the
dead turn is shown as ended rather than running. Agent runtimes owned by the dead host die with
its stdio. Helper/TCC ownership is unchanged: the new host starts its own hardened Helper session
lazily, exactly as on a cold start.

Acceptance: a crash restarts once and the replacement host serves commands; repeated crashes
back off and stop after the budget; intentional disposal or quit never respawns; a controlled
development termination (`kill -9` of the Local Host pid) recovers the window live.

## Renderer crash recovery and host stdio (2026-10-03)

Problem (measured on AceVra Dev, 2026-10-02 21:05): an external `pkill -f "desktop-dev/41"`
followed by `pkill -9` killed every Electron helper whose command line carried the dev runtime
path — the primary window's renderer, GPU, network and audio services — but not Main (its process
title is just the app name) and not the Local Host (it retitles itself). Main logged
`render-process-gone reason=killed` and did nothing else: the window stayed a dead shell while the
host, Agent and Helper kept running, the task finished and played its completion sound with no
window, and the screen-recording indicator stayed on. A second incident (18:28) showed the
companion failure: when the `pnpm dev:desktop` harness died, the host's `console.log` hit a closed
stdout, the unhandled stream `EPIPE` crashed the host, and every respawn died the same way within
3 ms until Main gave up and quit.

Rules:

- The primary window's renderer is recovered by the same owner and the same bounded policy as the
  Local Host (≤3 reloads per 2 min; backoff 0.5 s, 2 s, 8 s). Recoverable reasons: `crashed`,
  `killed`, `oom`, `abnormal-exit`, `memory-eviction`. `clean-exit`, `launch-failed`,
  `integrity-failure`, and anything while the app is force-quitting are never reloaded. Recovery
  is `webContents.reload()`: `dom-ready` then reattaches the live Local Host through the existing
  `AttachServicePort` path, so running sessions survive and nothing is respawned.
- Host console output is a convenience copy; the durable record is the host-log relay to Main.
  Host `stdout`/`stderr` ignore `EPIPE` exactly like Main's logger (one shared guard in
  `packages/shared/src/brokenPipe.ts`); any other stream error still crashes loudly.

```text
render-process-gone(reason) ─► force-quitting or non-recoverable reason ─► log only
   recoverable ─► bounded policy ─► reload after backoff ─► dom-ready ─► reattach existing host
                               └─► exhausted ─► log; no further reloads
```

Acceptance: killing the renderer pid of a running dev window brings the window back with the same
sessions; a closed parent stdout never crashes the host.
