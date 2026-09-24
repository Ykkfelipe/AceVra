# AceVra 0.1.0-alpha.1 release worklog

Date: 2026-09-23  
Branch: `release/0.1.0-alpha`  
Phase: **implementation in progress; candidate not accepted**

## Current status

The root version, local profile, signed native payloads, and an initial arm64 bundle already exist,
so the earlier “pre-implementation / ahead 0” status is stale. A historical build ended with
`BUILD_EXIT=0`, but the resulting candidate is rejected: its archive names are wrong, packaged
native provenance contains a developer absolute path, the outer app is ad-hoc signed, the product
CUA runtime remains unavailable, and no installed acceptance has run.

The implementation authority is:

- `packages/desktop/specs/release-0.1.0-alpha.1.md`
- `packages/zcode-cua/specs/computer-use.md`
- `release/0.1.0-alpha.1/release-plan.md`

No product implementation was started in this consolidation. Only the release/CUA specifications,
this worklog, and the release plan were updated.

## Freshness and repository state

Executed during this critique revision:

```text
$ node scripts/check-workspace-freshness.mjs
exit 0
stdout: [freshness] 基线新鲜：release/0.1.0-alpha，相对 origin/main：ahead 3 / behind 0（阈值 50）
stderr: [freshness] release/0.1.0-alpha 没有远端跟踪分支，跳过 behind-remote 检查（是否忘了 push -u？）
```

The branch has no configured upstream. This is not push, tag, merge, or publication approval.

Pre-existing local state preserved:

- modified generated declaration maps under
  `apps/zcode-cli/packages/node-repl-host/dist-types/`
- untracked `.zcodeignore`
- untracked `packages/desktop/resources/`
- untracked `release/`

The generated candidate/build evidence is not accepted merely because the directory exists.

## Consolidated architecture map

```text
package.json 0.1.0-alpha.1
  -> desktop release profile + early bootstrap
     -> Electron roots + services data/model-I/O roots + updater disabled
  -> build metadata
     -> app/Helper version + deterministic Helper build/signing facts
  -> bundle.mjs [absolute build directory]
     -> isolated self-signed keychain
     -> product Helper + peer probe
     -> Electron Builder
        -> release/.../build/{raw app, archives, blockmaps, update metadata}
  -> verify-local-alpha-candidate.mjs [same absolute build directory]
     -> inventory-before-mutation
     -> structure/signature/provenance/content verification
     -> release/.../validation/{verified fixtures + reports}
  -> assemble-local-alpha-handoff.mjs
     -> unique staging -> exact five files -> atomic no-clobber handoff

installed AceVra.app
  -> /usr/bin/open -> Gatekeeper/Open Anyway before any behavior
  -> Desktop main injects packaged native paths
  -> services product boundary + hardened session + native peer verifier
  -> AceVra Computer Use.app
  -> private authenticated lease-authority sideband
     -> node-repl CUA runtime begin/commit/release
     -> service-authoritative generation/terminal record
  -> existing settings UI: opt-in, TCC, active Stop, release warnings
```

### Owners

| Fact/state                                 | Authority                                                         |
| ------------------------------------------ | ----------------------------------------------------------------- |
| Root release version                       | `package.json` / build metadata                                   |
| Release profile and default roots          | `desktop-release-profile.mjs` + early Desktop bootstrap           |
| User-level service data                    | `packages/services/src/paths.ts` canonical path authority         |
| Raw build output                           | one absolute `release/.../build/` path shared by bundle/validator |
| Verified fixtures                          | no-clobber `release/.../validation/` created from raw evidence    |
| Final handoff                              | no-clobber `release/.../handoff/` created by atomic staging       |
| Packaged Helper/probe location             | Desktop main under `process.resourcesPath`; verified by services  |
| Helper TCC identity                        | signed `AceVra Computer Use.app`                                  |
| Lease lifecycle bridge                     | private authenticated services/node-repl sideband                 |
| Foreground lease/generation/terminal state | managed services `cua-lease-authority`                            |
| Physical held input/event tap/exclusion    | signed Helper only                                                |
| Candidate acceptance                       | validator/assembler plus recorded human checkpoints               |

The model-facing runtime may project control status, but it cannot remain the lease authority. The
current in-memory `activeLeases` map is at `packages/zcode-cua/index.js:40-64,153-165,192-198`, and
the runtime is constructed in a separate MCP process at
`apps/zcode-cli/packages/node-repl-host/src/server.ts:376-386`.

### Required event order

```text
local task -> canonical Computer tool in node-repl MCP process
  -> authenticated sideband begin_acquire -> service generation reservation
  -> packaged Helper/probe verification + peer-bound admission
  -> Helper physical exclusion + event tap + exclusive lease
  -> authenticated sideband commit_acquire -> service active record -> UI projection
  -> bounded action
  -> Stop | release_control | physical interruption | runtime/Helper disconnect
  -> old generation fenced
  -> defensive key/mouse-up cleanup -> tap disabled -> exclusion released
  -> service terminal record -> released UI projection
```

The sideband uses a per-service random capability with constant-time comparison, same-UID peer
validation, a private `0700`/`0600` local socket, and targeted injection only into the official CUA
MCP server; it is stripped from Bash/tools/unrelated children. Existing ZCode operation events are
turn/tool projections and are not a lease transport, so this plan does not change
`packages/shared/src/zcode-protocol/index.ts`. A Stop that fences an in-flight reservation rejects
the late commit and forces immediate Helper release.

## Current identities

| Surface                | Current identity                                                                                                                                         | Alpha decision                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Root/app version       | `0.1.0-alpha.1` at `package.json:1-3`                                                                                                                    | Preserve exactly.                                     |
| Profile                | `local-engineering-alpha`                                                                                                                                | Filesystem/environment profile only.                  |
| Production app         | `com.acevra.desktop` / `AceVra` at `packages/desktop/scripts/desktop-product-identity.mjs:9-16`                                                          | Keep; alpha rejects Preview.                          |
| Preview app            | `com.acevra.desktop.preview` / `AceVra Preview` at `packages/desktop/scripts/desktop-product-identity.mjs:18-25`                                         | Existing builds only; no alpha rename.                |
| Product Helper         | `dev.acevra.cua-helper` / `AceVra Computer Use.app` / `AceVraComputerUse` at `packages/zcode-cua/native/cua-helper/build-product-helper.mjs:26-30,46-60` | Package exactly.                                      |
| Development Helper     | `dev.acevra.cua-helper.development` / `AceVra Computer Use Dev.app`                                                                                      | Harness only; never relabeled product/Developer ID.   |
| Peer probe             | `dev.acevra.cua-peer-identity.development` at `packages/zcode-cua/native/peer-identity/build-peer-identity-probe.mjs:31-33`                              | Preserve exactly.                                     |
| Signing identity       | isolated self-signed `AceVra CUA Dev Signing`                                                                                                            | Stable local app/Helper/probe root; not Developer ID. |
| Internal compatibility | `@zcode/*`, `zcode://`, service/protocol names                                                                                                           | No rename.                                            |

Current source has `zcode-cua` in `architecture-policy.yaml:73-82`; an audit statement that the
module is absent is stale. It is currently `managed: false`, as are the broad services/desktop/UI
modules. Before the first implementation edit, the plan now requires `architecture:check --changed`
plus controlled context packages for `zcode-cua`, `services`, `desktop`, and `ui`, then a bounded
managed `cua-lease-authority` module with an explicit public contract, layers, owner, and dependency
direction. The whole legacy CUA package is not flipped managed without a baseline-aware boundary.

## Native design and current evidence

### Current packaged payloads

- bundle wrapper builds native components at
  `packages/desktop/scripts/bundle.mjs:438-517`
- staging root is `packages/desktop/resources/cua-helper`
- Electron Builder embeds it at `Contents/Resources/cua-helper` through
  `packages/desktop/electron-builder.config.js:608-615`
- `signIgnore` preserves nested signatures at `:704-710`
- current app, Helper, and probe payloads exist in the candidate

The payloads are not yet a working installed product path:

- product installer rejects at `packages/zcode-cua/broker-server.js:23-27`
- product Host is unavailable at `packages/zcode-cua/broker-server.js:100-130`
- packaged product-path resolution is a placeholder test expectation at
  `packages/zcode-cua/test/packaging-boundary.test.mjs:17-37`
- Desktop injects the Helper path at
  `packages/desktop/src/main/desktopRuntimeEnv.ts:509-528,586-588`
- services Helper/probe discovery only checks `ZCODE_HOME` candidates at
  `packages/services/src/cua-permission-broker/darwinCuaHelperTransport.ts:63-103`

Required design: automatically launch the exact installed packaged Helper/probe, pin verified
requirements, and require no user copy into `ZCODE_HOME`. Do not fall back to the legacy stable
socket.

### Signing

Current builder behavior:

- main-app signing is enabled only with `ZCODE_ENABLE_MAC_SIGN=1` plus identity at
  `packages/desktop/electron-builder.config.js:82-86,208-216`
- bundle resolves/unlocks the isolated keychain and passes signing variables at
  `packages/desktop/scripts/bundle.mjs:390-421`, but does not set `ZCODE_ENABLE_MAC_SIGN=1`
- notarization is intentionally disabled at
  `packages/desktop/electron-builder.config.js:690-695`
- candidate inspection in the supplied audit found `Signature=adhoc` on the outer app while the
  Helper/probe carried the local identity

Required design: sign the outer app, Helper, and probe with the same isolated local certificate
root; preserve each identifier; reject ad-hoc/missing/mismatched/tampered signatures. This is not
Developer ID, notarization, a staple, or Apple distribution approval.

### Architecture and provenance

- product Helper builder supports arm64/x86_64/universal at
  `packages/zcode-cua/native/cua-helper/build-product-helper.mjs:94-107`
- bundle hard-codes arm64 at `packages/desktop/scripts/bundle.mjs:474-485`
- alpha packaging must reject x64/universal rather than embed the wrong Helper
- builder output includes absolute `appPath` at
  `packages/zcode-cua/native/cua-helper/build-product-helper.mjs:204-215`
- bundle copies it at `packages/desktop/scripts/bundle.mjs:497-500`
- candidate scan rejects this developer path

Provenance may contain logical resource names, version/build, architecture, signature kind,
certificate fingerprint, and DR. It may not contain a developer absolute path.

Two comments are stale and must be corrected in the implementation's Phase 2, not preserved:

- `packages/zcode-cua/native/peer-identity/build-peer-identity-probe.mjs:6-8` says the probe is not
  wired into packaging, while `bundle.mjs` now packages it;
- `packages/desktop/electron-builder.config.js:703-704` describes Developer ID signing/stapling,
  while this alpha is self-signed and non-notarized.

### Physical exclusion

Current lock is `/tmp/acevra-cua-exclusive-<uid>.lock` at
`packages/zcode-cua/native/cua-helper/ForegroundControl.swift:147-159`. It validates owner/type/
link count/flock, but another same-uid process can unlink and recreate the pathname. The release
claim of process-wide physical serialization therefore remains blocked.

Implementation must first prove a kernel-backed exclusion that cannot be replaced this way, releases
on all terminal paths, and is covered by contention/replacement/disconnect/cleanup tests. A new
user-writable file path is not an acceptable fix.

### Security controls to preserve

- token-gated host relay
- host-owned listening socket
- exact launch contract
- stable host, Helper, and probe designated requirements
- native peer verifier using socket audit token plus PID/credential cross-checks
- strict bundle validation and runtime flags
- local desktop-only foreground capability
- passive event tap; interruption on unmarked/other-process events
- geometry/focus/secure-field revalidation
- bounded input and defensive held-input cleanup

The existing `localAlphaHomeIsolation.test.ts:60-74` proves only `ZCODE_HOME` candidates and must be
replaced/extended for exact packaged resource discovery.

## Data roots

| Data                   | Alpha default                                                          |
| ---------------------- | ---------------------------------------------------------------------- | --- | -------------- |
| Electron user data     | `~/Library/Application Support/AceVra Local Engineering Alpha`         |
| Electron session       | `~/Library/Application Support/AceVra Local Engineering Alpha/session` |
| Profile/service base   | `~/.zcode-local-engineering-alpha`                                     |
| Service settings/state | `~/.zcode-local-engineering-alpha/.zcode/v2`                           |
| Host `ZCODE_HOME`      | `~/.zcode-local-engineering-alpha/.zcode`                              |
| CUA root               | `~/.zcode-local-engineering-alpha/.zcode/computer-use`                 |
| Model I/O              | `~/.zcode-local-engineering-alpha/.zcode/cli/{debug,rollout}`          |
| MCP user data          | canonical profile home's `.zcode`/`.agents` only                       |
| Workspace data         | `workspacePath`; identity key `workspaceIdentity?.trim()               |     | workspacePath` |

Defaults/precedence source: `packages/desktop/scripts/desktop-release-profile.mjs:67-131`.
Early bootstrap source: `packages/desktop/src/main/desktopDataBaseDirBootstrap.ts:58-67`.

Remaining confirmed isolation gaps:

- MCP sync resolves user scope from `HOME`/`USERPROFILE` at
  `packages/services/src/mcp-sync/mcpSyncService.ts:148-165`
- model trajectory searches `homedir()/.zcode/cli` before the data base at
  `packages/services/src/zcode-agent/modelTrajectoryFileTail.ts:15-20`, and consumes all returned
  roots at `packages/services/src/zcode-agent/modelTrajectory.ts:33-98`
- current direct-home inventory at
  `packages/services/test/directHomeReaderInventory.test.ts:13-36` omits both readers

Required proof: production sentinel is unread and byte-for-byte unchanged while the same operation
reads/writes the alpha file. Static source inventory is supporting evidence, not acceptance.

## Release outputs

The implementation now separates three no-clobber directories:

- `release/0.1.0-alpha.1/build/`: raw builder app/archive/blockmap/update metadata; inventory and
  validate, never delete unexpected files to green
- `release/0.1.0-alpha.1/validation/`: verified app/archive copies plus non-secret validation/source
  inventory reports
- `release/0.1.0-alpha.1/handoff/`: final exact-five-file release output

The exact required DMG is **`AceVra-0.1.0-alpha.1-arm64.dmg`**. Final `handoff/` contains exactly:

```text
AceVra-0.1.0-alpha.1-arm64.dmg
AceVra-0.1.0-alpha.1-arm64.zip
build-info.json
RELEASE_NOTES.md
SHA256SUMS.txt
```

The assembler copies only the two verified archives from `validation/` into a unique sibling staging
directory, generates the three sidecars, checks the exact allowlist/checksums, and atomically renames
staging to `handoff/`. Existing validation/staging/handoff directories are refused rather than
clobbered. `latest-mac.yml`, blockmaps, and the unpacked app may remain only as raw/validation
evidence because the alpha updater is disabled.

The current raw candidate additionally proves why separation is required: it contains
`*-mac-arm64.dmg`, its blockmap, `*-mac-arm64.zip`, its blockmap, `builder-debug.yml`, and
`latest-mac.yml`. Current validation also fails because `helper-build-info.json` contains a
developer absolute path and the signature-detail logic misses successful `codesign -dv` stderr.

`bundle.mjs` resolves `ZCODE_DESKTOP_DIST_DIR` from `packages/desktop`, whereas the validator
resolves `--dist` from the repository root. The revised command therefore uses one absolute
`$PWD/release/0.1.0-alpha.1/build`; the relative value in the prior plan was wrong. A path-resolution
test must prove builder, validator, reports, and installed runner consume the same build/validation
manifest.

ZIP `unzip -t`, DMG `hdiutil verify`, and historical `BUILD_EXIT=0` remain supporting evidence only.

## Required verification inventory

`release/0.1.0-alpha.1/verification-plan.json` contains the approved script inventory:

```json
{
  "scripts": [
    "typecheck",
    "lint",
    "fmt:check",
    "architecture:check",
    "verify:pre-push",
    "build",
    "release:verify:candidate"
  ],
  "packageScript": "bundle:desktop"
}
```

Verification plan updated in `release/0.1.0-alpha.1/verification-plan.json` with the exact root
package scripts plus the Desktop CUA E2E command and focused test commands. The accepted
implementation is not a candidate until the remaining gates below pass.

Executed during this gate-fix revision:

- `node scripts/check-workspace-freshness.mjs` — exit 0; ahead 6 / behind 0, no upstream
- `mise exec -- node scripts/mise-run.mjs pnpm architecture:check` — exit 0; violations 0, baseline 0, new 0
- `mise exec -- node scripts/mise-run.mjs pnpm typecheck` — exit 0
- `mise exec -- node scripts/mise-run.mjs pnpm lint` — exit 0; 75 warnings, 0 errors
- `mise exec -- node scripts/mise-run.mjs pnpm verify:pre-push` — exit 0
- `mise exec -- node scripts/mise-run.mjs pnpm build` — exit 0 under pinned Node 24.14.0
- `pnpm build` — exit 0 under the current environment's Node 26.9.0; this is not the pinned release
  toolchain and is supporting evidence only
- `mise exec -- node scripts/mise-run.mjs pnpm fmt:check` — exit 1; 42 pre-existing unrelated files
  remain unformatted; no unrelated files were changed
- `mise exec -- node scripts/mise-run.mjs node --test packages/zcode-cua/test/*.test.mjs
packages/desktop/scripts/macos-window-bounds-targets.test.mjs` — exit 0; 132 tests passed
- `mise exec -- node scripts/mise-run.mjs node --test scripts/release/alpha-bundle-env.test.mjs` —
  exit 0; 1 test passed
- `pnpm bundle:desktop -- --os mac --arch arm64` — exit 1; the release profile was applied, but
  the isolated signing keychain is unavailable
- `mise exec -- node scripts/mise-run.mjs pnpm release:verify:candidate` — exit 1; no current
  `release/0.1.0-alpha.1/build/` candidate exists
- `mise exec -- node scripts/mise-run.mjs pnpm release:assemble:candidate` — not run to completion:
  no validation fixture exists
- `mise exec -- node scripts/mise-run.mjs pnpm release:accept:installed` — not run: no handoff and no
  installed-app acceptance arguments/checkpoints exist
- `git diff --check` — exit 0

The release scripts remain fail-closed when their required artifact, argument, signature, or human
checkpoint is absent. No gate is reported as passed from a dry run or an unrun command.

## Installed-app acceptance and final human checkpoints

The implementation must add `scripts/release/accept-local-alpha-installed.mjs` and
`release:accept:installed`; it consumes only `handoff/`, never raw `build/`.

Replacement is a no-clobber transaction: refuse symlink/ambiguous/running targets; require a fully
quit app; create and verify unique sibling backup and staging copies; rename the original to a unique
rollback sibling; atomically rename staging into `/Applications/AceVra.app`; re-verify the installed
tree; and retain backup/rollback through acceptance. Any failure restores the original. Backup
removal is a separate human decision after success.

The fail-closed observation window combines the existing `NetworkCaptureService` sink, extended to
record request class/host/redacted path/byte counts only with no bodies and URL query/userinfo plus
credential redaction (passed with
`open --env ZCODE_HTTP_PROXY=<sink> --env ZCODE_AGENT_CA_CERT=<ca>`),
`/usr/bin/nettop -L 0 -s 0.1 -j pid,process,state,interface,bytes_in,bytes_out`, fixed-predicate
`/usr/bin/log stream --style ndjson`, `ps -axo pid=,ppid=,command=` descendant attribution, and
post-Gatekeeper LaunchServices/CDP dialog inspection. Observer failure, unattributed activity, or
any attempted provider/model/DNS/TCP/TLS/credential/account flow fails acceptance. Packaging
downloads occur before this window and are recorded separately.

Ordered human checkpoints:

1. static installed hash/signature/DR comparison; no launch
2. first launch only through `/usr/bin/open --env ... /Applications/AceVra.app`; record the
   expected Gatekeeper rejection and pause for **Open Anyway** before any behavior; absence of the
   expected rejection is non-fresh and blocks acceptance
3. after admission, relaunch through `/usr/bin/open -a ... --args
--remote-debugging-port=<loopback-port>` and attach CDP; never directly spawn the executable
4. preflight the exact Helper DR and both TCC states; a pre-existing trusted grant is non-fresh and
   blocks
5. if contaminated, manually remove the Helper entry in System Settings, restart Helper, observe
   denial, then freshly authorize Accessibility/Screen Recording; no `tccutil`
6. measure data isolation, updater inactivity, no-inference, packaged Helper launch, and restart
7. software Stop on a harmless real lease, repeated Stop, cleanup/no later posts
8. final physical input: real mouse movement and real Shift press/release; verify interruption and
   cleanup

Synthetic events test classification only and cannot satisfy the physical-input checkpoint.

The separate renderer/Electron E2E is mandatory before installed acceptance:

```bash
mise exec -- node scripts/mise-run.mjs pnpm --filter @zcode/desktop e2e:cua-alpha
```

It covers safety copy, CUA default-off, no pre-lease Stop, active Stop, repeated Stop, and released
projection. The repository currently has no such runnable script, so implementation must add the
runner and package script rather than substituting component/manual tests.

## Smallest release-safety UX

No new onboarding step and no automatic CUA enablement. Add one compact block to the existing
Computer Use settings page stating local-alpha, self-signed/non-notarized, isolated-root,
updates-disabled, and no provider/inference verification activity. Reuse the current permission
rows. Show one active-lease-only **Stop computer control** button; repeated Stop is safe and the
released projection hides/disables it. Replace touched stale `ZCode` release-safety copy with
`AceVra` and use `text-ui-*`; do not rename internal compatibility.

`OnboardingWelcomeView.tsx` and its unrelated `text-4xl` defect are removed from release scope and
require a separate spec-first change.

## Known blockers

1. Packaged product CUA runtime is fail-closed.
2. Services cannot resolve injected packaged Helper/probe without manual staging.
3. Outer app is ad-hoc; bundle does not enable the stable app signature.
4. Validator reads successful `codesign -dv` details from the wrong stream.
5. Archive names violate the alpha contract.
6. Packaged native provenance leaks an absolute developer path.
7. Non-arm64 alpha targets can receive an arm64 Helper.
8. Relative `ZCODE_DESKTOP_DIST_DIR` makes bundle and validator resolve different directories.
9. Raw build, validation fixture, and exact five-file handoff are not separated/atomically assembled.
10. MCP sync and model trajectory can cross into production home roots.
11. The separate node-repl runtime has no authenticated lifecycle bridge to a service lease authority.
12. No service-authoritative software Stop state or Stop UI exists.
13. Native release replay is only 30 seconds; user-facing Stop idempotency is undefined.
14. Physical exclusion depends on a replaceable `/tmp` pathname.
15. No runnable Desktop renderer/Electron Stop E2E exists.
16. Installed runner, no-clobber replacement, and fail-closed multi-observer no-inference boundary do
    not exist.
17. Gatekeeper-first LaunchServices launch, fresh TCC, exact process observation, Stop, physical
    input, and restart are unproven.
18. Existing lint/format failures include generated candidate content; generated output must be
    excluded without weakening source policy.
19. Existing `/Applications/AceVra.app` provenance/quit/backup/replacement decision is unknown.
20. Peer-builder and Electron Builder comments misstate current packaging/signing status.

## Unresolved human/product decisions

- provenance/replacement/backup retention for an existing `/Applications/AceVra.app`
- human Gatekeeper **Open Anyway** action
- whether to remove a contaminated TCC entry; declining keeps fresh-TCC acceptance blocked
- backup deletion after successful acceptance
- acceptable kernel-backed physical exclusion design; failure to prove one keeps release blocked

## Approved non-goals

- Developer ID, notarization, staple, Mac App Store, public DMG distribution, or public updater
- push, tag, merge, npm/GitHub/GitLab release, or localhost publish feed
- Windows/Linux native CUA, Intel/x64/universal alpha, VM/private desktop, remote/mobile CUA
- CUA-4/CUA-5, Input Monitoring prompts, clipboard/process control, or provider/model expansion
- account/provider migration, authentication changes, provider inference, or model requests during
  packaging/install acceptance
- broad ZCode-to-AceVra rename, `@zcode` rename, `zcode://` change, or Preview compatibility removal
- Gatekeeper/TCC bypasses or synthetic substitution for the physical-input checkpoint
