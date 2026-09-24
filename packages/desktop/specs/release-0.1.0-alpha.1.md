# AceVra 0.1.0-alpha.1 local engineering alpha

## Decision and scope

This release is a macOS 12+ arm64 local engineering alpha. The root `package.json` version is the
single application-version source and must remain exactly `0.1.0-alpha.1`; workspace package
versions are not rewritten. The release profile is `local-engineering-alpha`, not a product
identity flavor.

The packaged application keeps the production identity `com.acevra.desktop` / `AceVra`.
Preview remains `com.acevra.desktop.preview` / `AceVra Preview` for existing preview builds, but
`ZCODE_PREVIEW_IDENTITY=1` is rejected when the local alpha profile is active. Internal package
names, the `zcode://` scheme, and other explicitly retained `@zcode` compatibility identifiers are
not renamed by this release.

Desktop main owns the compiled release profile, Electron roots, native-resource injection, and
installation guard. Services owns the shared data root, direct-home readers, Helper transport, and
authoritative lease record. CUA owns the Helper, peer session, foreground lease, event tap, and
native cleanup. Packaging owns the clean candidate and non-secret release sidecars. UI presents
release safety state but owns no Helper or lease state.

## Deterministic gate execution

The release gates run through the repository-pinned Node toolchain (`mise.toml` Node 24.14.0).
Root build and bundle scripts must preserve that toolchain for nested workspace processes; an
unsupported system Node is an execution error, not a reason to weaken the release artifact. The
release `bundle:desktop` entrypoint is alpha-scoped: it sets `local-engineering-alpha`, resolves
`release/0.1.0-alpha.1/build` as an absolute output directory, and rejects x64/universal targets
before Electron Builder runs. It still requires the isolated local signing identity and must
fail closed when that identity is unavailable. The candidate and installed-acceptance scripts
remain fail-closed when their required directories, arguments, signatures, or human checkpoints
are absent. Architecture checks also require every managed module to expose its declared
`module.ts` artifact; this release does not change the behavior of those modules.

## Profile and data isolation

`local-engineering-alpha` has these exact defaults:

- Electron user data: `~/Library/Application Support/AceVra Local Engineering Alpha`
- Electron session data: `~/Library/Application Support/AceVra Local Engineering Alpha/session`
- profile home: `~/.zcode-local-engineering-alpha`
- service data base: `~/.zcode-local-engineering-alpha`
- service state/config: `~/.zcode-local-engineering-alpha/.zcode/v2`
- Host `ZCODE_HOME`: `~/.zcode-local-engineering-alpha/.zcode`
- CUA root: `~/.zcode-local-engineering-alpha/.zcode/computer-use`
- model-I/O root: `~/.zcode-local-engineering-alpha/.zcode/cli`

`ZCODE_DESKTOP_HOME_DIR` and `ZCODE_DATA_BASE_DIR` are explicit profile roots. Either override may
be supplied alone. If both are supplied, their canonical real paths must match; different roots
fail with a profile/path conflict. Explicit overrides beat profile defaults and bootstrap values.
The profile is applied before any settings, provider, account, Host, MCP, trajectory, onboarding,
or CUA reader. It never imports production `.zcode/v2/setting.json`.

All user-level readers must resolve through the profile-aware paths service. In particular, MCP
sync's `~/.zcode` and `~/.agents` records and model-trajectory `debug`/`rollout` files must not
resolve from the OS home or search production before the alpha root. Workspace MCP paths continue
to use `workspacePath`; identity keys continue to use
`workspaceIdentity?.trim() || workspacePath`.

The profile disables normal and forced updater checks. The local alpha has no public update feed and
must not infer update availability from Preview, production, or a local `latest-mac.yml` file.

## Native CUA packaging and runtime

The alpha packaging command must build only the declared arm64 target. On an arm64 macOS
builder, the optional window-bounds helper is also arm64-only; x86_64 compatibility output is
not required for this named alpha and must not make the build fail on Apple Silicon hosts that
lack the x86_64 Swift compatibility libraries. General non-alpha packaging remains unchanged.

The candidate must contain working product CUA, not merely signed payloads. The product runtime
must use the declared public CUA entrypoints and automatically start the packaged Helper; it must
retain the existing fail-closed refusal for legacy/native-addon exports that have no product
consumer, but it must not ship the current unavailable product Host.

The exact packaged payloads are:

- `Contents/Resources/cua-helper/AceVra Computer Use.app`
  - bundle id `dev.acevra.cua-helper`
  - executable `AceVraComputerUse`
  - version `0.1.0-alpha.1`
  - deterministic numeric build number from release metadata
- `Contents/Resources/cua-helper/peer-identity-probe`
  - identifier `dev.acevra.cua-peer-identity.development` (preserved for compatibility)
- `Contents/Resources/cua-helper/helper-build-info.json`
  - non-secret relative/logical provenance only; no build-machine absolute path

The outer app, Helper, and probe are signed with the isolated stable self-signed
`AceVra CUA Dev Signing` identity and hardened runtime. The main app is not ad-hoc: its stable
certificate-root designated requirement is the host identity pinned by the Helper. The Helper keeps
its identifier-plus-certificate-root requirement, and the probe keeps its existing identifier and
requirement shape. Electron Builder must not re-sign the nested CUA directory. Missing,
ad-hoc-signed, wrong-requirement, wrong-architecture, or tampered components fail the candidate.

The development Harness remains `AceVra Computer Use Dev.app` with
`dev.acevra.cua-helper.development`; the product builder alone may emit
`dev.acevra.cua-helper`. There is no Developer ID identity, notarization, staple, or Apple
distribution claim. Gatekeeper rejection of this self-signed alpha is an expected human
checkpoint, not evidence of trust.

Packaged Helper and probe paths are injected from `process.resourcesPath` and consumed by the
services transport. An installed alpha must not require a developer to copy either component below
`ZCODE_HOME`. Candidate staging paths may exist, but the installed session must resolve and launch
the exact packaged resources and pin their verified requirements at session start.

The alpha builder accepts only macOS arm64. An x64 or universal request under this profile fails
before packaging; it must not embed an arm64-only Helper in another architecture. General CUA-3
universal support outside this named alpha is not changed.

Physical exclusivity must not depend on a replaceable user-writable pathname such as
`/tmp/acevra-cua-exclusive-<uid>.lock`. The native implementation must use an exclusion primitive
that a second same-uid Helper cannot unlink and replace to obtain a second physical lease. If this
cannot be demonstrated, release remains blocked; the plan must not narrow the CUA-3 serialization
claim to make the current implementation pass.

## Authoritative software Stop

One service-side lease record is the sole authority for lease id, owner session/task, verified
Helper requirement, generation, deadline, and terminal state. The model-facing runtime map is only
a projection and is removed or made explicitly non-authoritative.

The current node-repl host constructs the CUA runtime in a separate MCP process
(`apps/zcode-cli/packages/node-repl-host/src/server.ts`), so an in-memory services module cannot
observe that process's acquire/release map. A private, authenticated, `0700`/`0600` local
lease-authority sideband connects the authenticated node-repl CUA runtime to the services
authority. It uses a per-service random capability with constant-time comparison, a `0700` session
directory, a `0600` socket, and same-UID peer validation. It is injected only into the official
Computer Use MCP server, captured before general environment sanitization, and stripped from Bash,
tools, and every other child. It is not a model tool and does not reuse turn/session events as lease
state.

The sideband protocol is fail-closed and ordered:

```text
begin_acquire(owner/context) -> service generation reservation
  -> runtime calls Helper acquire_control
  -> commit_acquire(lease id + Helper identity)
  -> service publishes active projection
release_control | interruption | close | process disconnect
  -> service terminal generation
```

Software Stop serializes with `begin_acquire`: it waits for that admission to settle, releases a
newly committed lease, or returns `already_stopped` when no lease exists. A Stop that fences an
in-flight generation makes its later `commit_acquire` fail; the runtime must then release the
Helper lease immediately and may not publish it as active. Helper/host disconnect is also a service
terminal signal and does not depend on a model response.

Acquire, software Stop, model `release_control`, physical interruption, disconnect, and Helper
shutdown update the service record in order. Software Stop with no active service lease returns
`already_stopped`. A generation fence rejects a competing acquire until release and native cleanup
are terminal. Repeated software Stop remains idempotent at the service boundary even if a late
native `release_control` falls outside the Helper's short native replay window.

Software Stop is a typed service command, not a model-facing tool and not a raw `DesktopCommandId`
sent directly to the Helper. UI continues to call CUA through the service boundary. The command
releases the observed lease with stored owner credentials, waits for terminal Helper/service
confirmation, and prevents later posts from the old generation.

## Release artifacts

Packaging, validation, and handoff use separate no-clobber directories under
`release/0.1.0-alpha.1/`:

- `build/`: raw Electron Builder output, including DMG/ZIP blockmaps and `latest-mac.yml`; it is
  inventoried and validated but never cleaned merely to make a handoff
- `validation/`: exact verified copies of the unpacked app and two archives plus non-secret
  validation/source-inventory reports used to assemble the handoff
- `handoff/`: final release handoff, created only after validation succeeds

The final `handoff/` root contains exactly these five files:

1. `AceVra-0.1.0-alpha.1-arm64.dmg` — the required DMG name
2. `AceVra-0.1.0-alpha.1-arm64.zip`
3. `build-info.json`
4. `RELEASE_NOTES.md`
5. `SHA256SUMS.txt`

Assembly copies only the two already-verified archives from `validation/` into a unique sibling
staging directory, generates the three sidecars from actual verified files, validates the exact
five-file allowlist and checksums, and atomically renames the completed staging directory to
`handoff/`. It never deletes an unexpected build file before inventorying and classifying it. If
`validation/`, the staging directory, or `handoff/` already exists, assembly refuses to clobber it
and requires a new run directory or an explicit human decision after preserving the prior evidence.

There are no `*-mac-arm64.dmg`/`zip` names, stale Preview archives, `latest-mac.yml`, blockmaps, or
locator files in the accepted handoff because this profile has updates disabled. They may remain in
`build/` as raw builder evidence.

The candidate validator checks the exact root version, production identity, executable and Helper
architectures, exact verified archive set, packaged native paths, relative-only provenance,
Helper version/build, strict app/Helper/probe signatures, stable certificate fingerprint and
designated requirements, and scans for secrets, private keys, personal files, repository-relative
runtime dependencies, `/tmp` runtime dependencies, and developer absolute paths. `codesign -d/-dv`
details must be read from stderr as well as stdout. A successful ZIP integrity check or DMG image
verify is necessary but never sufficient for candidate acceptance.

## Smallest release-safety UX

Do not add a new onboarding step or automatic CUA enablement. In the existing Computer Use settings
surface, provide one compact release-safety block that states:

- this is the local engineering alpha;
- the app and Helper are self-signed and non-notarized;
- CUA is off until explicitly enabled and Accessibility/Screen Recording are granted to
  `AceVra Computer Use.app`;
- the alpha data root and that updates are disabled;
- no model/provider inference, provider request, credential prompt, or account authentication is
  part of install/verification.

Reuse the existing permission rows and return-recovery flow. Add one software **Stop computer
control** action, visible and enabled only while the authoritative service lease is active; repeated
activation is safe. Replace visible stale `ZCode` branding only on touched AceVra release-safety and
permission surfaces, and use the mandatory `text-ui-*` typography scale. Do not rename internal
compatibility identifiers while doing so.

Provider selection is never inferred from a first registry entry, model id, base URL, account
family, or app branding. Packaging and installed acceptance perform no provider inference and no
inference request.

## Installed acceptance and human checkpoints

The implementation must add the exact candidate-aware runner
`scripts/release/accept-local-alpha-installed.mjs` and root script
`release:accept:installed`. It consumes the validated `handoff/`, never the raw `build/`, and records
only non-secret evidence. It must not substitute a development app, source checkout, modified build,
or shipped stub for installed-app evidence.

Replacement is a no-clobber transaction:

1. resolve `/Applications` without following a target symlink; inspect existing
   `/Applications/AceVra.app` version, signature, DR, tree hash, owner/mode, and provenance
2. refuse ambiguous provenance; require the app to be fully quit, including Helper/Agent children,
   and never terminate or overwrite a running app automatically
3. create a uniquely named sibling backup and a uniquely named sibling staging copy from the
   validated app fixture; both use runner-owned markers and never `rm -rf` the target
4. verify the backup and staging tree hashes, identities, architectures, permissions, and strict
   signatures before touching the target
5. rename the existing target to a unique rollback sibling, then atomically rename staging into
   `/Applications/AceVra.app`; if either rename fails, restore the rollback before exiting
6. re-verify the installed tree against the validation manifest and retain the backup/rollback until
   all acceptance completes; failure restores the original, success requires a separate human
   decision before backup removal

The first installed launch must use
`/usr/bin/open --env ZCODE_HTTP_PROXY=<sink> --env ZCODE_AGENT_CA_CERT=<ca>
/Applications/AceVra.app`, never direct execution of `Contents/MacOS/AceVra`. The runner records
the expected Gatekeeper rejection and pauses for the human **Open Anyway** decision before any data,
network, TCC, Helper, Stop, or physical behavior. If the expected first-launch rejection is not
observed, the Gatekeeper proof is non-fresh and acceptance remains blocked. After admission,
exact-binary observation may reconnect through LaunchServices using
`/usr/bin/open -a /Applications/AceVra.app --args --remote-debugging-port=<loopback-port>` and
Playwright CDP; it still must not directly spawn the executable. Failure of Gatekeeper observation
blocks acceptance.

The no-inference boundary is fail-closed and covers the installed app plus every discovered child:

- a local `NetworkCaptureService` sink records HTTP/HTTPS/WS/WSS request class, host, redacted path,
  and byte counts; it never records bodies and must redact URL userinfo/query values as well as
  authorization/cookie/API-key headers;
  `/usr/bin/open --env ZCODE_HTTP_PROXY=<sink> --env ZCODE_AGENT_CA_CERT=<ca>` passes the sink
  environment through LaunchServices, and packaging/dependency downloads occur before this
  observation window and are recorded separately
- `/usr/bin/nettop -L 0 -s 0.1 -j pid,process,state,interface,bytes_in,bytes_out` samples all
  TCP/UDP sockets, and `ps -axo pid=,ppid=,command=` refreshes attribution for the installed process
  tree; unattributed external activity during the window is a conservative failure
- `/usr/bin/log stream --style ndjson` with a fixed DNS/network-service predicate records those
  events during the window; any event that cannot be excluded from the observation window fails
  acceptance
- CDP inspection records credential/account dialogs and app service calls
- failure to start, attach, attribute, or collect any observer fails closed; an attempted DNS, TCP,
  TLS, provider, credential, or account flow fails acceptance even if no response completes

Before TCC authorization, the runner starts the exact signed Helper in non-prompting permission
probe mode and records its designated requirement plus Accessibility and Screen Recording status. If
the current product requirement is already trusted for either permission, the checkpoint is marked
non-fresh and blocks. The human removes that entry manually in System Settings, restarts the Helper,
and must observe denied/untrusted before fresh authorization. `tccutil` is not used to manufacture a
fresh result.

The renderer/Electron interaction change also requires an automated E2E scenario, not only the
installed drill. The implementation adds
`packages/desktop/e2e/cua-release-safety.e2e.mjs` and package script `e2e:cua-alpha`, run as:

```bash
mise exec -- node scripts/mise-run.mjs pnpm --filter @zcode/desktop e2e:cua-alpha
```

It covers safety-copy rendering, CUA off by default, no Stop before a lease, active Stop, repeated
Stop, and released-state UI using the existing E2E build/run-id gate or a test-only fixture reachable
only when both are present.

After Gatekeeper and fresh TCC, installed acceptance proves isolated roots and untouched production
sentinels; no provider/model request or inference; updater inactivity; automatic packaged
Helper/probe resolution and launch; correct Helper identity; CUA opt-in; software Stop and
held-input/event-tap cleanup; and restart persistence. The final human sequence is software Stop,
then real mouse movement and real Shift press/release to prove interruption and cleanup. Synthetic
events cannot satisfy the physical-input checkpoint.

Release stops after recording these results. It does not attempt public distribution or a broader
platform rollout.

## Approved non-goals and blockers

No Developer ID, Apple notarization, staple, Mac App Store or public DMG distribution, public
publish, push, tag, merge, public updater, CUA-4/CUA-5, private-desktop/VM support, Windows/Linux
native CUA, Intel/x64/universal candidate, account/provider migration, or compatibility identifier
rename is in scope.

The candidate is blocked until the runtime product Host is live, packaged resources are discovered
automatically, stable outer-app signing is enforced, build/validation/handoff are separated and the
five-file handoff is assembled without clobbering, archive/provenance validation passes, both
remaining direct-home readers are isolated, the authenticated node-repl-to-services lease sideband
and service-owned software Stop are proven across processes, the native exclusive lock cannot be
replaced by a second same-uid Helper, the desktop CUA E2E passes, the no-clobber `/Applications`
transaction and fail-closed network observation pass, fresh TCC evidence is recorded after
Gatekeeper admission, required tests/builds pass, and all human checkpoints are recorded. Existing
container integrity or a zero exit from Electron Builder is not acceptance.
