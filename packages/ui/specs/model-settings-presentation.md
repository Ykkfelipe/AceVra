# Model Settings account and partial status presentation

## Ownership and interfaces

- `packages/services/src/accounts` owns local Codex / Claude / Command Code status reads and
  returns sanitized status contracts. The settings UI does not access their local stores.
- `AccountBridgeDetail` owns only presentation of the harness connection and the reported
  source sign-in fact. Disconnect stops the harness bridge; it never logs the source account
  out.
- `CommandCodeCliStatus` presents the supported CLI status in the Command Code provider
  detail. The provider remains the sole Command Code navigation identity.
- Coding Plan account status and optional plan/catalog inventory have separate owners. A
  failed optional inventory must not erase a successfully loaded account or usage status.
- Z.ai sign-in credentials are owned by `OAuthCredentialRepo` and the encrypted local
  credential service. They must survive an app restart; account/plan/usage presentation is
  restored or refreshed from that saved session rather than copied into renderer state.

## Product rules

- Codex usage displays only backend-reported percentages, reset timestamps, and window
  durations. Labels derive deterministically from returned duration: 300 minutes means
  5-hour; 10080 minutes means weekly; other values remain generic.
- Claude copy describes this connection's available status fields. It must not claim that
  Claude has no usage API. Never render quota estimates when the local status has no usage.
- Command Code appears once in Model Settings. Its compact CLI metadata includes
  authenticated state, user, version, default model, and context window when present. These
  values form a wrapping metadata row, not a second account card.
- Z.ai's usable account/plan and usage state remains healthy when optional plan/catalog
  metadata fails. Show a subtle inline “Plan details unavailable · Retry” status. Strong
  error presentation is reserved for unavailable authentication/account state. An upgrade or
  manage action requiring missing plan metadata is disabled; retry re-reads that optional
  metadata.
- At approximately 420 px, content has no horizontal overflow, nav remains reachable, action
  rows wrap, text metadata remains readable, and descendant action buttons do not stretch due
  to a broad mobile selector.

## Acceptance scenarios

1. Codex `account/rateLimits/read` reports the 300-minute and 10080-minute windows; labels,
   percentages, and resets match those values. Missing fields stay missing.
2. Claude auth status is signed in while local quota data is absent; identity renders and the
   UI says usage information is unavailable through this connection.
3. Harness disconnect is enabled only when its bridge is connected and does not change source
   sign-in.
4. Command Code CLI status includes model and context metadata; the provider detail shows both
   without a second Command Code navigation item.
5. Z.ai account and usage reads succeed while optional plan/catalog lookup fails; account and
   usage stay usable, retry is subtle, and plan-dependent upgrade/manage controls are disabled.
6. Capture provider and account details at approximately 1200, 900, and 420 px. At 420 px,
   verify no horizontal overflow, nested buttons, action wrapping, readable metadata, and
   usable navigation.
7. After Z.ai sign-in, restart the app and confirm the account remains connected while plan,
   catalog, and usage data refresh from their owning services.
