# AceVra 0.1.0-alpha.1 spec-first release implementation plan

Date: 2026-09-23  
Branch: `release/0.1.0-alpha`  
Status: **specification complete; implementation not started; no candidate accepted**

## 1. Release decision

Build one macOS 12+ arm64 local engineering alpha with root version `0.1.0-alpha.1`,
production application identity `com.acevra.desktop` / `AceVra`, isolated AceVra data, working
packaged CUA-3, one exact DMG named `AceVra-0.1.0-alpha.1-arm64.dmg`, one matching ZIP, and
self-signed/non-notarized local distribution only.

The current checkout has a successful historical Electron Builder run but **not an accepted
candidate**. The current DMG/ZIP are structurally valid, while candidate validation fails archive
naming, packaged provenance, and effective outer-app signature enforcement; the packaged product
runtime is still fail-closed. Implementation must close every blocker below before installation.

Authoritative product rules are now consolidated in:

- `packages/desktop/specs/release-0.1.0-alpha.1.md`
- `packages/zcode-cua/specs/computer-use.md`, especially its named alpha section

This plan does not authorize a public Apple release or a broader distribution claim.

## 2. Current evidence and audit-conflict resolution

| Topic                   | Current source/runtime evidence                                                                                                                                                                                                                                                                                                                                                                                                                     | Planning decision                                                                                                                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version                 | Root version is `0.1.0-alpha.1` at `package.json:1-3`; root bundle command is `package.json:28-30`.                                                                                                                                                                                                                                                                                                                                                 | Keep one root version source; do not rewrite workspace versions.                                                                                                                                                                                                                             |
| Product identity        | Production identity is `com.acevra.desktop` / `AceVra` at `packages/desktop/scripts/desktop-product-identity.mjs:9-16`; the alpha rejects Preview at `packages/desktop/scripts/desktop-release-profile.mjs:40-47`.                                                                                                                                                                                                                                  | Preserve production identity and reject `ZCODE_PREVIEW_IDENTITY=1`; do not claim a new Apple identity.                                                                                                                                                                                       |
| CUA package state       | `packages/zcode-cua/package.json:1-5` calls the package a placeholder; installer/Host fail closed at `packages/zcode-cua/broker-server.js:23-27,100-130`; `packages/zcode-cua/test/packaging-boundary.test.mjs:17-37` enforces that baseline.                                                                                                                                                                                                       | Replace only the product integration; retain fail-closed legacy native-addon exports. Update the contradictory packaging-boundary test with product integration tests.                                                                                                                       |
| Packaged resources      | Main injects the Helper path at `packages/desktop/src/main/desktopRuntimeEnv.ts:509-528,586-588`; installer resolves it at `packages/desktop/src/main/desktopCuaHelperInstaller.ts:24-35`; services search only below `ZCODE_HOME` at `packages/services/src/cua-permission-broker/darwinCuaHelperTransport.ts:63-103`.                                                                                                                             | Services must prefer exact packaged Helper/probe paths, then approved dev candidates; no manual copy below alpha `ZCODE_HOME`.                                                                                                                                                               |
| Native identities       | Product Helper is `AceVra Computer Use.app` / `dev.acevra.cua-helper` at `packages/zcode-cua/native/cua-helper/build-product-helper.mjs:26-30,46-60`; probe is `dev.acevra.cua-peer-identity.development` at `packages/zcode-cua/native/peer-identity/build-peer-identity-probe.mjs:31-33`.                                                                                                                                                         | Preserve both identifiers exactly. The development Helper remains separate.                                                                                                                                                                                                                  |
| Main-app signature      | Builder enables signing only when `ZCODE_ENABLE_MAC_SIGN=1` at `packages/desktop/electron-builder.config.js:82-86,208-216`; the signing env resolver at `packages/desktop/scripts/bundle.mjs:390-421` does not set that switch.                                                                                                                                                                                                                     | Bundle must set and verify the switch, then sign app/Helper/probe with the isolated identity. Ad-hoc app is rejected.                                                                                                                                                                        |
| Archive names           | Builder inserts `mac` at `packages/desktop/electron-builder.config.js:245-247,677-680`; validator expects no `mac` at `scripts/release/verify-local-alpha-candidate.mjs:127-141`.                                                                                                                                                                                                                                                                   | Alpha-specific name function emits exactly `AceVra-0.1.0-alpha.1-arm64.dmg` and `.zip`; no global Preview/production rename.                                                                                                                                                                 |
| Validator signature bug | `run()` discards successful stderr at `scripts/release/verify-local-alpha-candidate.mjs:24-32`; `codesign -dv` details are read from the wrong stream at `:224-235`.                                                                                                                                                                                                                                                                                | Capture and validate stdout plus stderr; test an ad-hoc app fixture.                                                                                                                                                                                                                         |
| Provenance leak         | Builder copies absolute `appPath` from `packages/zcode-cua/native/cua-helper/build-product-helper.mjs:204-215` into packaged JSON at `packages/desktop/scripts/bundle.mjs:497-500`.                                                                                                                                                                                                                                                                 | Emit logical/relative resource names and non-secret signature facts only.                                                                                                                                                                                                                    |
| Architecture mismatch   | Bundle hard-codes Helper `--arch arm64` at `packages/desktop/scripts/bundle.mjs:474-485` although generic packaging accepts x64.                                                                                                                                                                                                                                                                                                                    | Local alpha is arm64-only; reject x64/universal before building instead of shipping a mismatched Helper.                                                                                                                                                                                     |
| Physical lock           | `/tmp/acevra-cua-exclusive-<uid>.lock` is replaceable at `packages/zcode-cua/native/cua-helper/ForegroundControl.swift:147-159`.                                                                                                                                                                                                                                                                                                                    | Release stays blocked until physical exclusion cannot be bypassed by unlink/recreate. Do not narrow the CUA-3 claim.                                                                                                                                                                         |
| Stop state              | Runtime `activeLeases` is local projection state at `packages/zcode-cua/index.js:40-64,153-165,192-198`; the authenticated node-repl host constructs that runtime in a separate MCP process at `apps/zcode-cli/packages/node-repl-host/src/server.ts:376-386`; settings has no software Stop surface. Existing Computer Use operation events at `packages/shared/src/zcode-protocol/index.ts:1059-1109` are turn/tool projections, not lease state. | Add a private authenticated node-repl-to-services lease sideband, a typed CUA service Stop command, and a service-owned lease authority. Do not reuse session events, add a raw Desktop command, or add a model tool.                                                                        |
| Output resolution       | Bundle resolves `ZCODE_DESKTOP_DIST_DIR` from `packages/desktop` at `packages/desktop/scripts/bundle.mjs:30-48`; the validator resolves `--dist` from the repository root at `scripts/release/verify-local-alpha-candidate.mjs:127-135`. A relative `release/...` value therefore names different directories.                                                                                                                                      | Use one absolute build path for builder, validator, reports, and installed runner; add a path-resolution invariant test. Never use the prior relative value.                                                                                                                                 |
| Five-file handoff       | Electron Builder currently emits DMG/ZIP blockmaps and `latest-mac.yml` under the `dmg`/`zip` target at `packages/desktop/electron-builder.config.js:677-680`; the validator only checks archive names and currently mutates its input to write sidecars at `scripts/release/verify-local-alpha-candidate.mjs:255-315`.                                                                                                                             | Separate raw `build/`, verified `validation/`, and no-clobber `handoff/`. Inventory before copy; assemble the exact five files in a unique staging directory and atomically rename it into place.                                                                                            |
| E2E boundary            | The repository has E2E bridge/coverage primitives but no runnable Desktop CUA interaction runner; `packages/desktop/package.json:7-27` and `packages/ui/package.json` have no component/E2E test script. Manual installed acceptance cannot replace the interaction requirement in `AGENTS.md:41`.                                                                                                                                                  | Add a real Playwright Electron runner at `packages/desktop/e2e/cua-release-safety.e2e.mjs` with desktop script `e2e:cua-alpha`; cover the full Stop UI state sequence before installed acceptance.                                                                                           |
| Network observation     | `apps/zcode-cli/packages/debug/server/network-capture.ts:43-165` provides a local redacting HTTP/WS proxy, but it alone cannot observe raw non-proxy sockets.                                                                                                                                                                                                                                                                                       | Combine the local capture sink with fail-closed `nettop`, DNS/network unified logging, refreshed app-descendant attribution, and CDP dialog/service inspection. Any unattributed activity fails.                                                                                             |
| Fresh TCC               | CUA permission status is Helper-owned and requirement-bound (`packages/zcode-cua/native/cua-helper/Observe.swift:73-113`); a prior alpha Helper with the same bundle id and stable certificate can already hold both grants.                                                                                                                                                                                                                        | Before human authorization, probe the exact Helper requirement. Any pre-existing trusted permission marks the proof non-fresh and blocks until manual System Settings removal and observed denial.                                                                                           |
| Replacement safety      | The installed runner does not exist; a simple flag cannot make `/Applications` replacement transactional.                                                                                                                                                                                                                                                                                                                                           | Specify a no-clobber backup/stage/rename/verify/rollback transaction, require the app to be quit, and retain the backup until acceptance completes.                                                                                                                                          |
| Stale native comments   | `packages/zcode-cua/native/peer-identity/build-peer-identity-probe.mjs:6-8` says the probe is not wired into packaging, while `packages/desktop/electron-builder.config.js:703-704` describes Developer ID signing/stapling. Both contradict the current bundle and self-signed alpha contract.                                                                                                                                                     | Phase 2 must correct these comments in the same change; do not preserve or copy misleading release guidance.                                                                                                                                                                                 |
| Data isolation          | Profile/bootstrap roots exist at `packages/desktop/scripts/desktop-release-profile.mjs:67-114` and `packages/desktop/src/main/desktopDataBaseDirBootstrap.ts:58-67`, but MCP sync reads `HOME` at `packages/services/src/mcp-sync/mcpSyncService.ts:148-165` and trajectory search starts with `homedir()` at `packages/services/src/zcode-agent/modelTrajectoryFileTail.ts:15-20`.                                                                 | Route both through the canonical alpha root and add production-sentinel behavior tests.                                                                                                                                                                                                      |
| Architecture policy     | `zcode-cua` exists but is `managed: false` at `architecture-policy.yaml:73-82`; services, desktop, and UI are also legacy/unmanaged, while `AGENTS.md:39` requires governance before code edits.                                                                                                                                                                                                                                                    | Before Phase 1, run `--changed` plus controlled contexts for `zcode-cua`, `services`, `desktop`, and `ui`. Define a bounded managed `cua-lease-authority` module/contract before changing runtime code; do not flip the entire legacy CUA package managed without a baseline-aware boundary. |
| CUA scope conflict      | General CUA text previously required universal support, while the named alpha spec is arm64-only.                                                                                                                                                                                                                                                                                                                                                   | The named local alpha is an explicit arm64-only exception; other CUA-3 release requirements are unchanged.                                                                                                                                                                                   |
| Apple status            | Builder disables notarization at `packages/desktop/electron-builder.config.js:690-695`; the general doctor requires Gatekeeper assessment and optionally a staple at `scripts/doctor-macos-release-app.sh:87-101`.                                                                                                                                                                                                                                  | This alpha is self-signed and non-notarized. Gatekeeper rejection is a recorded human checkpoint, not a passing distribution gate.                                                                                                                                                           |

## 3. Architecture map

```text
root package.json 0.1.0-alpha.1
  -> desktop-release-profile.mjs
     -> early Desktop bootstrap
        -> Electron userData/sessionData
        -> services data base / ZCODE_HOME / model-I/O
        -> local updater disable
  -> build-metadata.mjs
     -> deterministic Helper version/build/signing facts
  -> bundle.mjs [absolute ZCODE_DESKTOP_DIST_DIR]
     -> isolated keychain + exact identity
     -> product Helper builder -> Resources/cua-helper/AceVra Computer Use.app
     -> peer probe builder   -> Resources/cua-helper/peer-identity-probe
     -> Electron Builder signs outer app; signIgnore preserves nested CUA signatures
     -> release/.../build/{raw app, archives, blockmaps, update metadata}
  -> verify-local-alpha-candidate.mjs [same absolute build path]
     -> inventory every build file before mutation
     -> identity/version/arch/path/signature/provenance/content checks
     -> release/.../validation/{verified app + archives + reports}
  -> assemble-local-alpha-handoff.mjs
     -> unique staging directory
     -> copy two verified archives + generate three sidecars
     -> exact five-file validation
     -> atomic no-clobber rename to release/.../handoff

installed /Applications/AceVra.app
  -> /usr/bin/open (first launch; Gatekeeper checkpoint before behavior)
  -> Desktop main
     -> process.resourcesPath/cua-helper/{Helper,probe}
     -> services CUA product boundary
        -> hardened host-owned socket
        -> native peer probe + pinned requirements
        -> product Helper
        -> private authenticated lease-authority sideband
           -> authenticated node-repl MCP runtime begin/commit/release
           -> service-authoritative generation/terminal record
           -> background semantic CUA or explicit exclusive foreground lease
           -> bounded event, interruption, Stop, cleanup
  -> existing settings surface
     -> opt-in + TCC guidance + active Stop only
```

### State owners and event order

| State/fact                             | Sole authority                                   | Other consumers                                                                                     |
| -------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Release version/profile                | root metadata + compiled release profile         | builder, validator, About/runtime projections                                                       |
| Electron roots                         | Desktop bootstrap/main                           | services child environment, installed acceptance                                                    |
| User data/model-I/O                    | services path authority                          | MCP sync, trajectory reader, onboarding/account services                                            |
| Packaged Helper/probe                  | `process.resourcesPath` injected by Desktop main | installer and hardened transport pin exact paths/requirements                                       |
| Helper process/TCC identity            | signed Helper bundle                             | settings displays verified identity; never infers from app grant                                    |
| Foreground lease/generation            | new managed services `cua-lease-authority`       | authenticated node-repl runtime, UI status, Stop, cleanup projections; runtime map is not authority |
| Physical held keys/mouse/tap/exclusion | signed Helper                                    | service observes terminal release; never duplicates input                                           |
| Candidate acceptance                   | validator result plus recorded human checkpoints | release worklog only; UI never self-claims acceptance                                               |

```text
user enables CUA
  -> service/plugin state
  -> local task invokes canonical Computer tool in node-repl MCP process
  -> authenticated lease sideband: begin_acquire(owner/context)
  -> service reserves generation and opens/resolves packaged Helper session
  -> Helper passes launch contract + host/helper/probe requirements
  -> Helper acquires physical exclusion + event tap
  -> runtime calls Helper acquire_control
  -> authenticated sideband: commit_acquire(lease id + Helper DR)
  -> service commits authoritative active record -> UI projection
  -> bounded semantic/foreground action
  -> Stop | release_control | physical event | runtime/Helper disconnect
  -> service fences old generation
  -> Helper cleanup: up-events, tap disabled, exclusion released
  -> sideband/service terminal record -> released UI projection
```

The runtime in `apps/zcode-cli/packages/node-repl-host/src/server.ts:376-386` is a separate process
and therefore cannot mutate a services-only object directly. The sideband uses a per-service random
capability with constant-time comparison, same-UID peer validation, a `0700` directory, and a `0600`
local socket. It is injected only into the official CUA MCP server and removed from
Bash/tools/unrelated child environments. Existing turn/session events are display projections, not
lease transport.

A concurrent Stop serializes with an in-flight `begin_acquire`: it waits for that admission to
settle, then releases a newly committed lease or returns `already_stopped`. If Stop fences the
reservation first, the late `commit_acquire` is rejected and the runtime must immediately release
the Helper lease. It cannot observe “none” and allow a later acquire to commit behind Stop.

## 4. Current identities to preserve

| Surface                | Identity/name                                                             | Rule                                                 |
| ---------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------- |
| Root/app version       | `0.1.0-alpha.1`                                                           | Single version source.                               |
| Release profile        | `local-engineering-alpha`                                                 | Environment/filesystem profile, not identity flavor. |
| App                    | `com.acevra.desktop` / `AceVra` / executable `AceVra`                     | Production identity retained.                        |
| Preview                | `com.acevra.desktop.preview` / `AceVra Preview`                           | Existing builds only; alpha rejects selection.       |
| Product Helper         | `dev.acevra.cua-helper` / `AceVra Computer Use.app` / `AceVraComputerUse` | Packaged product identity.                           |
| Development Helper     | `dev.acevra.cua-helper.development` / `AceVra Computer Use Dev.app`       | Harness only; never packaged as product.             |
| Peer probe             | `dev.acevra.cua-peer-identity.development`                                | Preserve exact compatibility identifier.             |
| Signing                | `AceVra CUA Dev Signing`, isolated keychain                               | Local self-signed stable identity; not Developer ID. |
| Internal compatibility | `@zcode/*`, `zcode://`, existing service/protocol names                   | No rename in this release.                           |

The main app, Helper, and probe use the same local certificate root for this alpha, while each keeps
its own identifier. The Helper pins the outer app's stable certificate-root requirement; it must
never accept the current ad-hoc cdhash-only host requirement.

## 5. Native design

### Package and launch

- Build the Helper and probe before Electron Builder from the same resolved isolated keychain and
  exact identity.
- Embed them at fixed paths under `Contents/Resources/cua-helper` and preserve nested signatures.
- Inject both exact packaged paths to the Host. The hardened transport verifies and pins each
  designated requirement before creating a session.
- Launch automatically through `/usr/bin/open` and the existing host-connect contract. Do not copy
  a signed payload into alpha `ZCODE_HOME`, do not use a stable-socket fallback, and do not require
  the user to click the Helper app.
- Keep one app/Helper/probe architecture: arm64. The candidate builder rejects x64/universal.

### Peer and capability boundary

- Host owns the listening socket and launch token.
- Native probe binds the connected socket audit token to the verified Helper process instance and
  checks `LOCAL_PEERPID`/`LOCAL_PEERCRED`, launch arguments, host requirement, Helper requirement,
  and probe requirement.
- Missing or mismatched identity fails closed before CUA traffic.
- Only authenticated local `desktop-continuous` main-runtime context can acquire/use foreground
  control. Mobile replayable, remote, and subagent contexts remain refused.

### Physical exclusion checkpoint

The current `/tmp` pathname is not accepted. Before native code changes, a focused design proof
must demonstrate a kernel-backed exclusion that:

1. serializes all genuine Helper instances for the physical desktop;
2. cannot be unlinked/replaced by another same-uid process to obtain a second lock;
3. releases on every terminal path and process exit;
4. does not weaken the Helper's own bundle/signature check or TCC identity;
5. can be deterministically tested for contention, replacement attack, disconnect, and cleanup.

If no acceptable primitive exists, release remains blocked. Do not implement another replaceable
file path and do not claim process-wide serialization without the proof.

## 6. Data roots and isolation

| Data                 | Owner/path                                                                 |
| -------------------- | -------------------------------------------------------------------------- | --- | -------------- |
| Electron user data   | `~/Library/Application Support/AceVra Local Engineering Alpha`             |
| Electron session     | `~/Library/Application Support/AceVra Local Engineering Alpha/session`     |
| Profile/service base | `~/.zcode-local-engineering-alpha`                                         |
| Settings/state       | `~/.zcode-local-engineering-alpha/.zcode/v2`                               |
| Host `ZCODE_HOME`    | `~/.zcode-local-engineering-alpha/.zcode`                                  |
| CUA runtime state    | `~/.zcode-local-engineering-alpha/.zcode/computer-use`                     |
| Model I/O            | `~/.zcode-local-engineering-alpha/.zcode/cli/{debug,rollout}`              |
| MCP user records     | below the canonical profile home's `.zcode`/`.agents`, never OS `HOME`     |
| Workspace MCP/paths  | workspace `workspacePath`; identity key remains `workspaceIdentity?.trim() |     | workspacePath` |

Implementation must close MCP sync and model-trajectory fallback. The inventory test is necessary
but not sufficient: a production sentinel must remain byte-for-byte unchanged and unreadable while
the equivalent alpha file is read successfully.

## 7. Implementation sequence and exact bounded areas

### Phase 0 — specifications and architecture gate (spec complete; governance pending)

Specifications updated before implementation:

- `packages/desktop/specs/release-0.1.0-alpha.1.md`
- `packages/zcode-cua/specs/computer-use.md`

Before the first Phase 1 code edit, implementation must run and record:

```bash
mise exec -- node scripts/mise-run.mjs pnpm architecture:check --changed
mise exec -- node scripts/mise-run.mjs pnpm architecture:context zcode-cua
mise exec -- node scripts/mise-run.mjs pnpm architecture:context services
mise exec -- node scripts/mise-run.mjs pnpm architecture:context desktop
mise exec -- node scripts/mise-run.mjs pnpm architecture:context ui
```

Before runtime changes, update `architecture-policy.yaml` with a bounded managed module (not a blind
whole-package flip):

- id: `cua-lease-authority`
- root: `packages/services/src/cua-permission-broker/lease-authority/`
- public entrypoint: `contract.ts`
- owner: `computer-use`
- allowed dependencies: `shared`, `rpc`, `zcode-cua` public entrypoints, and the parent services
  boundary
- layers: `domain` (record/generation), `app` (admission/Stop orchestration), `adapters` (local
  authenticated socket)
- layer order: `domain → app → adapters`
- no reverse imports into desktop, UI, node-repl host, or native implementation

The existing `zcode-cua`, services, desktop, and UI modules remain legacy/unmanaged unless a
baseline-aware migration is separately approved. The new module is managed from its first edit;
focused tests additionally reject deep imports and cycles across the new boundary. If context or
`--changed` is not clean before the edit, implementation stops and records the baseline rather than
suppressing it.

### Phase 1 — make the product CUA path real

Bounded files:

- `packages/zcode-cua/package.json`
- `packages/zcode-cua/broker-server.js`
- `packages/zcode-cua/broker-server.d.ts`
- `packages/zcode-cua/broker.d.ts`
- `packages/zcode-cua/host-transport.js`, `host-transport.d.ts`,
  `host-transport-policy.js` only as required by the existing launch contract
- `packages/services/src/node.ts`
- `packages/services/src/cua-permission-broker/darwinCuaHelperTransport.ts`
- `packages/desktop/src/main/desktopCuaHelperInstaller.ts`
- `packages/desktop/src/main/desktopRuntimeEnv.ts`
- tests under `packages/zcode-cua/test/` and `packages/services/test/`

Behavior:

- installer, Host, lifecycle, permission status, MCP resolver, and agent environment use the
  packaged product Helper/probe;
- wrong/missing/tampered resources fail closed;
- no unavailable product Host and no legacy stable-socket fallback;
- unused legacy native-addon exports remain explicit fail-closed APIs.

### Phase 2 — stable signing, provenance, architecture, and artifacts

Bounded files:

- `packages/desktop/scripts/bundle.mjs`
- `packages/desktop/electron-builder.config.js`
- `packages/zcode-cua/native/cua-helper/build-product-helper.mjs`
- `packages/zcode-cua/native/peer-identity/build-peer-identity-probe.mjs`
- `scripts/release/verify-local-alpha-candidate.mjs`
- new `scripts/release/assemble-local-alpha-handoff.mjs`
- `package.json`
- `.gitignore`, `.oxlintrc.json` for generated build/validation/handoff exclusion only
- `packages/desktop/scripts/*test.mjs` and `scripts/release/*test.mjs`

Behavior:

- set `ZCODE_ENABLE_MAC_SIGN=1` in the same resolved alpha bundle environment;
- pass the requested architecture explicitly and reject non-arm64 alpha targets;
- write relative-only native provenance;
- correct the peer builder's stale “not wired into packaging” comment at
  `packages/zcode-cua/native/peer-identity/build-peer-identity-probe.mjs:6-8`;
- correct Electron Builder's stale Developer ID/staple wording at
  `packages/desktop/electron-builder.config.js:703-704` to the self-signed, non-notarized alpha
  contract without changing the production comment;
- validate raw `build/` without deleting or mutating unexpected files; record a complete source
  inventory first;
- copy only verified app/archive fixtures into no-clobber `validation/`;
- assemble `handoff/` through unique staging and an exact five-file allowlist;
- validator reads signature stderr, exact DR/fingerprint, Mach-O architectures, source-path/secret
  scans, sidecars, and stable app identity;
- lint/format do not inspect generated build/validation/handoff contents, while source lint rules
  are unchanged.

### Phase 3 — cross-process lease authority and software Stop

Bounded files:

- managed service module:
  `packages/services/src/cua-permission-broker/lease-authority/{contract.ts,authority.ts,server.ts}`
- `packages/zcode-cua/lease-authority-client.js` and `.d.ts` (public package entrypoint)
- `packages/zcode-cua/broker.d.ts` for service status/Stop types
- `packages/zcode-cua/index.js` and `index.d.ts` to consume the injected authority client
- `packages/shared/src/runtimeEnv.ts` for captured, targeted, sanitized sideband credentials
- `apps/zcode-cli/packages/bootstrap/src/mcp-config.ts` to inject credentials only into the
  official CUA MCP server
- `apps/zcode-cli/packages/node-repl-host/src/server.ts` and focused host test
- `packages/services/src/zcode-agent/zcodeAgentService.ts` and
  `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/computer-use-operation-event.ts` only to prove
  the existing turn/session sideband is not a lease authority; do not extend that event union for
  lease state
- `packages/services/src/node.ts` to create/dispose the authority, inject its transport, and expose
  typed service status/Stop
- `packages/ui/src/settings/ComputerUseSection.tsx` and typed UI service hook if required
- `packages/zcode-cua/native/cua-helper/ForegroundControl.swift` for the Phase 5 exclusion proof

Protocol decision: use a dedicated private local sideband, not the ZCode session/event protocol.
The sideband is necessary because the authenticated node-repl runtime is a separate MCP process.
It carries only `begin_acquire`, `commit_acquire`, `release/interruption`, `close/disconnect`, and
status projection. It does not expose a model tool, duplicate CUA actions, or send Stop to the
Helper without service authorization. Therefore this plan does not authorize changes to
`packages/shared/src/zcode-protocol/index.ts`; if implementation chooses the Agent protocol instead,
it must first revise the spec and add strict schemas/runtime validation plus cross-process tests for
that protocol boundary.

Behavior:

- one service record serializes acquiring/active/releasing/terminal generations;
- `begin_acquire` reserves a generation before the Helper call; only `commit_acquire` publishes
  active state;
- Stop waits for an in-flight admission, releases a committed lease, or returns `already_stopped`;
- a fenced late commit fails and forces immediate Helper release;
- runtime/UI maps are projections only;
- sideband auth failure, malformed message, stale generation, socket loss, or missing required
  service authority fails closed;
- credentials are stripped from Bash/tools/unrelated MCP children;
- software Stop is local UI only and waits for terminal cleanup;
- no model-facing Stop tool and no new raw `DesktopCommandId`;
- physical exclusion meets Phase 5 proof before native implementation proceeds.

### Phase 4 — complete alpha data isolation

Bounded files:

- `packages/services/src/mcp-sync/mcpSyncService.ts`
- `packages/services/src/zcode-agent/modelTrajectoryFileTail.ts`
- `packages/services/test/directHomeReaderInventory.test.ts`
- `packages/services/test/localAlphaHomeIsolation.test.ts`
- focused MCP/trajectory behavior tests under `packages/services/test/`

Behavior: canonical profile root only; no production-first search; workspace identity semantics
unchanged.

### Phase 5 — native physical exclusion and physical-input proof

Bounded files:

- `packages/zcode-cua/native/cua-helper/ForegroundControl.swift`
- native launch contract files only if the selected kernel primitive requires contract data
- `packages/zcode-cua/native/cua-helper/run-foreground-policy-tests.sh`
- a focused native exclusion test beside the existing foreground tests
- `packages/zcode-cua/native/cua-helper/run-foreground-live.mjs` for installed/local live setup

Behavior and evidence are the five requirements in section 5. Synthetic events never replace the
human physical event checkpoint.

### Phase 6 — smallest release-safety UX and renderer E2E

Bounded files:

- `packages/ui/src/settings/ComputerUseSection.tsx`
- `packages/ui/src/i18n/locales/en-US.ts`
- `packages/ui/src/i18n/locales/zh-CN.ts`
- `packages/desktop/src/renderer/cuaPermissionPanelMessages.ts`
- `packages/desktop/src/renderer/cuaPermissionPanel.ts`
- `packages/desktop/src/renderer/index.html`
- new `packages/desktop/e2e/cua-release-safety.e2e.mjs`
- new test-only E2E lease-state adapter under `packages/desktop/src/main/`, enabled only by both
  the existing build flag and a real E2E run id
- `packages/desktop/package.json` with exact script `e2e:cua-alpha`

`OnboardingWelcomeView.tsx` and its pre-existing `text-4xl` issue are explicitly out of this
release. The typography defect requires its own spec-first change; this release touches onboarding
branding nowhere.

Behavior:

- one compact local-alpha/self-signed/non-notarized/data-root/no-inference safety block;
- existing CUA opt-in and TCC permission rows remain;
- CUA is off by default and no Stop control exists before an authoritative active lease;
- active-lease-only software Stop control, repeated Stop safe, released state hides/disables Stop;
- touched UI says AceVra where user-visible and uses `text-ui-*` typography;
- no new onboarding step, automatic CUA enablement, or provider/account behavior.

Exact automated E2E command after implementation:

```bash
mise exec -- node scripts/mise-run.mjs pnpm --filter @zcode/desktop e2e:cua-alpha
```

The runner uses Playwright Electron against the built renderer and covers safety copy, default-off,
no Stop before lease, active Stop, repeated Stop, and released projection. The test-only state
adapter is unreachable without both the build flag and run id; component-only tests do not replace
this scenario.

### Phase 7 — handoff assembly, no-clobber install, and installed acceptance

Bounded files:

- `scripts/release/verify-local-alpha-candidate.mjs`
- `scripts/release/assemble-local-alpha-handoff.mjs`
- `scripts/release/accept-local-alpha-installed.mjs`
- `apps/zcode-cli/packages/debug/server/network-capture.ts` and its tests for body-free,
  credential/query-redacted evidence
- `package.json` scripts `release:verify:candidate`, `release:assemble:candidate`, and
  `release:accept:installed`
- focused release-runner tests

Behavior:

- raw builder output, validation fixtures, and final handoff are separate directories;
- unexpected build files are inventoried and classified before any copy; no delete-to-green;
- handoff assembly is unique-staged, exact-five-file checked, checksum verified, and atomically
  renamed with no clobber;
- installed replacement refuses symlink/ambiguous/running targets, creates and verifies a unique
  backup and sibling staging copy, uses rollback+atomic target rename, re-verifies the installed
  tree, and retains backup until acceptance completion;
- first launch is `/usr/bin/open` and pauses at Gatekeeper before any behavior;
- post-admission observation uses LaunchServices plus loopback CDP, never direct executable spawn;
- network observation combines the local redacting capture sink, `nettop`, DNS/network unified
  logs, refreshed descendant attribution, and CDP dialog/service inspection; any unattributed or
  attempted provider/model/credential/account traffic fails;
- exact Helper requirement and both permission states are probed before human TCC action; any
  pre-existing grant is non-fresh and blocks until manual System Settings removal and observed
  denial;
- packaged Helper launch, software Stop, restart, and physical input are recorded.

## 8. Behavior and regression tests

All commands use the repository-pinned Node wrapper unless running the mandated direct freshness
check.

| Area                      | Test/change                                                                                   | Required assertions                                                                                                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product Host              | update `packages/zcode-cua/test/packaging-boundary.test.mjs`; add focused product-host tests  | product Host is not unavailable; public entrypoints only; no stable-socket fallback; unused legacy exports still fail closed                                                                                                           |
| Packaged path             | extend `packages/services/test/localAlphaHomeIsolation.test.ts`                               | exact injected Helper and probe win; no copy under `ZCODE_HOME`; missing/wrong path fails closed                                                                                                                                       |
| Admission                 | existing `packages/zcode-cua/test/host-transport.test.mjs` plus product cases                 | launch token, exact launch contract, host/Helper/probe DR, reconnect and restart remain fail-closed                                                                                                                                    |
| Stop race                 | new `packages/services/test/cuaLeaseAuthority.test.ts` plus cross-process node-repl host test | service knows reservation before Helper acquire; acquire/Stop serialization; late commit fenced and Helper release forced; disconnect terminal; repeat Stop `already_stopped`                                                          |
| Sideband security         | new protocol/client/server tests in CUA/services/node-repl packages                           | `0700`/`0600`, auth failure, malformed/stale message, targeted MCP-only injection, stripped from Bash/tools/unrelated children, no session-event reuse                                                                                 |
| Renderer/Electron E2E     | `mise exec -- node scripts/mise-run.mjs pnpm --filter @zcode/desktop e2e:cua-alpha`           | safety copy; CUA default-off; no pre-lease Stop; active Stop; repeated Stop; released projection; test bridge requires build flag + run id                                                                                             |
| Data roots                | extend inventory + local-alpha behavior tests; add MCP/trajectory cases                       | production sentinel unread/unchanged; alpha file read; no `HOME`/`homedir()` fallback                                                                                                                                                  |
| Version/signing           | desktop script tests + validator fixtures                                                     | root version propagation, deterministic Helper build, stable app/Helper/probe identity, ad-hoc rejection, tamper rejection                                                                                                             |
| Artifacts                 | validator + assembler tests                                                                   | absolute build/validation paths match; full raw inventory before copy; exact DMG name; unexpected build files preserved; validation fixture is source of handoff; exact five handoff files; no-clobber atomic staging; checksums match |
| Install transaction       | installed-runner tests with temp sibling roots                                                | symlink/ambiguous/running target refusal; quit check; verified unique backup+stage; rollback on rename/copy/hash/signature failure; installed tree re-verified; backup retained                                                        |
| No-inference observation  | installed-runner observer tests and recorded live evidence                                    | local capture redacts secrets; child ancestry refreshed; `nettop` + DNS/network log + CDP active; missing/unattributed observer or attempted request fails; packaging downloads excluded by time boundary                              |
| Fresh TCC                 | installed-runner permission-preflight test + human record                                     | exact Helper DR recorded; pre-existing Accessibility/Screen Recording trust blocks; manual System Settings removal; observed denial before fresh grant; no `tccutil`                                                                   |
| Provenance/security       | validator tests                                                                               | absolute path, secret/private key, repository runtime dependency, `/tmp` dependency rejection                                                                                                                                          |
| CUA policy                | full `packages/zcode-cua/test/*.test.mjs` and existing native policy scripts                  | 130-test baseline plus updated product expectations; semantic and foreground policy remain green                                                                                                                                       |
| UI                        | new Desktop Playwright Electron E2E plus focused non-UI helpers                               | safety copy, opt-in, permission rows, active-only Stop, repeated Stop, released state, no onboarding change, `text-ui-*`                                                                                                               |
| Accounts/artifacts/remote | existing targeted suites from the audit                                                       | regression protection only; they do not substitute for installed acceptance                                                                                                                                                            |
| Installed app             | new runner + manual record                                                                    | exact `/Applications/AceVra.app`, isolated data, no inference/provider/account/credential request, updater off, Helper/Stop/restart                                                                                                    |

## 9. Build and release gates

`release/0.1.0-alpha.1/verification-plan.json` remains the base script inventory. The implementation
must add the E2E and handoff scripts to that inventory when their package scripts exist. Every gate
must be actually executed and recorded; unavailable or failed gates block acceptance.

### Mandatory pre-code governance

```bash
mise exec -- node scripts/mise-run.mjs pnpm architecture:check --changed
mise exec -- node scripts/mise-run.mjs pnpm architecture:context zcode-cua
mise exec -- node scripts/mise-run.mjs pnpm architecture:context services
mise exec -- node scripts/mise-run.mjs pnpm architecture:context desktop
mise exec -- node scripts/mise-run.mjs pnpm architecture:context ui
```

These run after the `cua-lease-authority` policy/spec design and before the first Phase 1 edit.
Their output is recorded in the worklog. A dirty baseline or unavailable context blocks code edits
until resolved or explicitly baselined without hiding new violations.

### Baseline and static gates

```bash
node scripts/check-workspace-freshness.mjs
mise exec -- node scripts/mise-run.mjs pnpm architecture:check --changed
mise exec -- node scripts/mise-run.mjs pnpm typecheck
mise exec -- node scripts/mise-run.mjs pnpm lint
mise exec -- node scripts/mise-run.mjs pnpm fmt:check
mise exec -- node scripts/mise-run.mjs pnpm verify:pre-push
mise exec -- node scripts/mise-run.mjs pnpm build
```

The current audit's lint/format failures in generated candidate files are not source-test passes.
After the bounded generated-output exclusion is implemented, these commands must pass on the
implementation tree; do not suppress the two generated `max-lines` errors in source.

### Focused tests

```bash
mise exec -- node scripts/mise-run.mjs node --test packages/zcode-cua/test/*.test.mjs
mise exec -- node scripts/mise-run.mjs node --import tsx --test \
  apps/zcode-cli/packages/node-repl-host/test/cua-lease-authority-bridge.test.ts \
  packages/services/test/cuaLeaseAuthority.test.ts
mise exec -- node scripts/mise-run.mjs node --test scripts/release/*.test.mjs
mise exec -- node scripts/mise-run.mjs pnpm --filter @zcode/desktop e2e:cua-alpha
mise exec -- node scripts/mise-run.mjs bash packages/zcode-cua/native/cua-helper/run-foreground-policy-tests.sh
mise exec -- node scripts/mise-run.mjs bash packages/zcode-cua/native/cua-helper/run-semantic-policy-tests.sh
mise exec -- node scripts/mise-run.mjs node --import tsx --test \
  packages/services/test/dataBaseDirResolution.test.ts \
  packages/services/test/localAlphaHomeIsolation.test.ts \
  packages/services/test/directHomeReaderInventory.test.ts \
  packages/services/test/cuaHardenedRuntimeBoundary.test.ts \
  packages/services/test/cuaScreenCaptureProbeState.test.ts
```

The exact new paths above are required, not placeholders. MCP/trajectory behavior tests are added
to the services command and recorded when created; no narrower static inventory substitutes for the
production-sentinel behavior tests.

### Build, validation fixture, and five-file handoff

Resolve all paths from the repository root before invoking the bundle. `ZCODE_DESKTOP_DIST_DIR`
must be absolute because `bundle.mjs` resolves relative values from `packages/desktop`, while the
release validator resolves its inputs from the repository root:

```bash
ALPHA_ROOT="$PWD/release/0.1.0-alpha.1"
BUILD_DIR="$ALPHA_ROOT/build"
VALIDATION_DIR="$ALPHA_ROOT/validation"
HANDOFF_DIR="$ALPHA_ROOT/handoff"

ZCODE_DESKTOP_RELEASE_PROFILE=local-engineering-alpha \
CUA_SIGNING_DIR=<absolute-isolated-directory> \
ZCODE_DESKTOP_DIST_DIR="$BUILD_DIR" \
mise exec -- node scripts/mise-run.mjs pnpm bundle:desktop -- --os mac --arch arm64
```

The command must set the signing switch and all alpha environment values internally or record the
exact additional environment before running. It must not use bare `--arm64`. It must refuse to
clobber an existing `BUILD_DIR`; unexpected build files are inventoried, never deleted to green.

After the validator is split into non-mutating verification/fixture creation and handoff assembly:

```bash
mise exec -- node scripts/mise-run.mjs pnpm release:verify:candidate -- \
  --build-dir "$BUILD_DIR" \
  --validation-dir "$VALIDATION_DIR" \
  --json

unzip -t "$VALIDATION_DIR/AceVra-0.1.0-alpha.1-arm64.zip"
hdiutil verify "$VALIDATION_DIR/AceVra-0.1.0-alpha.1-arm64.dmg"

mise exec -- node scripts/mise-run.mjs pnpm release:assemble:candidate -- \
  --validation-dir "$VALIDATION_DIR" \
  --handoff-dir "$HANDOFF_DIR"
```

The validator first inventories and checks every raw build file, then creates an isolated validation
fixture containing only verified app/archive copies and reports. The assembler copies only those
verified archives into `HANDOFF_DIR.staging-<run-id>`, generates the three sidecars, verifies exact
five-file contents/checksums, and atomically renames staging to `HANDOFF_DIR`. Existing validation,
staging, or handoff directories are refused; prior evidence is never overwritten implicitly.

### Installed gate

After the runner is implemented:

```bash
mise exec -- node scripts/mise-run.mjs pnpm release:accept:installed -- \
  --handoff "$HANDOFF_DIR" \
  --app /Applications/AceVra.app
```

`--handoff` is required; the runner must reject a raw build or validation directory. Replacement
still requires the no-clobber transaction and separate human approval described below.

## 10. Installed-app acceptance and human checkpoints

### No-clobber replacement transaction

1. Resolve `/Applications` and the target without following a target symlink. Record existing app
   version, identity, DR, owner/mode, tree hash, and provenance. Ambiguous provenance stops.
2. Require the app and exact-path Helper/Agent children to be fully quit. The runner never force-
   quits or overwrites a running target.
3. From the verified validation app fixture, create uniquely named sibling backup and staging paths
   with runner-owned markers. Never use recursive deletion on the target.
4. Verify backup and staging tree hashes, identities, architectures, owner/mode, and strict
   signatures before touching `/Applications/AceVra.app`.
5. Rename the existing target to a unique rollback sibling, then atomically rename staging into the
   target. If either rename fails, restore rollback before exiting.
6. Re-verify the installed tree against the validation manifest. Keep backup/rollback until all
   acceptance finishes. Failure restores the original; success requires a separate human decision
   before backup removal.

### Fail-closed observation setup

The observation window starts before the first `/usr/bin/open` and ends after the final physical
input. Packaging/dependency downloads are outside this window and recorded separately.

- start the existing local `NetworkCaptureService` sink from
  `apps/zcode-cli/packages/debug/server/network-capture.ts`; extend its evidence record to request
  class, host, redacted path, and byte counts only, with no bodies and with URL userinfo/query plus
  authorization/cookie/API-key redaction; LaunchServices receives its values through
  `open --env ZCODE_HTTP_PROXY=<sink> --env ZCODE_AGENT_CA_CERT=<ca>`;
- start
  `/usr/bin/nettop -L 0 -s 0.1 -j pid,process,state,interface,bytes_in,bytes_out` for all
  TCP/UDP sockets and `/usr/bin/log stream --style ndjson` with a fixed DNS/network-service
  predicate;
- refresh app/descendant PID ancestry from `ps -axo pid=,ppid=,command=`, attribute socket rows to
  the installed process tree, and treat unattributed external activity during the window as failure;
- after Gatekeeper admission only, relaunch through `/usr/bin/open --env ... -a ... --args
--remote-debugging-port=<loopback-port>` and attach Playwright over CDP for dialog/service
  inspection;

- any observer start/attach/collection failure, ambiguous attribution, DNS/TCP/TLS attempt,
  provider/model request, credential prompt, or account authentication fails acceptance even when
  the request never completes.

### Ordered checkpoints

1. **Static installed verification:** after replacement, compare installed hash/signature/DR to the
   validation manifest. No app launch yet.
2. **Gatekeeper human checkpoint:** invoke exactly
   `/usr/bin/open --env ZCODE_HTTP_PROXY=<sink> --env ZCODE_AGENT_CA_CERT=<ca>
/Applications/AceVra.app` (never `Contents/MacOS/AceVra` directly), record the expected rejection,
   and pause for Finder/System Settings **Open Anyway**. No data, idle/network,
   TCC, Helper, Stop, or physical behavior is measured before this admission. If the expected
   first-launch rejection is not observed, mark Gatekeeper evidence non-fresh and block acceptance.
3. **Exact installed process observation:** after admission, use LaunchServices plus loopback CDP;
   verify the observed executable path is the installed app. Direct binary spawn is forbidden.
4. **Fresh TCC preflight:** start the exact signed Helper in non-prompting permission probe mode;
   record its DR and Accessibility/Screen Recording status. If either is already trusted, mark the
   proof non-fresh and block.
5. **TCC human decision:** if fresh, grant only `AceVra Computer Use.app` through System Settings.
   If contaminated, the human must manually remove the existing entry, restart the Helper, and
   show observed denial before fresh authorization. No `tccutil`; declining removal is an explicit
   human decision that leaves acceptance blocked.
6. **Data/updater/no-inference:** seed non-secret production sentinels, measure idle, opt-in,
   packaged Helper/probe launch, and restart; prove alpha roots only, unchanged sentinels, no update
   activity, and zero attempted provider/model/credential/account traffic under the observers above.
7. **Packaged CUA:** verify automatic packaged resource resolution, exact Helper identity, semantic
   observation, and explicit foreground lease.
8. **Software Stop human checkpoint:** activate a harmless real lease, press Stop, press Stop
   again, and verify `already_stopped`, held-input cleanup, disabled tap, released exclusion, and
   no later input.
9. **Physical input human checkpoint (final boundary):** move the real mouse and press/release real
   Shift during a lease; verify interruption, defensive key-up, tap disable, exclusion release, and
   no later post.

Planning stops at the physical-input checkpoint. Backup retention/deletion is an explicit human
decision after recorded success; no public distribution, notarization, or additional platform work
follows.

## 11. Smallest release-safety UX

The minimum acceptable UI is intentionally smaller than a new onboarding flow:

- one compact safety block in the existing Computer Use settings page;
- CUA remains off by default;
- existing Accessibility and Screen Recording rows identify the Helper by exact name;
- one Stop control appears only for an active authoritative lease;
- copy states local alpha, self-signed, non-notarized, isolated root, updates disabled, and no
  provider/inference activity during verification;
- touched stale `ZCode` user-visible release-safety copy becomes `AceVra`, while internal `@zcode`
  and `zcode://` identifiers remain unchanged;
- no speculative Input Monitoring request, provider onboarding, account migration, or remote CUA.

## 12. Known blockers

Release is blocked until all are closed:

1. Product CUA runtime still reports unavailable despite packaged Helper/probe payloads.
2. Services cannot discover the injected packaged Helper/probe without manual staging.
3. Outer app is ad-hoc; the bundle wrapper does not enable the required stable app signature, and
   the validator misses successful `codesign -d/-dv` stderr.
4. Archive names do not match the required alpha contract.
5. `helper-build-info.json` leaks a developer absolute path.
6. x64 packaging can receive an arm64-only Helper; alpha must reject non-arm64 targets.
7. Relative `ZCODE_DESKTOP_DIST_DIR` currently makes bundle and validator resolve different paths.
8. Raw builder output, validation fixture, and exact five-file handoff are not separated or
   atomically assembled; existing blockmaps/update metadata prove delete-to-green would be wrong.
9. MCP sync and model trajectory can read production home roots.
10. The node-repl MCP process has no authenticated lifecycle bridge to a service-owned lease
    authority; runtime `activeLeases` cannot implement software Stop.
11. Native release idempotency is bounded to 30 seconds; service-level Stop idempotency is absent.
12. Exclusive physical control uses a replaceable `/tmp` pathname.
13. No runnable Desktop renderer/Electron E2E exists for the active-only/repeated Stop interaction.
14. No installed runner, no-clobber `/Applications` transaction, or fail-closed multi-observer
    no-inference boundary exists.
15. Gatekeeper-first LaunchServices launch, fresh TCC preflight/removal, exact installed process
    observation, software Stop, physical input, and restart are unproven.
16. Current lint/format runs include generated candidate files and fail; generated output must be
    excluded without weakening source lint policy.
17. Existing `/Applications/AceVra.app` provenance/quit/backup/replacement decision is unknown.
18. Peer-builder and Electron Builder comments still misstate packaging/signing status and must be
    corrected in Phase 2.

## 13. Unresolved human/product decisions

These are intentionally not guessed by automation:

- existing `/Applications/AceVra.app` provenance, whether it may be replaced, and backup retention
  after successful acceptance
- the human Gatekeeper **Open Anyway** decision
- whether to remove a contaminated pre-existing TCC entry; declining leaves fresh-TCC acceptance
  blocked
- removal of the verified backup after all checks pass
- selection of a kernel-backed physical exclusion primitive; if no design satisfies the security
  proof, release remains blocked rather than narrowing the claim

## 14. Approved non-goals

- Developer ID, notarization, stapling, Mac App Store, public DMG distribution, or public updater
- push, tag, merge, npm/GitHub/GitLab release, or generic localhost publish feed
- Windows, Linux, Intel/x64, universal, VM, private desktop, or remote/mobile CUA
- CUA-4/CUA-5, Input Monitoring prompts, clipboard/process-control expansion, or provider/model
  capability expansion
- account/provider migration, authentication changes, provider inference, or model requests during
  packaging/install acceptance
- renaming `@zcode`, `zcode://`, service/protocol names, Preview compatibility, or broad visible
  ZCode-to-AceVra cleanup beyond touched release-safety surfaces
- notarization/distribution workarounds, Gatekeeper bypasses, `xattr` removal, `tccutil` grants, or
  synthetic substitution for human physical input
