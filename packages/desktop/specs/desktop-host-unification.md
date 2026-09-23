# Desktop Host Unification

## Behavior and ownership

For AceVra development, the Electron utility Host is the sole owner of the
local `createLocalServices` graph and therefore of providers, credentials,
accounts, Codex, tasks, and artifacts. The `/fork` Web application is a remote
client of the same Host. The HTTP process in `mise run dev-web` serves the SPA
and brokers authenticated relay attachments only; it must not create a second
provider/task/account service graph.

The AceVra development compatibility data base is `~/.zcode-fork-dev-home`, with app state at
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
  -> createLocalServices(AceVra development data root)
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

On AceVra Host startup, an idempotent import may copy the Azure OpenAI and
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
