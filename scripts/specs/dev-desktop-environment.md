# Desktop development environment

The public `dev:desktop` launcher owns development process identity. It sanitizes the
inherited environment once, before preparation/build/watch/Electron. Release launch is unchanged.

Process-scoped CUA broker/lease credentials, launcher PID, plugin roots, packaged resource
paths, provider paths and build identity never belong to a new dev runtime. They are removed.
The shared runtime sanitizer's key predicate supplies the existing transient runtime keys;
its capture function must not capture foreign credentials in the launcher.

A foreign parent is identified by a CUA launcher PID or installed-app resource path. In that
case inherited endpoint and data/product identity overrides are removed too. Clean-shell
explicit endpoint/home overrides and CUA development/test flags remain supported. `.env.local`
is an explicit repository configuration source, applied after removing foreign configuration; clean explicit shell settings take precedence.
Transient credentials and launcher identity cannot be restored by `.env.local`; explicit
Helper/provider path overrides in that file are supported for tests. The selected test/production
backend is independent from the development execution environment.

Order: inherited shell → sanitize → repository local config → selected backend + development
runtime → all preparation and watch children. No secret values are logged.

Acceptance: contaminated ZCode environment cannot point the Helper/provider/plugin at the
installed app; legitimate unrelated variables, clean test overrides and local configuration
survive; source environment is immutable; both backend selections use development runtime.

## Isolated data root (2026-10-03)

Measured: `pnpm dev:desktop` set no data root, so AceVra Dev fell through to `~/.zcode` — the
same root the installed upstream ZCode.app uses. Both apps seed the same official plugin cache
path (`~/.zcode/cli/plugins/cache/zcode-plugins-official/node-repl-host/0.6.0`) with different
builds under the same version label. When ZCode.app started a task it replaced AceVra's
`node-repl-host` with its own (hash proven identical to ZCode.app's bundled copy), and AceVra's
running node_repl host — which spawns each cell's Worker from that file — began executing
ZCode's build, which never installs `agent.computerUse`: `ReferenceError: agent is not defined`
mid-task. The two apps also overwrote each other's `v2/setting.json` and interleaved one log.

Rule: after sanitizing and applying repository config, if none of `ZCODE_HOME`,
`ZCODE_DATA_BASE_DIR` or `ZCODE_DESKTOP_HOME_DIR` is set, the launcher sets all three to one
development profile, `~/.zcode-acevra-dev` (`ZCODE_HOME` = `<profile>/.zcode`). Any explicit
value (clean shell, `.env.local`, or the `mise run dev` test-backend task's
`~/.zcode-fork-dev-home`) wins and nothing is filled in around it. A foreign parent's data root is
removed first, so it is replaced by the default rather than inherited. The Helper artifact root
(`~/.zcode-fork-cua-home`) and its TCC identity are unaffected. The Agent CLI never reads `ZCODE_HOME` (it uses
`ZCODE_STORAGE_DIR` or else `os.homedir()`), so the host's Agent spawn derives
`ZCODE_STORAGE_DIR` from any explicit `ZCODE_HOME` (services `buildAgentStorageEnv`; an explicit
`ZCODE_STORAGE_DIR` wins). This applies to every explicit profile, the local alpha included, whose
CLI previously also wrote the shared `~/.zcode/cli`. Consequence: a fresh dev profile
starts signed out with default settings; nothing in `~/.zcode` is moved or deleted.

With local Helper admission explicitly enabled, and no explicit Helper override, the launcher
points at the development builder's fixed `.zcode-fork-cua-home/.zcode/computer-use/dev/`
artifact (or configured CUA_HOME). The data profile does not own a second Helper copy. The
hardened resolver still verifies that app and its sibling probe before admission.

```mermaid
sequenceDiagram
  participant Shell
  participant Launcher
  participant Preparation
  participant Host
  participant Helper
  participant Context
  Shell->>Launcher: inherited environment
  Launcher->>Launcher: remove foreign identity; apply repository defaults
  Launcher->>Preparation: sanitized environment (all build/watch children)
  Preparation->>Preparation: verify/seal generated Dev bundle
  Preparation->>Host: launch verified Dev runtime
  Host->>Helper: pinned native transport admission
  Host->>Context: provisioned transport snapshot
  Context->>Context: canonical surface + delivery defaults
  Note over Host,Helper: Host owns lazy recovery; physical connection is not capability truth
```
