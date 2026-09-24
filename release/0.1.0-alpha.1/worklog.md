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

Executed during this review-blocker implementation revision:

- `node scripts/check-workspace-freshness.mjs` — exit 0; ahead 6 / behind 0, no upstream
- `mise exec -- node scripts/mise-run.mjs pnpm architecture:check` — exit 0; violations 0, baseline 0, new 0
- `mise exec -- node scripts/mise-run.mjs pnpm typecheck` — exit 0
- `mise exec -- node scripts/mise-run.mjs pnpm --dir apps/zcode-cli/packages/node-repl-host build` — exit 0
- `mise exec -- node scripts/mise-run.mjs pnpm --dir apps/zcode-cli/packages/bootstrap build` — exit 0
- `mise exec -- node scripts/mise-run.mjs pnpm lint` — exit 0; 76 warnings, 0 errors
- `mise exec -- node scripts/mise-run.mjs pnpm build` — exit 0 under pinned Node 24.14.0
- `mise exec -- node scripts/mise-run.mjs pnpm --filter @zcode/desktop build:no-runtime-assets` —
  exit 0; current desktop renderer/main rebuilt for E2E
- `mise exec -- node scripts/mise-run.mjs pnpm fmt:check` — not rerun after the final source
  changes; prior result remains exit 1 for 42 unrelated files
- `mise exec -- node scripts/mise-run.mjs pnpm exec oxfmt --check <changed release files>` — exit 0
- `mise exec -- node scripts/mise-run.mjs node --import tsx --test
packages/services/test/leaseAuthorityServer.test.ts packages/services/test/cuaLeaseAuthority.test.ts
packages/zcode-cua/test/packaging-boundary.test.mjs` — exit 0; 7 tests passed
- `xcrun swiftc -swift-version 5 -O -target arm64-apple-macos12.0 ... ForegroundControl sources` —
  exit 0; changed native Helper sources compile
- `ZCODE_DESKTOP_E2E=1 ZCODE_DESKTOP_E2E_RUN_ID=acevra-alpha-local-001 mise exec -- node
scripts/mise-run.mjs pnpm --filter @zcode/desktop e2e:cua-alpha` — exit 1; Playwright launched
  Electron but the built renderer body was empty, so the required safety/stop assertions were not
  accepted
- `pnpm bundle:desktop -- --os mac --arch arm64` — exit 1; local signing keychain is unavailable
- `mise exec -- node scripts/mise-run.mjs pnpm release:verify:candidate` — exit 1; no current
  `release/0.1.0-alpha.1/build/` candidate exists
- handoff assembly and installed acceptance — not run; no validated handoff or installed app
- `git diff --check` — exit 0

Unresolved human checkpoints remain Gatekeeper **Open Anyway**, fresh TCC denial/grant, installed
Helper/CUA, software Stop, and real mouse/Shift physical interruption. None are fabricated.

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

## Installed acceptance execution — 2026-09-23/24

**Result: BLOCKED / not an accepted installed release.** The generated DMG was installed and the
installed app was exercised, but the candidate is not releasable and several acceptance gates were
not runnable. No provider inference, account authentication, source checkout, development server,
Swift compiler, permission mutation, synthetic physical input, publish, push, tag, or merge was
performed.

### 1. Baseline, provenance, and install

- `node scripts/check-workspace-freshness.mjs` — exit 0. Output: `基线新鲜：release/0.1.0-alpha，相对 origin/main：ahead 7 / behind 0（阈值 50）`; the command also reported no configured upstream.
- Before installation, `/Applications/AceVra.app` did not exist: `/usr/bin/stat`/inspection command
  printed `NO_EXISTING_ACEVRA_APP`. Therefore there was no existing provenance to resolve and no
  backup/replacement transaction was needed.
- Candidate path was `release/0.1.0-alpha.1/candidate/AceVra-0.1.0-alpha.1-mac-arm64.dmg`.
  `file` reported `zlib compressed data`; `shasum -a 256` reported
  `3d730c0870110961b5b87af8ec4a6bd0b2373475245f12f7879e935b54244937`; `hdiutil verify` ended
  with `verified ... hdiutil: verify: checksum ... is VALID`.
- Mounted read-only with `hdiutil attach -readonly -nobrowse -mountpoint
/tmp/acevra-alpha-install-501 ...`. The mounted app was installed with `/usr/bin/ditto` into
  `/Applications/AceVra.app` after a no-existing-target check; no `sudo`, recursive deletion, or
  quarantine removal was used. `ditto` plus strict verification passed for the staging copy and
  the installed copy. Installed owner/mode: `felipemore:staff`, `drwxr-xr-x`.

### 2. Installed product identity and packaged boundary

Commands run against `/Applications/AceVra.app`:

```text
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' .../Info.plist
# com.acevra.desktop
/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' .../Info.plist
# AceVra
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' .../Info.plist
# 0.1.0-alpha.1
/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' .../Info.plist
# 0.1.0-alpha.1
/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' .../Info.plist
# AceVra
file .../Contents/MacOS/AceVra
# Mach-O 64-bit executable arm64
```

- Installed and DMG file-tree digests were identical:
  `88dcd11385782336c45132fa78cbaf2e37533646c268e29e90c2ecdc2cfffc53` for both trees.
- The installed app, product Helper, and peer probe are arm64. The only native Helper paths found
  under `Contents` were
  `Contents/Resources/cua-helper/AceVra Computer Use.app` and
  `Contents/Resources/cua-helper/peer-identity-probe`; no repository-relative Helper was found.
- `find ... -name '.env' -o -name '.env.*' -o -name '*.env'` found no development `.env`.
  A binary/text scan of the installed bundle found no repository checkout path,
  `xcrun`, `swiftc`, or `swift-frontend` tokens. A packaged `macos-window-bounds` resource exists
  at `Contents/Resources/macos-window-bounds`; it is not the CUA product Helper.
- The product Helper metadata is not clean:
  `Contents/Resources/cua-helper/helper-build-info.json` contains
  `appPath=<developer-checkout>/packages/desktop/resources/cua-helper/AceVra Computer Use.app`.
  This is a packaged developer absolute path and is an acceptance failure.
- Installed process observation used `ps -axo pid=,ppid=,comm=,args=` and showed the main installed
  app plus `/Applications/AceVra.app/Contents/Frameworks/...` children. No `pnpm dev`, Vite,
  webpack, or Electron dev process was found. The observed user-data argument was
  `~/Library/Application Support/AceVra Local Engineering Alpha`.

### 3. Signatures, Gatekeeper, and notarization

- `codesign --verify --deep --strict --verbose=4 /Applications/AceVra.app` passed mechanically and
  the app satisfied its own designated requirement, but its signature details are
  `Signature=adhoc`, `TeamIdentifier=not set`, CDHash
  `91beec99095cd75169eb620a72f55ed268cb448ab7fc214ac66f513b67098a96`. The release contract
  requires a stable non-ad-hoc outer identity; this fails.
- `codesign -d -r-` for the Helper and probe returned stable certificate-root requirements:
  - Helper: `identifier "dev.acevra.cua-helper" and certificate root = H"e67964f24cb4f07494050839d1653637c06e7a7c"`
  - Probe: `identifier "dev.acevra.cua-peer-identity.development" and certificate root = H"e67964f24cb4f07494050839d1653637c06e7a7c"`
- `codesign --verify --strict --verbose=4` passed for the Helper and peer probe. Their `codesign -dv`
  details reported `Authority=AceVra CUA Dev Signing`, arm64, Helper CDHash
  `99f751253234a38064b234957ae37f402774b0a981e2fb18b75cdcb6719df6cf`, and probe CDHash
  `d2aa82b5bc4abf4d4be2a35150b55f2e4033fd08cccd4b18c53a550686ea58bf`.
- `/usr/sbin/spctl --assess --type execute --verbose=4 /Applications/AceVra.app` returned
  `rejected`; `spctl --assess --type open --context context:primary-signature -v` also returned
  `rejected`. `/usr/bin/xcrun stapler validate` returned `AceVra.app does not have a ticket stapled`.
  This is expected to be non-notarized only as a recorded local-alpha limitation, but it is not a
  passing distribution gate.
- The DMG/app had `com.apple.provenance` xattr, not a user-added bypass. The first
  `/usr/bin/open /Applications/AceVra.app` returned exit 0 and the installed app began running;
  no expected human Gatekeeper rejection/Open Anyway checkpoint was observed. Gatekeeper evidence
  is therefore non-fresh and the ordered checkpoint is unresolved.

### 4. Installed first launch, persistence, and deterministic UI

- The two prescribed alpha roots were absent before first launch:
  `~/Library/Application Support/AceVra Local Engineering Alpha` and
  `~/.zcode-local-engineering-alpha`. After launch, only those roots were populated; the app's
  process arguments and created paths used the alpha roots. No production-root path was created by
  this run. The app created its isolated Electron `session`, `v2` settings/provider state, default
  workspace, CA files, and runtime directories. File contents were not printed.
- The exact first launch was `/usr/bin/open /Applications/AceVra.app`, never direct executable
  spawn. Monotonic measurement: start `161266368891416`, observation end `161271728099291`,
  elapsed `5359 ms`. `ps` observed GPU/network/renderer children under the installed app.
- Installed-app CDP observation used a loopback relaunch only:
  `/usr/bin/open -n /Applications/AceVra.app --args --remote-debugging-port=9222
--remote-debugging-address=127.0.0.1`, then `npx --yes agent-browser@latest ... connect 9222`.
  The observed renderer URL was a `file:///Applications/AceVra.app/Contents/Resources/app.asar/...`
  URL with `initialWorkspacePath=.../.zcode-local-engineering-alpha/...`; no dev URL or dev server
  was observed. `document.title` was `ZCode`; the visible deterministic first-run body was
  `Welcome to AceVra` with buttons `Connect to Z.ai Global`, `Connect to BigModel CN`, and
  `Use API key`. Local/session storage key lists were empty. No account/provider action was taken.
- Graceful quit completed and all installed-app descendants exited. A relaunch then restored the
  same first-run UI and alpha workspace URL. Monotonic measurement: relaunch start
  `161409203773291`, CDP-ready `161409729025666`, elapsed `525 ms`. This is quit/relaunch
  persistence of the deterministic unauthenticated state, not account or CUA persistence.
- The app has no CUA state directory after these runs:
  `~/.zcode-local-engineering-alpha/.zcode/computer-use` is absent, and no
  `AceVra Computer Use.app` process was observed. `runtime/provider/darwin-aarch64/0.1.0-alpha.1`
  exists. No CUA Helper launch was therefore exercised from the packaged app.

### 5. Permission, CUA, input, and physical checkpoints

- I ran the installed product Helper binary directly in non-prompting probe mode:
  `/Applications/AceVra.app/Contents/Resources/cua-helper/AceVra Computer Use.app/Contents/MacOS/AceVraComputerUse
--expected-identifier dev.acevra.cua-helper`. The output was reduced to identity and permission
  fields; no app inventory or private content was printed. It reported the exact installed Helper
  path, `bundleId=dev.acevra.cua-helper`, stable Helper DR, `verified=true`, and
  `accessibility=true`, `screenCapturePreflight=true`.
- Those pre-existing grants make the TCC proof **non-fresh**. The required human removal and
  observed denial before fresh Accessibility/Screen Recording authorization were not performed;
  no `tccutil` or System Settings mutation was attempted. This blocks fresh-TCC acceptance.
- No harmless semantic CUA fixture, exclusive foreground lease, software Stop, repeated Stop,
  held-input cleanup, or exclusive-lock fixture was run: the packaged app never launched its
  product Helper, and the app was stopped at deterministic unauthenticated onboarding rather than
  fabricating an authorized host/session. The implementation's native path maps a failed event tap
  to `input_monitoring_required` at
  `packages/zcode-cua/native/cua-helper/ForegroundControl.swift:277-292`; that source fact is not
  an executed experiment.
- Input Monitoring requirement was not experimentally determined. A real exclusive lease and
  physical input are required, and the real-mouse/Shift checkpoint is explicitly not substitutable
  by synthetic events. No synthetic mouse or Shift event was generated.
- Real physical mouse movement and real Shift press/release were not run. Consequently no
  interruption latency, defensive key-up, tap-disable, exclusion-release, or no-later-post
  measurement exists. No real event was synthesized.

### 6. Network, browser, and existing-feature boundaries

- The required fail-closed observer set was not available as a completed runnable acceptance
  runner: `release/0.1.0-alpha.1/handoff` and `validation` do not exist, and the installed runner
  only checks that a handoff directory exists and contains five files
  (`scripts/release/accept-local-alpha-installed.mjs:10-34`).
- The exact candidate verification command was run and failed as designed:
  `mise exec -- node scripts/mise-run.mjs pnpm release:verify:candidate -- --build-dir
$PWD/release/0.1.0-alpha.1/candidate --validation-dir $PWD/release/0.1.0-alpha.1/validation --json`.
  It reported missing exact `AceVra-0.1.0-alpha.1-arm64.dmg/.zip`, unexpected `*-mac-arm64.*`,
  `app is ad-hoc signed`, and the developer absolute path in `helper-build-info.json`; exit 1.
- The exact assembly command was run and failed because no validation directory exists:
  `mise exec -- node scripts/mise-run.mjs pnpm release:assemble:candidate -- --validation-dir
$PWD/release/0.1.0-alpha.1/validation --handoff-dir $PWD/release/0.1.0-alpha.1/handoff`; exit 1.
- The exact installed runner command was run against the missing handoff and failed with
  `handoff and installed app are required`; exit 1. No deliverable boundary exists to accept.
- During the installed app's idle observation, `lsof -nP -iTCP -sTCP:ESTABLISHED` showed the
  installed AceVra network child connected externally to `155.102.130.217:443` (an earlier sample
  showed `47.246.23.189:443`). Reverse DNS returned no name. The requested `nettop` command
  (`/usr/bin/nettop -L 1 -s 0.1 -j pid,process,state,interface,bytes_in,bytes_out`) was attempted
  but printed the local `nettop` help instead of a sample on this OS. No redacting capture sink,
  DNS/network unified log attribution, or complete fail-closed no-inference window was established.
  This is an acceptance failure, not evidence of provider/account traffic classification.
- Browser navigation/observation was limited to the installed app's local `file://` first-run
  renderer. No browser navigation, embedded browser fixture, existing remote feature, provider
  request, credential prompt, or account state transition was exercised.

### 7. Manual steps still required at the blocked checkpoints

1. A human must start from a fresh macOS TCC state, manually remove any existing
   `AceVra Computer Use.app` Accessibility/Screen Recording entries, restart the exact Helper, and
   record observed denial before granting only the exact Helper through System Settings. No
   `tccutil` is authorized.
2. A human must perform the first-launch Gatekeeper decision only if a genuinely fresh quarantined
   copy produces the expected rejection, using Finder/System Settings **Open Anyway**. The current
   local DMG opened without that fresh rejection, so this candidate cannot supply a fresh Gatekeeper
   proof.
3. With fresh TCC and an authorized CUA session, the human must run a harmless semantic fixture and
   harmless exclusive foreground fixture from the installed app; press the explicit software Stop,
   press it again, and record the monotonic timestamp at Stop request, Helper release, held-input
   cleanup, tap disable, and exclusion release. `already_stopped`, disabled tap, released exclusion,
   and no later post must be observed.
4. During a real exclusive lease, the human must move the physical mouse and press/release physical
   Shift. Record monotonic timestamps immediately before and after the physical event and at Helper
   interruption/cleanup. No synthetic event may satisfy this checkpoint.
5. Only after those human checkpoints and a rebuilt accepted handoff may browser navigation,
   existing remote-feature, and full quit/relaunch acceptance be rerun. No backup deletion or
   release publication is authorized by this worklog.

### 8. Repository checks run after the worklog update

- `mise exec -- node scripts/mise-run.mjs pnpm typecheck` — exit 0.
- `mise exec -- node scripts/mise-run.mjs pnpm lint` — exit 0, with `76 warnings and 0 errors` from
  the pinned run. Warnings are reported as warnings, not suppressed.
- `git diff --check` — exit 0. `git status --short` showed the pre-existing modified declaration maps,
  untracked `.zcodeignore`, untracked `release/0.1.0-alpha.1/build.log`, and the intentional
  worklog modification.

## Final report generation — 2026-09-24

**Final disposition remains BLOCKED / NOT ACCEPTED.** The report is complete, but it does not turn the
current candidate into an accepted release.

### Release-facing files written

- `release/0.1.0-alpha.1/FINAL_RELEASE_REPORT.md`
- `release/0.1.0-alpha.1/RELEASE_NOTES.md`
- `release/0.1.0-alpha.1/build-info.json`
- `release/0.1.0-alpha.1/SHA256SUMS.txt`

No DMG or ZIP binary was changed, committed, published, pushed, tagged, or merged. These documentation
and metadata files are not an exact-five-file handoff; `validation/` and `handoff/` remain absent.

### Checks executed for the final report

- `node scripts/check-workspace-freshness.mjs` — exit 0; ahead 7 / behind 0 and no configured
  upstream.
- `mise exec -- node scripts/mise-run.mjs pnpm architecture:check --changed` — exit 0; violations 0,
  baseline 0, new 0.
- `mise exec -- node scripts/mise-run.mjs pnpm typecheck` — exit 0.
- `mise exec -- node scripts/mise-run.mjs pnpm lint` — exit 0; 76 warnings and 0 errors.
- `mise exec -- node scripts/mise-run.mjs pnpm verify:pre-push` — exit 0.
- `mise exec -- node scripts/mise-run.mjs pnpm build` — exit 0 under pinned Node 24.14.0.
- `mise exec -- node scripts/mise-run.mjs pnpm fmt:check` — exit 1; 43 repository files reported.
  This remains a failed full-tree gate, not a pass.
- Exact CUA/release environment test command from `verification-plan.json` — exit 0; 133 passed,
  0 failed.
- Exact lease-authority/isolation test command from `verification-plan.json` — exit 0; 17 passed,
  0 failed.
- Exact release-runner test command from `verification-plan.json` — exit 0; 1 passed, 0 failed.
- `run-foreground-policy-tests.sh` — exit 0; foreground event classification passed.
- `run-semantic-policy-tests.sh` — exit 0; semantic action policy passed.
- The exact unguarded E2E plan command exited 1 because its required run ID/build flag was absent.
  With the required environment it exited 0, but the runner only checked its guards and printed that a
  renderer runner is still required; the Playwright Stop scenario was not run.
- `hdiutil verify <current DMG>` — exit 0; checksum valid.
- `unzip -t <current ZIP>` — exit 0; no compressed-data errors.
- `pnpm release:verify:candidate` against `candidate/` — exit 1 with the six controlling candidate
  errors recorded in the final report.
- `pnpm release:assemble:candidate` — exit 1 because `validation/` is absent.
- `pnpm release:accept:installed` — exit 1 because `handoff/` is absent.
- `shasum -a 256 -c SHA256SUMS.txt` from this release directory — exit 0; all six listed candidate
  files reported `OK`.

### Identity, signing, and installed checkpoint evidence

- Candidate and installed app identities: `AceVra` / `com.acevra.desktop` / `0.1.0-alpha.1`; main
  executable `AceVra`, arm64.
- Outer app: ad-hoc, no team identifier, designated requirement is CDHash-based. Helper/probe:
  strict verification passed with isolated local authority `AceVra CUA Dev Signing` and shared
  certificate root.
- Developer ID: no. Notarization: no. Staple: no. Gatekeeper: rejected.
- Installed alpha user-data/profile roots are present; the CUA state root remains absent.
- Fresh Helper probe reports pre-existing Accessibility and Screen Capture grants. Fresh-TCC proof is
  not established.
- Input Monitoring requirement is not experimentally determined.
- Software Stop and real physical mouse/Shift interruption are human-blocked. No numeric physical
  interruption latency exists, and no synthetic event was substituted.
- Prior unauthenticated quit/relaunch evidence remains supporting material only; Helper, CUA,
  provider/account, browser, and remote installed regressions were not accepted.

### Final app/archive release-content scan

A temporary read-only extraction/mount of the current ZIP and DMG was scanned with the repository's
`scanCandidateContents` function, alongside the unpacked candidate app. All three targets reported the
same finding:

```text
developer-absolute-path at Contents/Resources/cua-helper/helper-build-info.json
```

The release metadata files themselves were separately scanned for developer checkout paths, private
key markers, and common credential-value patterns; that scan printed
`RELEASE_METADATA_SCAN_CLEAN`. This clean metadata scan does not override the failed app/DMG/ZIP
content scan.

### Required next step

Fix stable outer-app signing and relative-only Helper provenance, rebuild current `HEAD` into a new
no-clobber build directory, produce the exact arm64 archive names, rerun candidate validation and the
app/DMG/ZIP content scan, assemble the exact-five-file handoff, and then complete fresh human
Gatekeeper/TCC, software Stop, and physical-interruption checkpoints. Do not distribute the current
candidate.

## Repaired-app revalidation — 2026-09-24

**Disposition: BLOCKED / NOT ACCEPTED.** The current checkout is now at `f9c3369`
(`fix(release): close confirmed review blockers`), but the installed application and generated
candidate were not rebuilt or replaced. The installed app remains the prior copy described in
`release/0.1.0-alpha.1/FINAL_RELEASE_REPORT.md:1-18`; the generated candidate is still the
`fff67d4b` build recorded in `release/0.1.0-alpha.1/build.log:564-568` as cited by
`release/0.1.0-alpha.1/FINAL_RELEASE_REPORT.md:50-54`.

### Freshness and current source state

- `node scripts/check-workspace-freshness.mjs` — exit 0; output reported
  `基线新鲜：release/0.1.0-alpha，相对 origin/main：ahead 8 / behind 0（阈值 50）` and no configured
  upstream.
- `git log -5 --oneline --decorate` — current `HEAD=f9c3369`; no commit, push, tag, merge, or
  publication was performed.
- `/Applications/AceVra.app` still reports modification time `Sep 23 21:39:32 2026`, matching the
  earlier installed copy rather than a newly rebuilt repair.

### Installed identity, signature, Helper, and Gatekeeper

Commands run against `/Applications/AceVra.app` produced:

```text
CFBundleIdentifier    com.acevra.desktop
CFBundleDisplayName   AceVra
CFBundleShortVersionString  0.1.0-alpha.1
CFBundleVersion       0.1.0-alpha.1
CFBundleExecutable    AceVra
file                  Mach-O 64-bit executable arm64
```

- `codesign --verify --deep --strict --verbose=4 /Applications/AceVra.app` mechanically passed, but
  `codesign -dv --verbose=4` still reported `Signature=adhoc`, `TeamIdentifier=not set`, and
  CDHash `91beec99095cd75169eb620a72f55ed268cb448ab7fc214ac66f513b67098a96`.
  `codesign -d -r-` still returned a CDHash-based requirement, not a certificate-root requirement.
  The stable outer-signing repair is not present in the installed app.
- The Helper at
  `/Applications/AceVra.app/Contents/Resources/cua-helper/AceVra Computer Use.app` is
  `dev.acevra.cua-helper`, version `0.1.0-alpha.1`, arm64, strictly signed, and still has the
  stable requirement `identifier "dev.acevra.cua-helper" and certificate root = H"e67964f24cb4f07494050839d1653637c06e7a7c"`.
- The peer verifier at
  `/Applications/AceVra.app/Contents/Resources/cua-helper/peer-identity-probe` is
  `dev.acevra.cua-peer-identity.development`, arm64, strictly signed, with stable requirement
  `identifier "dev.acevra.cua-peer-identity.development" and certificate root = H"e67964f24cb4f07494050839d1653637c06e7a7c"`.
  Its fail-closed no-socket check was run with `--requirement 'identifier "dev.acevra.cua-helper"'`
  and returned `peer_token_unavailable` / exit 1.
- The installed Helper metadata still contains the developer absolute path
  `<developer-checkout>/packages/desktop/resources/cua-helper/AceVra Computer Use.app`.
  The Helper is at the correct packaged resource path, but the provenance repair is not present in
  the installed tree.
- `spctl --assess --type execute` and `spctl --assess --type open --context
context:primary-signature` both returned `rejected`. `xcrun stapler validate` returned
  `AceVra.app does not have a ticket stapled to it.` The root xattr is only
  `com.apple.provenance`; no quarantine-removal workaround was used.
- Installed app process paths were observed under `/Applications/AceVra.app/Contents/`; no dev
  server or source-checkout runtime was used. The installed app was finally quit gracefully:
  `FINAL_QUIT=PASS`.

### Helper TCC and CUA safety revalidation

- Installed Helper non-prompting probe command:
  `/Applications/AceVra.app/Contents/Resources/cua-helper/AceVra Computer Use.app/Contents/MacOS/AceVraComputerUse
--expected-identifier dev.acevra.cua-helper`.
  Output was reduced to identity and permission fields and reported `verified=true`,
  `accessibility=true`, and `screenCapturePreflight=true`. These remain pre-existing grants, so
  fresh TCC acceptance is blocked. No prompt, `tccutil`, System Settings mutation, or permission
  bypass was attempted.
- Exact safety E2E command run:
  `mise exec -- node scripts/mise-run.mjs pnpm --filter @zcode/desktop e2e:cua-alpha`.
  Exit 1 at `packages/desktop/e2e/cua-release-safety.e2e.mjs:7`: `CUA alpha E2E requires the real
E2E run id and build flag`. No renderer Stop scenario was substituted.
- Supporting safety tests run during this revalidation:
  - `mise exec -- node scripts/mise-run.mjs node --import tsx --test
packages/services/test/cuaLeaseAuthority.test.ts packages/services/test/localAlphaHomeIsolation.test.ts
packages/services/test/directHomeReaderInventory.test.ts` — exit 0, 17 passed, 0 failed.
    This includes Stop serialization, late-commit fencing, and isolation tests; it is not installed
    UI acceptance.
  - `mise exec -- node scripts/mise-run.mjs node --test packages/zcode-cua/test/*.test.mjs` —
    exit 0, 130 passed, 0 failed, including fail-closed peer/transport and CUA policy tests.
  - `mise exec -- node scripts/mise-run.mjs bash packages/zcode-cua/native/cua-helper/run-foreground-policy-tests.sh
&& mise exec -- node scripts/mise-run.mjs bash packages/zcode-cua/native/cua-helper/run-semantic-policy-tests.sh` —
    exit 0; outputs were `foreground event classification tests passed` and
    `semantic action policy tests passed`.
- The installed app itself did not launch the product Helper during this revalidation;
  `~/.zcode-local-engineering-alpha/.zcode/computer-use` remained absent and no
  `AceVra Computer Use.app` process was observed. Installed software Stop, repeated Stop,
  `already_stopped`, held-input cleanup, and exclusive lease release were therefore not run.
- Input Monitoring and real physical interruption were not run. The worklog's cited native path
  `packages/zcode-cua/native/cua-helper/ForegroundControl.swift:268-292,311-318` describes the
  tap-failure behavior, but it is not a live permission or interruption measurement. No synthetic
  mouse or Shift event was generated.

### Installed browser, providers, remote features, and restart

- Launch command:
  `/usr/bin/open -n /Applications/AceVra.app --args --remote-debugging-port=9222
--remote-debugging-address=127.0.0.1`.
  Monotonic launch measurement: start `164617271610666`, CDP-ready `164618269706833`, elapsed
  `998 ms`. `npx --yes agent-browser@latest --session acevra-revalidate connect 9222` and
  `snapshot -i` observed the installed local `file://` renderer.
- The observed body remained deterministic first-run onboarding:
  `Welcome to AceVra`, `Connect to Z.ai Global`, `Connect to BigModel CN`, and `Use API key`.
  Local/session storage key lists were empty. No provider button, API key, account, credential, or
  inference action was taken. Browser navigation beyond this local renderer and embedded-browser
  fixture behavior were not run. Existing remote features were not reachable or exercised.
- During this run, `lsof -nP -iTCP -sTCP:ESTABLISHED` attributed an external socket from the
  installed AceVra network child to `47.246.23.183:443`. The required redacting capture sink and
  complete no-inference observer attribution were not established; no claim is made that this
  socket is or is not provider-related.
- The isolated userData/profile roots were present and the app process used
  `~/Library/Application Support/AceVra Local Engineering Alpha`. The CUA state root remained
  absent. This is deterministic state, not a new clean-install proof.
- Graceful quit/relaunch was run again. Monotonic measurement: quit start `164645789673750`, quit
  done `164646286246833`, relaunch start `164646415565416`, CDP-ready `164647461790041`, elapsed
  `1046 ms`. The relaunched UI again showed the same onboarding text, empty local/session storage,
  and the alpha workspace URL. Helper/CUA/account/provider restart persistence was not run.

### Artifact and handoff boundary

Commands run during this revalidation:

```text
hdiutil verify release/0.1.0-alpha.1/candidate/AceVra-0.1.0-alpha.1-mac-arm64.dmg
# VALID

unzip -t release/0.1.0-alpha.1/candidate/AceVra-0.1.0-alpha.1-mac-arm64.zip
# No errors detected in compressed data

(cd release/0.1.0-alpha.1 && shasum -a 256 -c SHA256SUMS.txt)
# all six listed candidate files: OK
```

- Current archive hashes remained:
  - DMG `3d730c0870110961b5b87af8ec4a6bd0b2373475245f12f7879e935b54244937`
  - ZIP `4f9f0cebb28e4aa853cce874841d6d1526b64c0132e5e02178cc418811fd705b`
- Exact candidate validation command was run and exited 1. Current errors were missing required
  `AceVra-0.1.0-alpha.1-arm64.dmg/.zip`, unexpected `*-mac-arm64.*`, ad-hoc app signature,
  non-certificate-root outer requirement, and the Helper developer absolute path.
- Exact handoff assembly command exited 1 because `validation/` is absent.
- Exact installed acceptance command exited 1 because `handoff/` is absent:
  `mise exec -- node scripts/mise-run.mjs pnpm release:accept:installed -- --handoff
"$PWD/release/0.1.0-alpha.1/handoff" --app /Applications/AceVra.app`.
- Therefore the generated artifacts are integrity-valid but still fail the naming/signing/
  provenance/deliverable contract. No artifact was published or replaced.

### Human checkpoints and next action

This revalidation remains blocked at the same human-only boundaries recorded above. A human must
provide a genuinely fresh Gatekeeper/Open Anyway decision, remove any existing Helper TCC grants
through System Settings and observe denial before fresh grants, then perform the real installed
software Stop/repeated Stop and real physical mouse/Shift interruption measurements. No synthetic
substitution is permitted. A newly rebuilt app/handoff is also required before these human checks
can validate the repaired release.

### Current-source checks

- The first attempts to run `mise exec -- node scripts/mise-run.mjs pnpm typecheck` and
  `mise exec -- node scripts/mise-run.mjs pnpm lint` were invoked from
  `release/0.1.0-alpha.1` because the shell working directory had persisted there. Both failed with
  `Cannot find module .../release/0.1.0-alpha.1/scripts/mise-run.mjs`; they were not treated as source
  gate results.
- Re-run against the repository root:
  `mise exec -- node scripts/mise-run.mjs pnpm --dir <repo> typecheck` — exit 0.
- Re-run against the repository root:
  `mise exec -- node scripts/mise-run.mjs pnpm --dir <repo> lint` — exit 0,
  `76 warnings and 0 errors`.
- `git diff --check` — exit 0. The worklog and the pre-existing generated/untracked files remain the
  only working-tree changes visible to this check.

## Follow-up repaired-app revalidation — current HEAD d80cd4a

**Disposition: BLOCKED / NOT ACCEPTED.** The current source checkout is now `d80cd4a`
(`fix(release): fail closed on foreground authority`), but the installed app and generated
artifacts remain the prior candidate. No new DMG was built or installed in this revalidation.

### Baseline and installed provenance

- From the repository root, `node scripts/check-workspace-freshness.mjs` — exit 0;
  output reported `基线新鲜：release/0.1.0-alpha，相对 origin/main：ahead 9 / behind 0（阈值 50）` and
  no configured upstream.
- `git log -3 --oneline --decorate` — current `HEAD=d80cd4a`, followed by `f9c3369` and `a6964c4`.
- `/Applications/AceVra.app` still reports modification time `Sep 23 21:39:32 2026` and CDHash
  `91beec99095cd75169eb620a72f55ed268cb448a`; it is not a rebuilt current-HEAD install.

### Installed signatures, Helper path, TCC, and roots

Commands run during this follow-up:

```text
codesign --verify --deep --strict --verbose=4 /Applications/AceVra.app
# valid on disk; satisfies its Designated Requirement

codesign -d -r- /Applications/AceVra.app
# designated => cdhash H"91beec99095cd75169eb620a72f55ed268cb448a"

codesign -dv --verbose=4 /Applications/AceVra.app
# Signature=adhoc; TeamIdentifier=not set
```

- Installed identity remains `com.acevra.desktop` / `AceVra` / `0.1.0-alpha.1`, arm64.
- Product Helper is at the exact packaged path
  `/Applications/AceVra.app/Contents/Resources/cua-helper/AceVra Computer Use.app`.
  Strict verification passed; identity is `dev.acevra.cua-helper`; DR is certificate-root anchored.
- Peer verifier is at
  `/Applications/AceVra.app/Contents/Resources/cua-helper/peer-identity-probe`.
  Strict verification passed; identity is `dev.acevra.cua-peer-identity.development`; DR is
  certificate-root anchored.
- `spctl --assess --type execute` and `spctl --assess --type open --context
context:primary-signature` both returned `rejected`. `xcrun stapler validate` returned
  `AceVra.app does not have a ticket stapled to it.` No xattr removal was used.
- No `.env`, `.env.*`, or `*.env` file was found under the installed bundle. The packaged Helper
  metadata still contains the developer checkout path
  `<developer-checkout>/packages/desktop/resources/cua-helper/AceVra Computer Use.app`;
  the relative-only provenance repair is not present in this installed copy.
- Non-prompting Helper probe:
  `/Applications/AceVra.app/Contents/Resources/cua-helper/AceVra Computer Use.app/Contents/MacOS/AceVraComputerUse
--expected-identifier dev.acevra.cua-helper` reported `verified=true`, `accessibility=true`,
  and `screenCapturePreflight=true`. The grants are pre-existing, so fresh TCC remains blocked.
  No permission mutation, `tccutil`, or System Settings action was attempted.
- Peer verifier fail-closed check:
  `/Applications/AceVra.app/Contents/Resources/cua-helper/peer-identity-probe --requirement
'identifier "dev.acevra.cua-helper"'` returned `peer_token_unavailable` and exit 1 because no
  connected socket was supplied.
- Isolated userData/profile roots exist. The CUA state root
  `~/.zcode-local-engineering-alpha/.zcode/computer-use` is absent. No Helper process was
  observed. The app was finally quit gracefully: `FINAL_QUIT=PASS`.

### CUA safety and interruption evidence

Exact current commands and results:

```text
mise exec -- node scripts/mise-run.mjs pnpm --filter @zcode/desktop e2e:cua-alpha
# exit 1: CUA alpha E2E requires the real E2E run id and build flag
# packages/desktop/e2e/cua-release-safety.e2e.mjs:7

mise exec -- node scripts/mise-run.mjs node --import tsx --test \
  packages/services/test/cuaLeaseAuthority.test.ts \
  packages/services/test/localAlphaHomeIsolation.test.ts \
  packages/services/test/directHomeReaderInventory.test.ts
# exit 0; 17 passed, 0 failed

mise exec -- node scripts/mise-run.mjs node --test packages/zcode-cua/test/*.test.mjs
# exit 1; 129 passed, 1 failed
# failure: packages/zcode-cua/test/broker.test.mjs:484-502
# projects leased foreground effects without claiming click application success
# expected lease id 00000000-0000-0000-0000-000000000001, actual undefined

mise exec -- node scripts/mise-run.mjs bash \
  packages/zcode-cua/native/cua-helper/run-foreground-policy-tests.sh \
  && mise exec -- node scripts/mise-run.mjs bash \
  packages/zcode-cua/native/cua-helper/run-semantic-policy-tests.sh
# exit 0; foreground event classification tests passed
# semantic action policy tests passed
```

- The failing CUA test is a current safety-relevant failure, not an installed-app pass.
- Installed Helper launch, semantic CUA, exclusive CUA, software Stop, repeated Stop,
  `already_stopped`, held-input cleanup, and exclusive release were not run because the installed
  app remained unauthenticated onboarding and never launched the Helper.
- Input Monitoring and real interruption were not run. The native tap behavior is cited by the
  existing worklog at `packages/zcode-cua/native/cua-helper/ForegroundControl.swift:268-292,311-318`;
  no physical event was synthesized.

### Installed browser, providers, remote features, network, and restart

- Launch command:
  `/usr/bin/open -n /Applications/AceVra.app --args --remote-debugging-port=9222
--remote-debugging-address=127.0.0.1`.
  Monotonic launch measurement: start `165977811084666`, CDP-ready `165978577862250`, elapsed
  `766 ms`.
- After the initial short wait the renderer was empty; after an additional five-second wait,
  `npx --yes agent-browser@latest --session acevra-d80 snapshot` observed the deterministic
  installed onboarding:
  `Welcome to AceVra`, `Connect to Z.ai Global`, `Connect to BigModel CN`, and `Use API key`.
  The renderer URL was a local `file:///Applications/AceVra.app/...` URL with the alpha workspace
  path. Local/session storage key lists were empty. No provider, account, credential, or inference
  action was taken. Browser navigation beyond the local renderer and remote features were not run.
- During observation, `lsof -nP -iTCP -sTCP:ESTABLISHED` showed the installed AceVra network child
  connected to `47.246.23.189:443`. The required no-inference observer attribution was not
  established; no provider classification is claimed.
- Graceful restart was run. Monotonic measurement: quit start `166005442821041`, quit done
  `166005783425041`, relaunch start `166005864712291`, CDP-ready `166006562150666`, elapsed
  `697 ms`. The relaunched UI again showed the same onboarding and empty local/session storage.
  CUA Helper restart and CUA lease persistence were not run.

### Artifact and acceptance boundary

Commands run during this follow-up:

```text
hdiutil verify release/0.1.0-alpha.1/candidate/AceVra-0.1.0-alpha.1-mac-arm64.dmg
# VALID

unzip -t release/0.1.0-alpha.1/candidate/AceVra-0.1.0-alpha.1-mac-arm64.zip
# No errors detected in compressed data

(cd release/0.1.0-alpha.1 && shasum -a 256 -c SHA256SUMS.txt)
# all six listed candidate files: OK

mise exec -- node scripts/mise-run.mjs pnpm release:verify:candidate -- \
  --build-dir "$PWD/release/0.1.0-alpha.1/candidate" \
  --validation-dir "$PWD/release/0.1.0-alpha.1/validation" --json
# exit 1: wrong archive names, ad-hoc app, non-certificate-root outer DR,
# developer absolute path

mise exec -- node scripts/mise-run.mjs pnpm release:assemble:candidate -- \
  --validation-dir "$PWD/release/0.1.0-alpha.1/validation" \
  --handoff-dir "$PWD/release/0.1.0-alpha.1/handoff
# exit 1: validation/handoff directory missing

mise exec -- node scripts/mise-run.mjs pnpm release:accept:installed -- \
  --handoff "$PWD/release/0.1.0-alpha.1/handoff" \
  --app /Applications/AceVra.app
# exit 1: handoff and installed app are required
```

The artifact bytes are integrity-valid, but the release deliverable contract is still failed.
No binary was rebuilt, replaced, published, pushed, tagged, or merged.

### Current source gates

```text
mise exec -- node scripts/mise-run.mjs pnpm --dir <repo> typecheck
# exit 0

mise exec -- node scripts/mise-run.mjs pnpm --dir <repo> lint
# exit 0; 76 warnings and 0 errors
```

### Human-only checkpoints

This run remains blocked at the human Gatekeeper/TCC and physical-input boundaries. A human must
perform a fresh Gatekeeper decision, remove existing Helper TCC grants through System Settings and
observe denial before fresh authorization, then run the real installed CUA Stop/repeated Stop and
real mouse/Shift interruption measurements. No synthetic substitution, provider inference,
permission bypass, or account action is permitted.

## Regeneration from repaired source — 2026-09-24

**Disposition: BLOCKED / NOT ACCEPTED. No repaired candidate was produced.**

Current source is `f9c33693bcf2f4b1c88bd60df10e1fe9992f902b`. A new no-clobber macOS arm64 bundle
was attempted with the isolated local signing identity. The command failed during
`prepare:runtime-assets` before Desktop build, native Helper preparation, signing, or Electron
Builder:

```text
apps/zcode-cli/packages/node-repl-host/src/server.ts:387
TS2353: 'leaseAuthority' does not exist in type 'ComputerUseRuntimeOptions'
```

The runtime passes the property at
`apps/zcode-cli/packages/node-repl-host/src/server.ts:387`, while
`packages/zcode-cua/index.d.ts:26-40` does not declare it. `repaired-build/` and
`repaired-validation/` do not exist.

### Commands run during regeneration

- `node scripts/check-workspace-freshness.mjs` — exit 0; ahead 8 / behind 0 and no configured
  upstream.
- Repaired no-clobber Desktop bundle command — exit 1 with the TS2353 error above.
- `pnpm --dir <repo> architecture:check --changed` — exit 0; violations 0, baseline 0, new 0.
- `pnpm --dir <repo> typecheck` — exit 0 for the root typecheck project list; this does not include
  the separate CLI node-repl project that failed during build.
- `pnpm --dir <repo> lint` — exit 0; 76 warnings and 0 errors.
- `pnpm --dir <repo> fmt:check` — exit 1; 43 files reported.
- `pnpm --dir <repo> verify:pre-push` — exit 0; lint warnings remain and architecture had zero
  violations.
- `pnpm --dir <repo> build` — exit 2; the CLI build failed at the same node-repl TS2353 error.
- Exact CUA/release environment tests — exit 0; 133 passed, 0 failed.
- Exact lease-authority/isolation tests — exit 0; 17 passed, 0 failed.
- Exact release-runner tests — exit 0; 1 passed, 0 failed.
- Foreground and semantic native policy scripts — exit 0.
- Exact `e2e:cua-alpha` command without guards — exit 1 because run ID/build flag were absent.
- Guarded `e2e:cua-alpha` — exit 1 because the first Electron window body was empty and did not match
  the required local-engineering-alpha safety copy.
- Old-candidate validator — exit 1 with seven errors, including wrong archive names, ad-hoc outer
  signature, non-certificate-root outer DR, and Helper developer path.
- Repaired-build validator — exit 1; app and both required archives are missing.
- Handoff assembly — exit 1 because `repaired-validation/` is absent.
- Installed acceptance — exit 1 because `repaired-handoff/` is absent.
- `hdiutil verify` and `unzip -t` on the old DMG/ZIP — exit 0; both integrity checks passed.
- Fresh `shasum -a 256` on the six old candidate files — completed; hashes match
  `SHA256SUMS.txt`.
- `spctl` on the old candidate and installed app — `rejected`.
- `stapler validate` on the old candidate and installed app — no stapled ticket.

### Repaired source versus generated/installed state

The source now emits logical Helper `resourcePath`, defaults the CUA product path off unless
explicitly enabled, integrates a service lease-authority/runtime bridge, changes physical exclusion
to `flock` on the kernel-owned `/dev/null` device inode, and implements a real Playwright Electron
launch. These source changes were not packaged because the build failed.

The staged Helper metadata still has `appPath`, confirming native preparation was not reached. The
old candidate and installed app remain ad-hoc and contain the developer path. The settings source
still has no active-only software Stop control, and the E2E does not cover active/repeated/released
Stop states.

The installed Helper probe again reported pre-existing Accessibility and Screen Capture grants;
fresh TCC remains blocked. Input Monitoring, repaired installed CUA, software Stop, and real physical
mouse/Shift interruption were not run. No numeric physical interruption latency exists.

### Final available-artifact secret/path scan

The DMG was mounted read-only and the ZIP was extracted to a temporary directory. The repository's
`scanCandidateContents` function was run against the unpacked candidate app, ZIP app, and DMG app. All
three returned:

```text
developer-absolute-path at Contents/Resources/cua-helper/helper-build-info.json
```

No repaired archive existed to scan, so this is a failed available-candidate scan and not a repaired
release pass.

### Regenerated files

- `release/0.1.0-alpha.1/FINAL_RELEASE_REPORT.md`
- `release/0.1.0-alpha.1/RELEASE_NOTES.md`
- `release/0.1.0-alpha.1/build-info.json`
- `release/0.1.0-alpha.1/SHA256SUMS.txt`

`SHA256SUMS.txt` intentionally identifies the rejected old candidate because no repaired artifact
exists. No binary was committed, published, pushed, tagged, or merged.

### Required next step

Add the missing public `leaseAuthority` option to `ComputerUseRuntimeOptions` or remove the mismatched
bridge, rerun the root/CLI build, then create a new no-clobber repaired candidate. Do not reuse the old
archives. Candidate validation, exact names, signatures, app/DMG/ZIP secret/path scan, handoff, and
human installed checkpoints remain mandatory.

## Regeneration from newly built repaired candidate — 2026-09-24

**Disposition: REPAIRED CANDIDATE PRODUCED / NOT ACCEPTED.**

Current source and repaired bundle revision are
`d80cd4ab4759caf07c72483229c5370fb24b2b0b`. A new no-clobber bundle was built under
`release/0.1.0-alpha.1/repaired-build/` using the isolated local signing material. The bundle command
exited 0, built revision `d80cd4ab` at `2026-09-24T04:29:37.851Z`, and emitted the exact required
archives:

```text
AceVra-0.1.0-alpha.1-arm64.dmg
AceVra-0.1.0-alpha.1-arm64.zip
```

No DMG or ZIP was committed, published, pushed, tagged, or merged.

### Candidate identities, signing, and artifacts

- App: `AceVra` / `com.acevra.desktop` / `0.1.0-alpha.1`; executable `AceVra`, arm64.
- Helper: `AceVra Computer Use.app` / `dev.acevra.cua-helper` /
  `AceVraComputerUse`, arm64, version `0.1.0-alpha.1`, build `1`.
- Probe: `dev.acevra.cua-peer-identity.development`, arm64.
- Helper/probe strict verification passed with `AceVra CUA Dev Signing` and the shared local
  certificate-root requirement.
- Outer app remains `Signature=adhoc`, has no team identifier, and has a CDHash-only DR. Electron
  Builder logged `falling back to ad-hoc signature for macOS application code signing`.
- Developer ID: no. Notarization: no. Staple: no. `spctl`: rejected.

Fresh artifact results:

```text
DMG SHA256  26c5f924f9f61cf8cbf6243aa49a4b61e4b9b0885bc75e8f199d74c78b1d771c
ZIP SHA256  ef50a8d71443f10ddec4a7e20a6ea3159f0bc02c400778c695a5f70716b0a617
hdiutil verify: VALID
unzip -t: No errors detected in compressed data
```

The six current values are recorded in `SHA256SUMS.txt`.

### Candidate validation

Exact command:

```text
mise exec -- node scripts/mise-run.mjs pnpm --dir <repo> release:verify:candidate -- \
  --build-dir <repo>/release/0.1.0-alpha.1/repaired-build \
  --validation-dir <repo>/release/0.1.0-alpha.1/repaired-validation --json
```

Exit 1 with exactly two errors:

```text
app is ad-hoc signed
app designated requirement is not certificate-root anchored
```

Archive names, identities, architectures, Helper/probe signatures, Helper build metadata, and content
scan no longer appear as errors. `repaired-validation/` and `repaired-handoff/` remain absent because
validation failed.

### Final repaired app/DMG/ZIP secret/path scan

The DMG was mounted read-only and the ZIP was extracted to a temporary directory. The repository's
`scanCandidateContents` function was run against all three repaired representations:

```text
repaired-app       findings=[]
repaired-zip-app   findings=[]
repaired-dmg-app   findings=[]
```

`helper-build-info.json` contains `resourcePath: "AceVra Computer Use.app"` and no `appPath`. This
final repaired-candidate content scan passed.

### Source and regression gates

- `node scripts/check-workspace-freshness.mjs` — exit 0; ahead 9 / behind 0, no configured upstream.
- `pnpm --dir <repo> architecture:check --changed` — exit 0; violations 0, baseline 0, new 0.
- `pnpm --dir <repo> typecheck` — exit 0.
- `pnpm --dir <repo> build` — exit 0; CLI Turbo 16/16 successful; Desktop renderer built.
- `pnpm --dir <repo> lint` — exit 1; generated `repaired-build` content produced 16,383 warnings and
  2 `max-lines` errors.
- `pnpm --dir <repo> fmt:check` — exit 1; 58 files, including generated repaired-build content.
- `pnpm --dir <repo> verify:pre-push` — exit 1 at lint.
- Exact CUA/release environment suite — exit 1; 132 passed, 1 failed. The foreground lease projection
  test expected a lease ID and received `undefined` at `packages/zcode-cua/test/broker.test.mjs:484-502`.
- Exact lease/isolation suite — exit 0; 17 passed, 0 failed.
- Exact release-runner suite — exit 0; 1 passed, 0 failed.
- Native foreground and semantic policy scripts — exit 0.
- Exact E2E command without guards — exit 1 because run ID/build flag were absent.
- Guarded Electron E2E — exit 1 because the first window body was empty instead of matching the
  required local-alpha safety copy.

The current settings component still has no active-only software Stop control, and the E2E does not
cover active, repeated, or released Stop. Input Monitoring, repaired packaged first run/TCC, live
Helper/CUA, software Stop, provider/account no-inference, remote regression, and repaired restart were
not run. Real mouse/Shift interruption remains human-blocked; no numeric latency exists.

### Regenerated files and next action

Updated:

- `release/0.1.0-alpha.1/FINAL_RELEASE_REPORT.md`
- `release/0.1.0-alpha.1/RELEASE_NOTES.md`
- `release/0.1.0-alpha.1/build-info.json`
- `release/0.1.0-alpha.1/SHA256SUMS.txt`

Next, fix the outer local-signing handoff, exclude generated candidate output from lint/format, correct
the foreground runtime/test mismatch, and expand Stop E2E coverage. Then rebuild into a new no-clobber
directory, rerun candidate validation, assemble the exact-five-file handoff, and perform the human
installed gates. Do not distribute or install the current repaired candidate.

## 2026-09-24 fresh repair continuation

The repaired candidate was rejected and was not reused. The canonical `release/0.1.0-alpha.1/build/`
directory was verified absent before this build. The local development keychain was recreated at
`packages/desktop/.cua-signing/` with the repository script; it contains no committed private material and
no trust setting was added.

### Repairs completed

- `bundle.mjs` now directly signs the local-alpha outer app after Electron Builder's arm64 fallback,
  using the isolated `AceVra CUA Dev Signing` identity, keychain, existing entitlements, and a strict
  post-sign identity/runtime/designated-requirement check.
- `verify-local-alpha-candidate.mjs` now reads the outer designated requirement with `codesign -d -r-`
  and requires the outer certificate root to match the Helper and peer-probe roots.
- `.gitignore` and `.oxlintrc.json` ignore only the generated repaired output paths and fresh build
  transcript; release documents remain visible to source gates.
- The duplicate undeclared `pendingAuthorityLease` acquisition was removed. The service authority now
  stores both authority and native Helper lease IDs, and the runtime releases both paths on model
  release, interruption, close, and dispose.
- The service authority Stop path releases and awaits the Helper through a narrow typed host bridge.
  The UI exposes Stop only while the authoritative control projection is active.
- The Computer Use settings section is no longer hidden by the global navigation denylist.
- The guarded Electron E2E now builds an isolated `local-engineering-alpha` artifact, waits for the
  business-root marker, uses a clean per-scenario data root, and covers default-off, active Stop, and
  released projection.
- The installed runner now supports exact handoff verification, candidate provenance, no-clobber backup,
  staging, atomic replacement, rollback, and fixture tests. It was not run against `/Applications`.

### Fresh source and build evidence

- Freshness: exit 0, ahead 9 / behind 0.
- Pinned `mise exec -- node scripts/mise-run.mjs pnpm build`: exit 0 under Node 24.14.0.
- `pnpm typecheck`: exit 0.
- `pnpm architecture:check --changed`: exit 0, violations 0, baseline 0, new 0.
- `pnpm lint`: exit 0; repository warnings remain non-blocking.
- `pnpm verify:pre-push`: exit 0.
- `pnpm fmt:check`: exit 1 on 43 pre-existing baseline files; no task-changed file is in the failing list.
- Focused CUA/release JavaScript suite: 138 passed, 0 failed.
- TypeScript lease-authority suite: 5 passed, 0 failed.
- `git diff --check`: exit 0.
- Guarded Electron E2E: passed for clean alpha build, business readiness, default-off/no Stop, active
  Stop, and released projection.

### Fresh candidate

- Build directory: `release/0.1.0-alpha.1/build/`.
- Build transcript: `release/0.1.0-alpha.1/fresh-build.log`.
- Embedded build metadata: source revision `d80cd4ab`, profile `local-engineering-alpha`, version
  `0.1.0-alpha.1`, Electron Builder `26.8.1`.
- DMG: `release/0.1.0-alpha.1/build/AceVra-0.1.0-alpha.1-arm64.dmg`.
- ZIP: `release/0.1.0-alpha.1/build/AceVra-0.1.0-alpha.1-arm64.zip`.
- `hdiutil verify`: valid.
- `unzip -t`: no errors detected.
- Candidate validator: `ok: true`, no errors or warnings; validation fixture created at
  `release/0.1.0-alpha.1/validation/`.
- Outer app: `Identifier=com.acevra.desktop`, `Authority=AceVra CUA Dev Signing`, hardened runtime,
  certificate-root DR `H"bf8f0f5130e10950f5a723ee77b8cad93951b56a"`, not ad-hoc.
- Helper root matches the outer root. Helper/probe strict verification passed.
- Final DMG SHA256: `5a8b18a77148dda426e94cd882184bdbe52f02f768816181abd206ba28575b44`.
- Final ZIP SHA256: `badcb722f03ffbb1676b8f210b7e9de62649ddcf289a8e6e72c3dcf42abc0c90`.
- Exact handoff assembled at `release/0.1.0-alpha.1/handoff/` with exactly DMG, ZIP, build-info.json,
  RELEASE_NOTES.md, and SHA256SUMS.txt.

### Stop point

No `/Applications` installation, Gatekeeper/Open Anyway action, TCC authorization, Input Monitoring
experiment, real physical mouse/Shift interruption, browser/provider/account/remote installed
regression, or restart/persistence run was performed. The candidate is ready for the separately
approved human installed-acceptance phase only; it is not yet daily-use accepted or public-distribution
ready. Developer ID signing and notarization remain deferred.

## 2026-09-24 installed UX repair continuation

The previously installed app was proven to be stale `fff67d4b`, ad-hoc signed, and different from the
validated handoff. It was not used as evidence. The final repaired handoff was built from `49d5fd6d`,
validated across the raw app, ZIP-contained app, and mounted DMG app, then installed through the
signature-preserving backup/staging/rollback runner.

### Installed reproduction

- Installed app: `/Applications/AceVra.app`, `com.acevra.desktop`, version `0.1.0-alpha.1`.
- Embedded build metadata: `buildCommitId=49d5fd6d`, profile `local-engineering-alpha`.
- Installed outer signature: `AceVra CUA Dev Signing`, hardened runtime, certificate-root DR.
- Previous stale app backup: `/Applications/.AceVra.app.backup-13155475-8ea0-45aa-b197-3533201bec5b`.
- Installed Computer Use Settings proof: visible `Computer Use` entry between Browser Use and Keyboard
  Shortcuts; clicking it mounted the real page with service-backed permission projection.
- Installed Computer Use permission result: Accessibility `Unknown`, Screen Recording `Unknown`; no
  active exclusive lease, so Stop was correctly hidden.
- Installed Codex proof: scan returned 44 candidates; cards showed meaningful first-user-message titles;
  Preview expanded the first card with bounded User and Assistant text before import.

The Codex account status displayed `Not connected` during this run; account/provider acceptance is not
claimed. The old menu observation was a stale-artifact/provenance issue, not a failure of the repaired
renderer.

### Repairs and final candidate

- `7b9b12a`: archive signing moved to Electron Builder `afterSign`; validator now checks archive-contained apps.
- `767e0fe`: bounded Codex conversation previews and expandable candidate cards using the existing sanitized parser.
- `cb6e28f`: package-aware E2E reads packaged build metadata and launches the packaged executable.
- `49d5fd6`: installed runner uses signature-preserving `ditto` copies.
- `8b917e8`: app tree hashing canonicalizes internal framework symlinks safely.

Final candidate paths:

- Build: `release/0.1.0-alpha.1/build-final-49d5fd6/`
- Handoff: `release/0.1.0-alpha.1/handoff-final-49d5fd6/`
- DMG: `release/0.1.0-alpha.1/handoff-final-49d5fd6/AceVra-0.1.0-alpha.1-arm64.dmg`
- ZIP: `release/0.1.0-alpha.1/handoff-final-49d5fd6/AceVra-0.1.0-alpha.1-arm64.zip`
- DMG SHA256: `b0bafdc4184308731b390f3b1153ca495483ccb19a18c625e2aaa9f54f31212a`
- ZIP SHA256: `bf29e846bdddb03c45789b4898c26c8499927f5b539dbf2ecd824ef67cbe6421`

Formal broader installed acceptance remains intentionally pending Gatekeeper/TCC/Input Monitoring,
Helper/CUA, physical interruption, browser, artifact, account/provider, remote, and restart checkpoints.

## 2026-09-24 Computer Use settings repair

The repaired `ab7c5b26` candidate now includes the official `computer-use@zcode-plugins-official`
package, its packaged manifest/skill/docs/client assets, a real admitted-Helper permission-status
relay, `available: true` service projection, a distinct Helper-unavailable UI state, permission
recheck UI, and typed macOS Privacy & Security fallback. The current installed app is this candidate;
the prior app is preserved at
`/Applications/.AceVra.app.backup-f9da983d-9bc1-41a5-9ccd-38bf6e8d0c5a`.

The non-E2E release handoff is `release/0.1.0-alpha.1/handoff-cua-ab7c5b2/`, with SHA256:

- DMG: `e6be095395fe2b9b9e370102bb435b6345841609901c360e3ad0e15e83d36b9d`
- ZIP: `42d071e1929f2feebb4f48f2b767ded770a173f04d7524f6bd95f77d539f8783`

Archive-aware validation passed for the raw app, ZIP-contained app, and mounted DMG app. The
package-aware E2E passed against a separate E2E-flagged build from the same source revision:
Computer Use navigation, real plugin enablement without `Plugin not found`, composer setting
consistency, Accessibility/Screen Recording packaged IPC boundaries, active Stop, and released
projection. OS launch was mocked only at the final E2E boundary.

The repaired candidate is installed but not formally accepted. Human action is now limited to:
open Settings → Computer Use, enable Computer Use, confirm no missing-plugin toast, click Open
Accessibility Settings, return, click Open Screen Recording, and report whether System Settings opens.
Do not change TCC permissions or run broader CUA acceptance yet.

## 2026-09-24 isolated alpha permission-state repair

The `1479bf4c` candidate fixes the confirmed HOME/ZCODE_HOME config-authority split, waits for
admission before product Helper start resolves, opens permission rows immediately, and queues a
second permission click instead of silently dropping it. The package-aware E2E now uses distinct
HOME and alpha profile roots and verifies isolated plugin config persistence.

Final handoff: `release/0.1.0-alpha.1/handoff-cua-1479bf4/`
Installed backup: `/Applications/.AceVra.app.backup-cfac4eea-f717-4872-b329-fc791a69c6ce`
Final hashes:

- DMG: `dd19725ac7532342794e42aa365133430838b803302bd424efb432bcaa54ef8c`
- ZIP: `d14c4d059ae91ec6c1ac43ac3f21db7353af0e7e3810ae98e82a0393035d8e38`

The candidate is installed but not formally accepted. Human action is limited to the two Settings
clicks and enablement check; no TCC changes or broader CUA acceptance is authorized yet.

## 2026-09-24 composer contradiction repair and duplicate cleanup

The installed `16af5e1` app showed the Computer Use composer failure tooltip even after the
canonical plugin was confirmed enabled. The source cause was state precedence in
`cuaComposerEntryState`: a shared stale plugin error was evaluated before the authoritative enabled
state. Commit `633de95` changes the projection so confirmed enablement suppresses stale prior
enablement errors, while the official-plugin error ownership helper remains unchanged.

Focused Computer Use UI state tests passed 4/4, including the stale-error-after-enable regression.
Typecheck, lint, and changed-file architecture checks passed. The full `633de95` local-alpha arm64
build completed after freeing generated build outputs; the first DMG attempt failed only because
`hdiutil` reported `No space left on device`. The retry completed successfully.

Final candidate:

- Build: `release/0.1.0-alpha.1/build-cua-633de95/`
- Validation: `release/0.1.0-alpha.1/validation-cua-633de95/`
- Handoff: `release/0.1.0-alpha.1/handoff-final-633de95/`
- Embedded revision: `633de95e`
- Embedded build time: `2026-09-24T14:49:09.812Z`

The raw app, ZIP-contained app, and mounted DMG app passed the archive-aware validator. The
current installed app remains `16af5e1` because AceVra was running when the new candidate became
ready; it was not force-killed. The new handoff is ready for installation after a normal app
shutdown.

After comparing embedded revisions, validation state, and installed provenance, superseded release
`build`, `validation`, and `handoff` directories were deleted. Only the `633de95` build, validation,
and handoff remain under `release/0.1.0-alpha.1/`; reports, logs, and `/Applications` backups remain.
No TCC permissions were changed and no broader acceptance was started.

## 2026-09-24 final Computer Use UI repair candidate

The source repair commit `16af5e1` (`16af5e11` embedded revision) contains the two requested UI
changes: the local-alpha reminder is gated by confirmed canonical plugin enablement and remains
visible while off/toggling/failed; the composer error tooltip now points to Settings → Computer
Use and no longer prescribes a blanket ZCode restart. The existing Helper/TCC ownership, lease
authority, CUA-3 powers, and CUA-4/CUA-5 boundaries were not changed.

Added deterministic UI state tests covering successful enablement, official-plugin failure,
unrelated-plugin failure, alpha-notice visibility, and the precise tooltip copy. Focused tests
passed 4/4; typecheck, lint, and changed-file architecture checks passed. Repository-wide
format checking remains blocked by unrelated existing formatting debt, while task-changed files
are formatted and `git diff --check` passes.

The package-aware E2E from the same source passed for packaged plugin assets, isolated
HOME/ZCODE_HOME config persistence, enablement without `Plugin not found`, notice disappearance,
composer setting, permission bridge calls, active Stop, and released projection. The final OS launch
was mocked only at the E2E boundary; no real TCC or System Settings behavior was claimed.

Final candidate:

- Build: `release/0.1.0-alpha.1/build-cua-16af5e1/`
- E2E build: `release/0.1.0-alpha.1/build-e2e-cua-16af5e1/`
- Validation: `release/0.1.0-alpha.1/validation-cua-16af5e1/`
- Handoff: `release/0.1.0-alpha.1/handoff-final-16af5e1/`
- DMG SHA256: `dec2634dcfd3044ccee3759f1f53bee1a935014fa8ae08ded40c2758c2fd7d6e`
- ZIP SHA256: `c8f0848f08abf014646f3ee1286ceed0c149e75406ed02480859e5b55521987f`

The raw app, ZIP-contained app, and mounted DMG app passed the archive-aware validator. The exact
five-file handoff passed checksum verification and was installed through the tested signature-
preserving backup/staging/rollback runner at `/Applications/AceVra.app`. The previous app is
preserved at `/Applications/.AceVra.app.backup-36bbc5f2-a228-4aa6-b619-1665611db0e2`; the earlier
`1479bf4c` backup remains at `/Applications/.AceVra.app.backup-cfac4eea-f717-4872-b329-fc791a69c6ce`.

Human verification is intentionally limited to the two requested UI behaviors: verify the alpha
notice disappears after enabling Computer Use, and verify the failure tooltip points to Settings
without restart wording. Do not change TCC permissions. Gatekeeper, Accessibility, Screen Recording,
Input Monitoring, physical interruption, browser, provider, artifact, remote, and restart acceptance
remain paused. No publish, tag, merge, CUA-4, or CUA-5 action is authorized.

## 2026-09-24 633de95 installed after duplicate cleanup

After AceVra was closed, the exact validated `handoff-final-633de95` was installed through the
signature-preserving backup/staging/rollback runner. The installed app metadata reports
`buildCommitId=633de95e`, `buildTime=2026-09-24T14:49:09.812Z`, and profile
`local-engineering-alpha`. The previous installed app is preserved at
`/Applications/.AceVra.app.backup-b3b3090a-3708-4530-b71a-6ff4ce0de198`.

Post-install checks passed: strict codesign verification, certificate-root designated requirement,
bundle ID/version verification, and embedded build metadata verification. No Node, Electron Builder,
Vite, or other build processes remained after installation. No TCC permissions were changed.

## 2026-09-24 permission cache contract repair

The installed `633de95` app still showed the composer enablement-failure tooltip after restart.
Runtime/source comparison identified the actual cause: the first-screen permission cache restored a
valid available Helper report without restoring `available: true`. The composer treated that display
cache as `unavailable`, then rendered the Helper failure as “Computer Use could not be enabled”.
Commit `6b5c721` restores the availability discriminator during cache validation and adds tests for
both the preserved available contract and rejection of unavailable/malformed payloads.

Focused cache and composer tests passed 6/6. Typecheck, lint, and changed-file architecture checks
passed. The full `6b5c721` local-alpha arm64 build passed archive-aware validation for the raw app,
ZIP-contained app, and mounted DMG app.

Final prepared candidate:

- Build: `release/0.1.0-alpha.1/build-cua-6b5c721/`
- Validation: `release/0.1.0-alpha.1/validation-cua-6b5c721/`
- Handoff: `release/0.1.0-alpha.1/handoff-final-6b5c721/`
- Embedded revision: `6b5c7210`
- Embedded build time: `2026-09-24T15:13:25.108Z`

The installed app remains `633de95e` because AceVra was still running when `6b5c721` became ready;
it was not force-quit. The stale `mock-cdn/releases/3.14.0` Node runtime cache (~571 MB) was removed.
The current `mock-cdn/releases/0.1.0-alpha.1` runtime remains because packaging uses it. No TCC
permissions were changed and no broader acceptance was started.

AceVra was subsequently closed gracefully, and `handoff-final-6b5c721` was installed atomically.
The prior installed app is preserved at
`/Applications/.AceVra.app.backup-9ea360ba-17d4-498f-83f5-2243a8768453`. Installed metadata reports
`buildCommitId=6b5c7210`; strict signature verification passed, and the updated app was relaunched.
The remaining human check is that the composer no longer shows the enablement-failure tooltip after
restart while Computer Use is enabled, and that the alpha reminder disappears after enablement.

## 2026-09-24 composer Agent presentation

Commit `48bea3c` generalizes the built-in composer backend’s visible name to **Agent** /
**智能体** while preserving its stable `zcode` runtime value, protocol fields, package identities,
test IDs, logs, and AceVra release identity. The Computer Use ready copy and backend description no
longer use ZCode as the user-facing actor.

The mode, backend, plan, and Computer Use controls now share a composer toolbar presentation
contract: 28 px hit target, compact outline affordance, semantic surface/border/hover tokens,
expanded-state surface, and a visible input-border-focused keyboard ring. Leading and task-option
clusters are semantic toolbars with localized accessible names. A new UI spec records the naming
boundary and accessibility invariants.

Focused composer/cache/Computer Use tests passed 9/9. Typecheck, lint, and changed-file architecture
checks passed. The full local-alpha arm64 build passed archive-aware validation for the raw app,
ZIP app, and mounted DMG app. AceVra was closed before the exact five-file handoff was installed
atomically; strict installed signature and embedded metadata checks passed, and the app was
relaunched. The immediate prior app is preserved at
`/Applications/.AceVra.app.backup-4d81e807-a6a5-4fd6-9c32-e90ea297664d`.

Superseded release directories were removed after installation. Only the `48bea3c` build, validation,
and handoff remain. `RELEASE_STATUS_REPORT.md` now records the cross-workstream state. No TCC
permissions were changed; broader acceptance remains paused.

## 2026-09-24 composer overlap repair

Installed `48bea3c` exposed a layout defect: the shared toolbar trigger class included `size-7`,
which locked text-bearing controls to a 28 px square. “Ask before changes”, “Computer Use”, and
“Agent” therefore overlapped in the wide composer. Commit `42a26cd` replaces that square contract
with a fixed 28 px height, a 28 px icon-only floor, `max-w-full`, and content-driven width when a
label is visible. The presentation spec and tests now explicitly prohibit a square width for
text-bearing toolbar controls.

The same candidate generalizes remaining composer entry copy: new-task and mobile placeholders plus
idle-time instructions now say “agent” / “智能体” rather than the internal product name. Stable
runtime values and identities remain unchanged.

Focused composer/cache/Computer Use tests passed 10/10. Typecheck, lint, and changed-file
architecture checks passed. The `42a26cd` build passed archive-aware validation for the raw app,
ZIP app, and mounted DMG app. AceVra was closed gracefully, the exact handoff was installed
atomically, and the app was relaunched. Installed metadata reports `42a26cdd`; strict signature
verification passed. The immediate prior app is preserved at
`/Applications/.AceVra.app.backup-d7520775-2db3-46c9-a747-978fe13317c4`.

Only the `42a26cd` build, validation, and handoff remain. The human check is now that composer text
expands normally without overlap, the Agent naming is visible, the CUA failure tooltip remains gone,
and the alpha reminder disappears after confirmed enablement. No TCC permissions were changed and
broader acceptance remains paused.

## 2026-09-24 Codex curated model selection

Commit `7cb9b1c` adds a working model selector for the Codex backend, per the approved plan
(Codex-only; Claude stays out because no Claude execution backend exists):

- Shared contract `CODEX_MODEL_OPTIONS` (exact allow-list): `gpt-6-astra`, `gpt-6-sol`,
  `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`; `null`/absent = Default sentinel
  (Codex app setting, no `model` field sent).
- Host: `thread/start` carries the curated `model`; non-curated ids fail loud
  (`codex_model_not_allowed`); selection persists in `ZCodeTaskMeta.codexModelId`, survives
  bridge-generation rebuilds, and is reflected in snapshot `config.model`.
- UI: new `V4ComposerCodexModelSelect` dropdown (Default + six models, with slug sublabels);
  draft persistence via `codexModelId`; SessionPane passes it to `createTask`.
- Focused tests: 27 Codex service/projection + 14 composer/cache/CUA state, all passing;
  typecheck, lint (0 errors), and architecture checks passed. Formatting churn that pushed two
  managed codex files over the 400-line cap was reverted to HEAD and logic re-applied compactly.

Installed candidate: `handoff-final-7cb9b1c` (embedded `7cb9b1c3`, built
`2026-09-24T17:37:42.132Z`), installed after graceful shutdown via the backup/rollback runner
(backup `.AceVra.app.backup-7d49b4df-84ad-477d-aad0-aba68cd24b0d`), app relaunched. Raw app,
ZIP app, and mounted DMG passed the archive-aware validator. No TCC changes; broader acceptance
remains paused.

## 2026-09-24 codex model control scope fix

User report: the Codex model dropdown “doesn't stay” and the selection had no effect. Root cause:
the interactive dropdown rendered in every Codex composer, but `onSelectCodexModel` was only wired
in draft mode — in a created Codex session the click was silently swallowed by a no-op callback,
so the selection reverted and nothing was applied. Commit `0716d27` makes the control form
explicit via `resolveCodexModelControlKind`: draft+codex = interactive dropdown; created session =
static thread-model indicator (locked at creation, tooltip explains); other backends = Agent
picker. Spec updated to forbid inert dropdowns.

Installed `handoff-final-0716d27` (embedded `0716d27d`) via the tested runner after graceful
shutdown; backup `.AceVra.app.backup-8ecc4f8d-23ce-42cf-b367-5771e348f02d`; validator passed for
raw/ZIP/DMG. Note: reasoning-effort routing for Codex (`model_reasoning_effort`) remains
unimplemented and is explicitly not claimed.

## 2026-09-24 codex model/effort transparency (`faeb0e5`)

Verified against the user's installed `codex-cli 0.155.0-alpha.16.4` (schema + live handshake):
`thread/start` accepts `model`; `turn/start` accepts `model` + `effort` overrides ("for this turn
and subsequent turns" — mid-session switching IS supported; earlier "thread-level lock" note was
wrong); Codex reports the adopted `model` and `reasoningEffort` in the thread/start response and
`Thread` object.

Repairs: wire/runtime/snapshot/meta now carry Codex's *reported* model/effort; turn-level
`codexTurnOverride` on v4 sendText applies per-turn model/effort (schema-strict, allow-list
fail-loud); composer shows a live model+effort dropdown in draft AND existing Codex sessions
(fixes the “locked composer” and “selection doesn't stick” symptoms); existing Codex sessions no
longer gate submission on the ZCode plan-model selection. Focused tests: 32 Codex + 9 UI passed;
typecheck/lint/architecture clean. Installed via the tested runner (backup
`.AceVra.app.backup-429bdc98-518c-43c1-ab14-2c033cffb861`); validator passed raw/ZIP/DMG. One
live verification turn was executed against the user's Codex account during protocol probing
(flagged separately; no further inference probes).

## 2026-09-24 composer unlock + stuck Codex turn recovery (`f75f6d2`, `8d96aa2`)

User report: composer showed "agent is working — follow-up input is paused" after the Codex turn
had already finished. Two defects, both fixed:

1. `f75f6d2`: `inputRouting.mode=reject` disabled the whole editor. Now only sending is blocked
   (`submitDisabled` via routing gate); the editor stays typeable so a follow-up draft is never
   trapped, and the placeholder explains the state.
2. `8d96aa2`: the installed Codex (0.155.0-alpha.16.4) sends `turn/completed` with
   `status/error/id` nested under `turn` (old top-level shape kept supported), and notifications
   arriving before their runtime registers were silently dropped — a dropped completion leaves the
   projection permanently `running`. Fixes: nested-shape parsing + bounded per-thread notification
   buffer replayed via `attachRuntime` on createTask and cold-recovery/bridge-generation paths.

Verified: 32 Codex + 9 UI tests, typecheck, lint (0 errors), architecture (0 violations), raw/ZIP/DMG
validator all passed. Installed via tested runner (backup
`.AceVra.app.backup-8784b2b6-a911-429f-9811-759bc8230558`), embedded `8d96aa26` confirmed, app
relaunched.
