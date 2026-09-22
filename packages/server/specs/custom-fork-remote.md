# Custom fork remote boundary

The fork remote experience is intentionally a thin boundary around the existing
web shell and replayable RPC transport. `/fork` serves the same built Web SPA;
`/fork/ws` exposes the existing `web-remote-replayable` channel server. No new
provider or agent-runtime path is introduced.

`@zcode/shared` owns the product defaults (`ZCode Fork Dev`, `/fork`, `/fork/ws`,
telemetry disabled). Desktop, server, and Web consume that contract rather than
duplicating identity strings.

The route has an env-only Clerk hand-off boundary. Set
`ZCODE_FORK_CLERK_SESSION_TOKEN` on the local server and provide the matching
short-lived session token as a bearer token or `?token=` during development.
With no token configured, the route stays closed unless
`ZCODE_FORK_ALLOW_UNAUTHENTICATED=1` is explicitly set. No Clerk secret or
session token belongs in the repository. Replacing this comparison with Clerk
JWT/JWKS verification is isolated to `customForkClerkAuth.ts`.

Official routes, providers, relay behavior, and agent behavior are unchanged.
