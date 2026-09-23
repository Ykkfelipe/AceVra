# Computer Use permission and identity foundation

Scope: the macOS permission/identity contract for the first-party Computer Use Helper — who
owns the TCC grants, how the Helper is signed and installed, what survives a rebuild, and
what CUA-1 may assume. Feature behaviour (observation, AX actions, input) is out of scope
here; see `docs/COMPUTER_USE_ARCHITECTURE_SPIKE.md` for the capability decisions and
CUA-1 assumptions.

Status: measured on macOS 27.0 (26A428), arm64, against a real helper built from this
repository. Every claim below is backed by an archived run under
`spikes/cua-05-identity/evidence/20260923-035037/`; the harness that produced it ships with the
helper (`packages/zcode-cua/native/cua-helper/`).

Provenance: the authoritative rows are that run's `final/` subdirectory, produced in one pass
from a frozen helper source whose sha256 is printed on every row of `final/matrix.log`
(`f816681e…`), with the launch commands in `final/commands.log` and every number re-derivable via
`verify-cua05-claims.py`. Rows in the parent directory
are the earlier exploratory pass and some predate the final helper revision; where the two
disagree, cite `final/`.

## Behavior

The Helper is a separately signed `.app` with its own bundle id. It is launched through
**LaunchServices** (`/usr/bin/open` with `--launcher-pid`, the argument shape the contract
documents — note that `buildHelperOpenArgs` is a fail-closed placeholder returning `[]` in this
fork, so the harness constructs that shape itself), and it holds **its own** Accessibility and
Screen Recording grants. The user authorizes the Helper
by name in System Settings; ZCode itself is not the grant subject for the Helper's TCC
checks.

macOS attributes a grant to the _responsible process_. Under LaunchServices the Helper is
its own responsible process (`ppid = 1`), so it is granted or denied on its own identity.
`ZCODE_CUA_LAUNCHER_PID` is published by the desktop main process and forwarded as
`--launcher-pid`, but it exists for **peer verification of the caller**, not for permission
inheritance: it confers no TCC grant (measured — see the LaunchServices rows below).

### Permission owner model

| Question                                                                  | Answer                                                                                                                            | Evidence                                                                                                |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Who owns the grant?                                                       | The Helper bundle, per (bundle id + code requirement)                                                                             | `L2-open` vs `L1-exec`                                                                                  |
| Does the app's grant flow to the Helper?                                  | Only when the Helper is an `exec` child inside the app's process tree — **not** through the LaunchServices path the contract uses | `L1-exec`: `ax=true`, capture OK; `L2-open`: `ax=false`, capture refused with `ppid=1`                  |
| Does `--launcher-pid` grant anything?                                     | No. A never-granted control bundle launched by LaunchServices is denied with the flag and without it                              | `final/R3-ctl3-with-launcherpid` and `final/R3-ctl3-without-launcherpid`: `ax=false`/`sr=false` in both |
| Is the grant per-bundle-id?                                               | Yes. Two identically signed control bundles at the same path stayed untrusted while the authorized one was trusted                | `L5-control`, `CTRL2b` (`ax=false`)                                                                     |
| Does an `exec` + `AXIsProcessTrustedWithOptions(prompt:)` create a grant? | No — this was tested explicitly and refuted, so the trusted state cannot appear without a user decision                           | `CTRL2a` (exec, prompt → `ax=true` via inheritance) then `CTRL2b` (LaunchServices → `ax=false`)         |

### Signing model

The grant is bound to a **code requirement**, not to a hash of the binary:

```
designated => identifier "<bundle-id>" and certificate root = H"<certificate sha1>"
```

An ad-hoc signature has no stable requirement (its cdhash is the requirement), so every
rebuild produces a new cdhash and the grant is lost. Therefore:

- **Development** uses a dedicated self-signed certificate (`AceVra CUA Dev Signing`) created
  by `signing/create-dev-signing-identity.sh` in a dedicated keychain under the isolated CUA
  namespace. The certificate is deliberately **not** trusted system-wide (no user trust
  settings are written) — `codesign` signs with it regardless, and TCC honours the resulting
  requirement. `spctl` will reject the bundle, which affects distribution, not TCC.
- **Production** must use a Developer ID, giving a Team-anchored requirement
  (`anchor apple generic and certificate leaf[subject.OU] = "<team>"`) — the same mechanism
  as the shipped product Helper. That specific requirement shape is **not measured here**
  (no Developer ID exists on this machine); the persistence property it depends on is the
  same one measured below, because TCC keys on the requirement either way.

### Install path

Resolved by the existing contract, unchanged by this work:

| Variant     | Path                                                        |
| ----------- | ----------------------------------------------------------- |
| production  | `<ZCODE_HOME>/computer-use/AceVra Computer Use.app`         |
| preview     | `<ZCODE_HOME>/computer-use/preview/AceVra Computer Use.app` |
| development | `<ZCODE_HOME>/computer-use/dev/AceVra Computer Use Dev.app` |

Development and preview use separate sub-roots because their build ids differ and a shared
root would let one install overwrite the other. `ZCODE_HOME` resolves below the runtime's
own data root, so the custom-fork runtime never writes the product's `~/.zcode`.

## Ownership and invariants

- **One owner per grant:** the Helper bundle owns its TCC grants. The desktop main process
  owns the decision to launch it and the `--launcher-pid` value; it must not keep a second
  notion of "granted" that competes with the Helper's own probe.
- The contract declares `grantOwner`/`grant_owner` (`packages/zcode-cua/broker.d.ts`) as the
  identity TCC attributed to, which under LaunchServices is the Helper itself; the settings UI
  displays it so the user can find the right row in System Settings. **The CUA-0.5 helper does
  not report this field yet** — its report carries `identity.bundleId` and
  `identity.designatedRequirement` instead. Populating `grant_owner` from the Helper's own
  verified identity is a CUA-1 task, not something this phase measured.
- **Signature is the identity.** The Helper must never be built with the product's Helper
  bundle id (`dev.acevra.cua-helper`): an installed product Helper already holds a grant under
  that id, so reusing it both collides with the product install and makes any permission
  measurement meaningless. `build-dev-helper.mjs` refuses to build with it.
- **The launch relationship is not an identity.** Because LaunchServices detaches the Helper
  (`ppid = 1`), no parent-pid or process-tree check can authenticate the caller. Any peer
  check must resolve the caller's pid to a code signature and validate it against the
  expected requirement.
- Every helper run self-reports its own bundle id, cdhash and designated requirement, so an
  archived observation is attributable without extra tooling.
- The Helper never implements pointer or keyboard synthesis. Pointer input is
  `REQUIRES_FOREGROUND` per the capability decision; nothing in this foundation depends on it.

## Persistence matrix (measured)

All rows are LaunchServices launches of the same bundle id and path. "granted" means
`AXIsProcessTrusted() == true` for Accessibility and a real ScreenCaptureKit capture that
returns non-blank pixels for Screen Recording.

| Case                                       | cdhash                           | requirement             | Accessibility | Screen Recording               |
| ------------------------------------------ | -------------------------------- | ----------------------- | ------------- | ------------------------------ |
| baseline                                   | `b284522c…`                      | `f89ef775…`             | GRANTED       | GRANTED (1470×956, 42 colours) |
| A helper process restart                   | unchanged                        | unchanged               | GRANTED       | GRANTED                        |
| C rebuild, same identity                   | `e62b809c…` changed              | unchanged               | GRANTED       | GRANTED                        |
| D reinstall/replace at same path           | `24aff175…` changed              | unchanged               | GRANTED       | GRANTED                        |
| E version + build-number change            | `895bbf4f…` changed              | unchanged               | GRANTED       | GRANTED                        |
| later rebuilds in the same session         | `ac0c9743…`, `91afe3fe…` changed | unchanged               | GRANTED       | GRANTED                        |
| S rebuilt with a **different** certificate | `5ef4ddaf…`                      | `4dcf904d…` **changed** | LOST          | LOST                           |
| S restore the original identity            | `8acace10…`                      | `f89ef775…`             | GRANTED again | GRANTED again                  |

F: an Electron rebuild is not applicable — the Helper is a separate signed process that does
not link against or live inside the Electron bundle, so rebuilding the app cannot change the
Helper's requirement. Reinstalling the _app_ at the same path is likewise irrelevant for the
same reason; what matters is the Helper bundle, covered by C/D/E.

**Result:** a Helper keeps both grants across restart, rebuild, reinstall at the same path,
and version/build changes, and no TCC churn or re-authorization is needed — provided the
signing identity is stable. Changing the certificate loses both grants, and restoring the
identity restores them again. That restore is the evidence that the stored decision survived the
mismatch — with the caveat that "no user action occurred" is _inferred_ from the matrix being
non-interactive end to end (it runs in seconds and prompts nothing), not instrumented: nothing
in the archive observes the absence of a click.

## Restart requirements (measured)

A single helper process was granted both permissions while it was running, sampling its state
every second. **Sample times are offsets from the start of the watch, not from the grant** —
the grant moment is not observable in this run, so no propagation delay is claimed:

| Sample                     | Accessibility | SR preflight | Real capture                      |
| -------------------------- | ------------- | ------------ | --------------------------------- |
| before the grant           | `false`       | `false`      | refused: "The user declined TCCs" |
| +7 s                       | `false`       | `false`      | **works** (non-blank frame)       |
| +37 s                      | **`true`**    | `false`      | works                             |
| a fresh process afterwards | `true`        | **`true`**   | works                             |

- **Accessibility and Screen Recording capability require no restart.** The already-running
  process observed both: capture succeeded by the +7 s sample and AX trust read true by the
  +37 s sample, with no new process. **No propagation delay is measured**, so none is claimed:
  those are offsets from watch start, the user's toggle time is unobservable, and the grant may
  have landed immediately before either sample. This run therefore does _not_ establish that
  the UI's 6 s restart-verify timeout (`cuaPermissionRestartVerify.ts`, `DEFAULT_TIMEOUT_MS`)
  is too short — that needs a grant time the observer can see. What it does contradict is the
  in-repo comment that a running Helper cannot observe an Accessibility grant without a
  restart: this process did. The readout lag that is real belongs to the preflight API below.
- **`CGPreflightScreenCaptureAccess()` is process-cached.** In the process that had already
  called it before the grant it stayed `false` while capture worked, and it only reported
  `true` in a fresh process. The settings UI must therefore treat the **functional capture
  probe** (`screen_capture_probe_ok` / `queryScreenCaptureProbe`) as the Screen Recording
  truth, and must not report "denied" from preflight alone.
- **Operational restart rule:** no restart is needed to _use_ a new grant. Restarting the
  Helper is the reliable way to refresh a _stale readout_, and only that. The UI's existing
  ladder (restart Helper, then restart the app) stays valid as a readout refresh, but its
  6 s poll window is short relative to the ≤37 s propagation observed here, so a timeout must
  not be presented as "authorization failed".

## Stale-state semantics

`stale` is a real, reachable macOS condition — but it is **not** distinguishable from
`denied` by a single preflight call, and it is not what `AXIsProcessTrusted` alone reports.
Two conditions were reproduced:

1. **Requirement mismatch.** The bundle id and path are unchanged and the user's decision is
   still stored, but the binary on disk no longer satisfies the stored requirement (in the
   measurement: re-signed with a different certificate). Preflight reports exactly what
   `denied` reports — `false` — while the persisted decision still exists, proven by the
   grant returning with no user action once the original identity was restored.
2. **Process-cached readout.** A long-running process keeps reporting the pre-grant answer
   from a cached preflight call after the capability has actually become available.

Operational definition to implement: **`stale` = this identity held a grant that the current
binary can no longer use, or a readout that a fresh probe contradicts.** Concretely the owner
of the state must remember "we have seen this bundle id granted" and compare the current
quality signal against it:

- granted → preflight (or functional probe) is positive;
- stale → a grant was previously observed for this bundle id, and the current binary reports
  untrusted, or a cached readout disagrees with a functional probe;
- denied → no grant has ever been observed and the probe is negative.

This cannot be derived from the OS alone, so the enum is computed by the permission-service
owner from state it already persists. Do not invent a third OS API to "detect stale": none
exists, and the two conditions above are what the label actually means.

## Development and production identities

The integrated fork and the product are named **AceVra**. The active development Helper is
`dev.acevra.cua-helper.development`; the production Helper remains `dev.acevra.cua-helper`.
These are the only active Helper identities accepted by the integrated build. The historical
`dev.zcode.cua-helper*` identifiers below are retained only to describe frozen CUA-0.5 evidence;
they are not compatibility allowances in the active launcher or broker policy.

| Purpose              | Active identity                                 |
| -------------------- | ----------------------------------------------- |
| App (production)     | `com.acevra.desktop` (`AceVra`)                 |
| App (development)    | `com.acevra.desktop.development` (`AceVra Dev`) |
| Helper (production)  | `dev.acevra.cua-helper`                         |
| Helper (development) | `dev.acevra.cua-helper.development`             |

`zcode://` stays untouched regardless of the rename, because it remains an OAuth
compatibility requirement.

Migration implications of the rename: **a bundle id is part of the TCC requirement**, so
renaming a Helper creates a _new_ TCC identity and every user must authorize it once more;
the old rows remain in System Settings until removed. The CUA-0.5 measurements used the
fork's current in-contract development id (`dev.zcode.cua-helper.dev`) and are kept under it
on purpose — rewriting them to the AceVra id would have silently invalidated the archived
grant proof. The mechanics measured here (requirement-bound persistence, restart behaviour,
stale conditions) are identity-agnostic and carry over unchanged.

## Security implications

- **Grants are requirement-bound, so the Helper cannot be trivially replaced.** A different
  executable at the same path does not satisfy the stored requirement and does not inherit
  the grant: the control bundles and the "different certificate" case both measured
  untrusted. An attacker without the signing key cannot mint a binary that satisfies the
  requirement.
- **A trusted grant is not a whole-binary integrity guarantee.** Measured
  (`final/tamper.log`, cases A–E, five distinct pids): changing one byte inside `__text`,
  changing one byte inside `__cstring`, and appending bytes past the signed code limit all make
  `codesign --verify` fail (`rc=1`), and in every case the bundle still launched through
  LaunchServices and still held **both** grants. `tccd` checks the _requirement_ against the
  embedded signature blob, which none of those edits touched; it does not re-hash the code
  windows. So possession of the grant proves the requirement was satisfied, not that the image
  on disk matches what we built. Integrity decisions must call code-signature validation
  explicitly (`SecCodeCheckValidity` with strict/all-architecture flags) — which is exactly the
  check that would catch these edits.
- **The parent process is not an authenticator.** Under LaunchServices the Helper's parent is
  `launchd` (`ppid = 1`), so `getppid()` carries no information about who asked for the
  launch. `--launcher-pid` must be validated by resolving that pid to a code signature and
  checking it against the expected requirement; a pid alone is trivially spoofable.
- **Broker channel authentication is inherited, not built here.** The contract already
  carries a token/`pluginAuthority` transport for the broker; this foundation only proves the
  identity the channel can be bound to. CUA-1 must keep verifying the peer's signature before
  honouring broker requests, and must not rely on the TCC grant as a stand-in. **Superseded in
  part by CUA-1** (see "Helper identity verification" below): the peer _is_ resolved to a code
  signature and validated on every connection, and a launcher-configured expectation is enforced,
  but CUA-1 configures no expectation because the launcher that would supply one is still a stub —
  so today the caller identity is verified evidence rather than a gate. That gap is named there
  rather than left as an unsatisfied "must".
- Not measured here (and therefore still assumptions): broker token enforcement, the
  `same_pid_keyboard_ambiguity`-style route guards, and anything requiring a Developer ID.

### Development-identity portability caveats

- The requirement is anchored to the **certificate's SHA-1**, so the identity is stable on this
  machine but not across machines: regenerating the certificate (a fresh machine, a deleted
  keychain, or `--force`) yields a new requirement and every grant must be given again. The
  create script is idempotent for this reason and reuses an existing identity.
- The keychain auto-locks (after 6 h, and on sleep). The create script unlocks on its reuse
  path as well as its create path, and the build signs with an explicit `--keychain`; if a build
  fails on a locked keychain, run `security unlock-keychain -p "$(cat
<signing-dir>/keychain-password)" <keychain>` first.
- The certificate expires 2036-09-20. Rotation is not addressed here: a rotation is a new
  requirement and therefore a re-grant.
- The password file is `0600` inside the isolated namespace and is a development-only secret,
  not a product credential.

## Failure semantics and migration boundary

- If the signing identity is unavailable, `build-dev-helper.mjs` fails rather than falling
  back to ad-hoc signing, because ad-hoc signing silently produces a grant that dies on the
  next rebuild. The contract's explicit local-development escape hatch
  (`ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL`) is honoured only when asked for, and the mode is
  printed and recorded in the report so an unsigned run cannot be mistaken for a signed one.
- Removing the signing keychain, the dev helper bundle and the evidence directory restores
  the machine to its prior state; the only durable system-side effect is the TCC entry for the
  development helper id, which `tccutil reset Accessibility|ScreenCapture <bundle-id>` removes.
- No product bundle id, and no existing installed Helper (the product's own installs under
  `~/.zcode/computer-use/`) is read, written or re-signed by this work.
- Nothing here is wired into packaging: the dev helper is never bundled into the app. When
  CUA-1 wires a real Helper, it must reproduce this identity model rather than inherit one.

## Acceptance

1. A new dev helper builds, is signed by the dedicated identity, and reports a designated
   requirement containing its bundle id and certificate root.
2. Launching it through LaunchServices is untrusted until the Helper itself is authorized —
   asserting that no test inherited permission from the app that launched it.
3. After authorization, restarting the Helper, rebuilding it, deleting and reinstalling it at
   the same path, and changing its version/build numbers all leave both grants intact.
4. Re-signing with a different certificate loses both grants, and restoring the original
   identity restores them without any new user action.
5. A helper granted while running observes Accessibility and Screen Recording capability
   without a restart, and the functional capture probe is used instead of SR preflight for
   the granted/denied readout.
6. `stale` is computed from persisted prior-grant state plus the current probe, and never
   asserted from a single negative preflight.
7. `packages/zcode-cua/native/cua-helper/verify-cua05-claims.py <run-dir>` re-derives every
   number quoted above from the archived artifacts and exits non-zero on any mismatch
   (41/41 passing as of this writing; output archived as `final/claim-verification.log`).
8. A different executable at the same path does not inherit the grant (a control bundle and a
   mismatched certificate both measured untrusted). Editing the signed binary in place leaves
   `codesign --verify` failing while the grant survives, so any integrity decision must call
   `SecCodeCheckValidity` rather than trusting the grant.

## CUA-1 assumptions

CUA-1 may assume exactly this and nothing more:

- The Helper is its own TCC owner and is launched via LaunchServices with `--launcher-pid`;
  the app's own grant does **not** cover the Helper.
- A stable signing identity is a prerequisite; a rebuild with the same identity preserves
  grants, so the permission onboarding flow does not need to run again after an update.
- Screen Recording must be judged by a functional capture probe (window-scoped capture),
  never by preflight, and never by System Settings appearance.
- No restart is required to use a freshly granted permission; a Helper restart is a readout
  refresh, and tccd propagation can take up to tens of seconds, so onboarding must poll
  rather than fail.
- Accessibility is read via the Helper's own AX authorization; `AXIsProcessTrusted()` is the
  authority, and the granted/denied/stale verdict is computed by the permission owner.
- Pointer input remains `REQUIRES_FOREGROUND` and is not covered by this foundation.

---

# CUA-1 — observe-only helper behind the broker contract

This section is the implementation authority for CUA-1. It extends the permission/identity
foundation above; the capability decisions (pointer input is `REQUIRES_FOREGROUND`, background
AX/keyboard/screenshot are the measured background-safe rungs) come from the archived spike at
tag `acevra-cua-foundation-v1` and are not re-opened here.

CUA-1 delivers **observation only**. It implements `permissions`, `list_apps`, `list_windows`
and `observe`, replaces the fail-closed stub with a real `createComputerUseRuntime` **for
observe-only tools only**, and degrades gracefully when a grant is missing. No input synthesis
of any kind is added: no AX actions, no keystrokes, no pointer events. Every mutating tool name
stays fail-closed, unchanged.

## Broker wire format

The contract in `packages/zcode-cua/broker.d.ts` declares the shape but ships as a fail-closed
placeholder; CUA-1 fills the stubs rather than adding a second package, so the format has to be
written down once. It is deliberately minimal and boring to reconcile at integration:

- Transport: a Unix domain socket, one JSON object per line, UTF-8, `\n`-terminated.
- Request: `{ "id"?: string | null, "method": string, "params"?: object }`.
- Success response: `{ "ok": true, "result": <object> }`.
- Failure response: `{ "ok": false, "error": { "message": string, "code": string } }`. The nested
  shape is what `errorResponse` in `packages/zcode-cua/broker.js` already returned before CUA-1,
  so the helper matches the existing choice instead of rewriting it.
- The response echoes `id` when the request carried one, so a client can correlate.
- An unparseable line yields a `bad_request` failure response and the connection stays usable;
  a line that is not valid UTF-8 JSON is not allowed to kill the server.
- Response size is capped by the client (`32 MiB` in the node_repl bridge); the helper never
  emits an unbounded payload — screenshots are referenced, not inlined (see below).

Method classification lives in one place (`isBrokerMethod` / `isReadOnlyBrokerMethod`) because
it is the gate that decides what the runtime is allowed to expose. CUA-1 registers exactly:

| Method              | Kind      | Notes                                                                                                                                                                                                         |
| ------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permission_status` | read-only | the shape `services/node.ts` already consumes: `grant_owner`, `owner.display_name`, `accessibility`, `accessibility_probe_ok`, `screen_recording`, plus the readout/probe split and the identity blocks below |
| `list_apps`         | read-only | running applications, regular activation policy only                                                                                                                                                          |
| `list_windows`      | read-only | layer-0 windows with owner pid, bounds, z-order and an `on_screen` flag                                                                                                                                       |
| `observe`           | read-only | one window: ScreenCaptureKit capture plus the AX tree                                                                                                                                                         |

Anything else is `not_authorized`. The read-only set is exactly the set the runtime may expose
while every mutating tool remains fail-closed.

Every result also carries `helper_identity`, the identity the Helper verified for itself (below),
so the identity is attached to the answer a caller actually uses rather than to a separate
handshake.

## Helper identity verification (added by CUA-1, measured)

A socket path is not an identity: anything that can write into the runtime data root can bind
`helper.sock` and answer. The grant is not one either — CUA-0.5 measured that a TCC grant survives
edits to the signed image. CUA-1 therefore verifies code signatures explicitly, in both directions
of the hop, and refuses rather than guesses.

**The Helper verifies itself** (`native/cua-helper/CodeIdentity.swift`). Three checks run before a
report is trusting:

1. `SecCodeCheckValidity` on the running code object — the process satisfies its requirement;
2. `SecStaticCodeCheckValidity` on a **freshly opened on-disk image** with
   `kSecCSStrictValidate | kSecCSCheckAllArchitectures`;
3. `SecCodeCopySigningInformation` on that validated image, so `grant_owner` is the signed
   identifier rather than `Bundle.main.bundleIdentifier` (a claim the process makes about itself).

Step 2 is not decoration, and the measurement is why: validating the static code _derived from the
running process_ (`SecCodeCopyStaticCode`) **passed** on a binary whose `__text` had been edited,
because that process was validated when it was executed. Re-opening the image from its own path
re-hashes every slice and caught the same edit (`errSecCSSignatureFailed`, -67061). A Helper whose
self-check fails refuses every request with `helper_identity_unverified`; it still binds the socket
and answers, so the failure is diagnosable rather than a silent hang.

**The client verifies the Helper** (`packages/zcode-cua/broker.js`). `callBrokerMethod` — the one
function `createComputerUseRuntime.execute` uses — runs `assertHelperIdentity` on every response on
macOS (the check is a macOS code-signature check; the scoping is explained below):

- `helper_identity.verified` must be `true`, the identifier must be non-empty, and `ad_hoc` must be
  `false` (an ad-hoc grant dies on the next rebuild, so it is a misconfiguration in a path that
  expects a stable identity);
- the identifier must be in `DEFAULT_EXPECTED_HELPER_IDENTIFIERS` (the ids this repository builds,
  overridable through `ZCODE_CUA_EXPECTED_HELPER_IDS`; an override that names nothing falls back to
  the default, and an empty expectation list is refused rather than treated as "any identity");
- if the same response reports `grant_owner`, it must equal the verified identifier. A response
  whose claim disagrees with its signature is refused, which is what makes every downstream reader
  of `grant_owner` — including `services/node.ts`, which never looks at the identity block — read a
  verified value.

**What the identifier list is and is not.** It is a _collision filter_: a signing identifier is
chosen by whoever signs the binary (`codesign -i …`), so a determined attacker running as the same
user can mint a self-signed binary carrying `dev.zcode.cua-helper.dev` and pass this check honestly.
What the list buys is that the product Helper and the dev Helper cannot be silently swapped, that an
unrelated binary answering on our socket is refused, and that a Helper whose own seal is broken never
reaches it. The checks that carry real weight are the Helper's own signature validation above and
the `grant_owner` cross-check. Anchoring the identifier further — a pinned certificate root or team
identifier — is _possible_ with the fields the Helper already reports, but only against a
launcher-supplied expectation, because a value the Helper reports about itself is not an anchor; that
belongs with the launcher (below).

The check is macOS-scoped: it is a code-signature check, and the Windows development host
(`windowsCuaHelperHostSupport.ts`) is a forked Node entry with a per-launch pipe and token transport
and no signature to verify, so requiring the block there would break its health probe for no gain.

Failures are `helper_identity_missing` / `helper_identity_unverified` / `helper_identity_adhoc` /
`helper_identity_mismatch` / `helper_identity_policy_missing`. `probeHelperHealth` returns the
verified identifier as `bundleId`; the previous implementation echoed whatever string the Helper
typed into its own report.

**The Helper also resolves its caller.** The peer pid comes from `LOCAL_PEERPID` (kernel-supplied
for a connected socket, not a value the caller can choose), is resolved to a `SecCode`, and is
validated by the same path as above. `permission_status` reports it as `caller_identity` with
`caller_required`. Enforcement exists (`--require-peer-identifier` / `ZCODE_CUA_REQUIRED_PEER_ID`,
`--require-signed-peer`) but is **not configured in CUA-1**, for a measured reason: the caller in
this fork is a Node process, and its identity is an ad-hoc cdhash that changes with every Node
build —

```
caller_identity: identifier "node-55554944106c22c028653b9bbc6a6220adea3466", ad_hoc true,
                 requirement cdhash H"dad49c1f00e437873726e0e01462cc86c745b4fa"
```

Naming that as the expected caller would break on the next Node upgrade, and the only component
that can supply a stable one — the desktop host's `buildHelperOpenArgs`, still a fail-closed stub
in this fork — does not exist here. So the verification is implemented and reported, and the
expectation is deferred with the launcher.

Measured verdicts (`run-identity-probe.sh`):

| Case                                                     | Result                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| control, untouched signed bundle                         | `verified=true`, identifier `dev.zcode.cua-helper.dev`, accepted by the client |
| a different expected identifier                          | refused, `-67050`, names the mismatch                                          |
| one byte changed in `__text`                             | refused, `-67061`; `codesign --verify` also fails                              |
| bytes appended past the signed limit                     | refused, `-67010`                                                              |
| the tampered bundle still serving on the socket          | client refuses every request: `helper_identity_unverified`                     |
| a configured caller identity the caller does not satisfy | client refuses: `peer_not_authorized`                                          |
| rebuilt from source                                      | accepted again                                                                 |

Remaining gaps, named rather than implied (each is closed or bounded by CUA-1.5 below — see
that section for the measured details and what remains):

- **Same-uid socket substitution is not excluded.** The check above is the client asking the thing
  on the other end who it is, and the thing on the other end is the one answering. A local process
  running as the same user can bind the socket path first, present a self-signed binary carrying an
  expected identifier, answer `verified: true` and a consistent `grant_owner`, and be used — the
  client cannot tell it from the real Helper, because the credential that would settle it (the
  peer's process identity) is not readable from Node (`LOCAL_PEERPID` has no Node binding). What
  narrows this today: the runtime data root is the user's own, the launcher opens the bundle at the
  install path rather than an arbitrary binary, the helper unlinks the socket before binding so only
  one of the two can be listening, and the helper re-modes its observation directory and frames to
  `0700`/`0600` on every write. Closing it
  properly needs peer credentials on the client side — a native binding, or a Helper that connects
  out to a socket the host owns — and is _not_ in CUA-1.
- The `grant_owner` cross-check is an internal-consistency rule, not authenticity: it stops a
  response whose claim contradicts its own signature, which is what makes the field safe to read
  downstream, but it cannot make the responder trustworthy by itself.
- The Helper validates its **executable** image, not the whole bundle's sealed resources. An added
  file inside the `.app` is not detected. The measured tamper cases above (code edit, append) are.
- Peer enforcement is off by default (see above), so today the caller identity is evidence, not a
  gate.
- The identity check happens once per Helper process. The running image cannot change, so this is
  correct for the process; it is why the on-disk check in step 2 exists, since the _file_ can.

## Result envelope (the contract rule)

Every observe-only result carries the fields the spike's §7 made mandatory, and a call that
reached an actuator without a trusted readback is `unverifiable`, never `confirmed`:

- `route`: which mechanism produced the observation, from the vocabulary `"workspace"` (app
  enumeration), `"windowserver"` (window enumeration), `"ax"`, `"screencapturekit"`, `"none"`. When
  more than one rung contributed, the names are joined with `+` — `observe` with both rungs
  succeeds as `"screencapturekit+ax"` — so the value is a set, not a single token. The two
  enumerations do not go through Accessibility, so calling them `"ax"` would overstate what was
  exercised. Also: the helper emits raw AX `role` strings and the TypeScript side owns the
  `ROLE_TO_KIND` mapping, so the vocabulary lives in exactly one place and cannot drift.
- `delivery.mode`: `"background"` for everything CUA-1 does — observation never fronts a window.
- `effect`: `"confirmed" | "partial" | "unverifiable" | "refused"`.
- `evidence[]`: what was actually read back (`value_readback`, `window_change`, `pixel_stats`).

For observation the honest mapping is narrow and must not be inflated:

- every rung the caller asked for succeeded — a capture that returned a non-blank frame, and/or an
  AX walk the AX server served → `confirmed`, with `evidence[]` naming the readback;
- one of the two requested rungs succeeded and the other did not (for example AX granted but Screen
  Recording missing, so `observe` returns the tree without pixels) → `partial`;
- no requested rung succeeded → `refused`, with each missing rung named in `error`.

A **blank capture counts as a failed rung, not as a frame**: CUA-0.5 measured that a missing Screen
Recording grant yields a uniform frame rather than an error, so a single distinct colour is the
signature of an ineffective capture. The frame is still returned with its statistics — a window can
legitimately be uniform — but the effect is `partial` or `refused` and `error` says why.

Because observation has no actuator, `unverifiable` should not appear in CUA-1; it exists in the
enum for the input rungs CUA-2/3 will add. If it ever appears, that is a bug in the mapping.

## Graceful degradation when a grant is missing

The Helper is the TCC owner and may legitimately run with neither grant (the identity foundation
proves a LaunchServices-launched Helper holds no grant until authorized). Degradation is per
rung, never fatal, and always explicit:

| Missing grant         | `permission_status`                    | `list_apps` / `list_windows` | `observe`                                                                                                                                      |
| --------------------- | -------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| neither               | reports `denied` for both              | works (no TCC needed)        | `refused`, `error` names both rungs                                                                                                            |
| Accessibility only    | `accessibility: denied`, SR as granted | works                        | `partial`: capture yes, `tree: null` with a reason                                                                                             |
| Screen Recording only | SR `denied`                            | works                        | `partial`: AX tree yes, plus the blank frame with its statistics (not `null`) and a reason; a blank frame no longer counts as a succeeded rung |
| both                  | both `granted`                         | works                        | `confirmed`                                                                                                                                    |

`list_windows` is deliberately **not** filtered to on-screen windows. Measured on macOS 27,
`kCGWindowIsOnscreen` is `false` for almost every application window (136 of 137 on this machine,
including plainly visible ones), so an `optionOnScreenOnly` list returned **1** usable window
where the user actually had 7. The flag is reported per window and the list is sorted on-screen
first instead; degenerate entries (under 40 points in either dimension, which is the window
server's own bookkeeping and 64x64 service stubs) are dropped. Known remaining noise: system
services such as `CursorUIViewService` publish small titled-or-untitled stubs that pass that
minimum; `titled_count` is reported so a caller can prefer titled windows, and any stronger
filter should be added with evidence rather than by blocking a service by name.

Rules that make this trustworthy:

- `list_apps`/`list_windows` never require a grant and must never be gated on one.
- `observe` returns whatever rung succeeded, and names every rung that did not. It does not
  throw for a missing permission and does not return `confirmed` for a partial result.
- `permission_status` is the only method allowed to describe grants, and it reports the Helper's
  own identity — never the caller's and never inferred from System Settings appearance.
- Screen Recording is judged by a real capture attempt, not by `CGPreflightScreenCaptureAccess`,
  because that preflight is process-cached (measured; see restart requirements above).

## Screenshots cross the socket as references, not base64

`observe` does not inline image bytes. It writes the PNG into the helper's own runtime directory
and returns a path plus pixel statistics (`width`, `height`, `scale`, `distinctSampledColors`,
`blank`). Three reasons, all from measured behaviour: the node_repl bridge caps responses at
32 MiB; a blank frame is indistinguishable from a missing grant without pixel statistics; and
`packages/zcode-cua/frame-contract.*` already treats image content as a distinct, protected kind
that must be carried deliberately rather than smuggled inside a JSON field.

The result also carries `observation_id` (a UUID the Helper mints, not derived from the path). That
id is what survives the model-facing boundary below, so the frame stays addressable without either
side handing a model a filesystem path.

### Where the frame is written, and why it is a flag

`--observation-dir` sets the store; `ZCODE_CUA_OBSERVATION_DIR` and `ZCODE_HOME` remain fallbacks.
The flag exists because the environment does not cross LaunchServices: a measured `--serve` Helper
started with `/usr/bin/open` did **not** receive the launcher's `ZCODE_HOME`, fell back to
`~/.zcode`, and wrote a frame into the product's namespace. A flag travels with the launch. The same
reasoning applies to `--socket`, which is why the contract passes it explicitly rather than relying
on the two sides resolving the same default.

## Observation invariants (measured)

Observation must never front, raise, focus or move anything, and "delivery: background" is a claim
that has to be measured rather than asserted. `run-observe-invariants.mjs` drives the production
client (`callBrokerMethod`, the same call `createComputerUseRuntime.execute` makes) against a
Helper launched through LaunchServices, captures one genuine **non-frontmost** window, and records
before/after with an instrument that needs no TCC permission
(`native/cua-helper/evidence/InvariantProbe.swift`: frontmost application, `CGEvent` cursor
position, the full layer-0 window list, and — derived from it — the frontmost application's front
window, the target window's rank inside its own application, and whether the target is still behind
the front window). The _global_ enumeration index is recorded but not asserted: it also counts every
other window on the desktop, so it moves by one whenever an unrelated window appears, which is what
the first archived run showed (both the front window and the target shifted by exactly one).

Latest archived run — `/Users/felipemore/.zcode-fork-cua-home/evidence/observe-invariants-2026-09-23T13-58-44-009Z`,
`run.log` plus `observation.json` and `report.json`:

| Recorded                                             | Before                                              | After       |
| ---------------------------------------------------- | --------------------------------------------------- | ----------- |
| frontmost application                                | `com.acevra.desktop.development` (pid 25430)        | unchanged   |
| hardware cursor                                      | `508.27, 177.62`                                    | unchanged   |
| front window of the frontmost app                    | window 5903                                         | window 5903 |
| target window (`AceVra Dev`, pid 76803, window 5887) | present, rank 4 in its app, behind the front window | unchanged   |

The capture itself: `effect: "confirmed"`, `route: "screencapturekit+ax"`, 2400×1600,
`distinct_sampled_colors: 65`, `blank: false`, and the AX tree served (8 elements). The frame landed
in the fork's data root, and a check asserts the product's `~/.zcode/computer-use/observations` did
not grow. The same run re-proves the observe-only boundary on the live socket (below).

## Bounds on what a model receives

Two independent boundaries, because the helper's socket is host-internal and the model is not.

**In the Helper** (`ObservationLimits`, `Observe.swift`): caller-supplied `max_elements` /
`max_depth` are _clamped down_ to hard ceilings (2000 / 40) rather than taken at face value, so a
hostile or malformed parameter cannot ask for an unbounded walk; per-string AX text is capped at 512
characters (a text field's value can be a document); action lists are capped at 32; `list_windows`
at 500. Every AX string is read through `axBoundedString`, and truncation is counted in
`strings_truncated` rather than hidden. The attributes the walk may read are an explicit closed list
(`axReadableAttributes`): role, title, description, value, identifier, enabled, position, size,
children, windows. `AXDocument`, `AXFilename` and `AXURL` are deliberately **not** read — they are
how arbitrary host filesystem paths would enter an observation. `axAttribute` refuses any name
outside that list, so every _string-valued_ read is guarded; the two structural reads that need a
`CFArray` (`kAXWindowsAttribute`, `kAXChildrenAttribute`) call `AXUIElementCopyAttributeValue`
directly with allowlisted constants, since the generic reader cannot return an element array.

**On the way out** (`packages/zcode-cua/observe-result.js`, applied by
`createComputerUseRuntime.execute`): the same ceilings are re-applied, plus a 512 KiB total
serialized budget, because the Helper is not the only thing that can put bytes in front of a model.
It also removes host paths structurally:

- keys holding a location (`path`, `hostPath`, `absolutePath`, `filePath`, `directory`, …) are
  dropped, and the frame becomes `image.reference = "helper-observation:<id>"`;
- absolute paths matching the runtime's own roots or the conventional user/system roots are replaced
  with `<redacted-host-path>` even inside free text (an error message is the likeliest leak);
- the byte budget is a ladder, not a tree special case: `windows`, `apps` and `evidence` are halved
  first, then the tree's elements (keeping the head, which describes the window's chrome and its
  frontmost controls), and if the payload is still over budget — because the size is in a shape with
  no array to trim — only the envelope, the pixel facts and the frame reference are kept, with
  `truncated_for_size` and a named `error`. Halving is what makes it terminate: each pass strictly
  reduces how many entries are kept, so it reaches zero for any payload.

Facts are preserved: dimensions, pixel statistics, `blank`, `route`, `effect`, `evidence` and every
AX field a caller reasons about survive intact. Focused tests live in
`packages/zcode-cua/test/observe-result.test.mjs`.

## Artifact boundary

**Present contract (CUA-1): internal observation screenshots are not artifacts, and cannot become
one.** The shared system registers what a producer hands it — `bytes` or `hostPath` plus an
`origin` — and CUA-1 hands it nothing:

- the runtime returns `content: [{ type: "text", text: <sanitized JSON> }]` and no image block, no
  `artifactDelivery`, and no base64 (`observe-result.test.mjs` asserts this shape, and
  `hasDeliverablePayload` exists so a future bridge has to argue with a test before registering);
- `packages/zcode-cua` imports nothing from `task-artifacts`; the only two producers in the tree are
  `browserUseArtifactHook.ts` (origin `browser-use`) and `codexDeliveryIntegration.ts` (origin
  `codex`), neither of which is reachable from a CUA call;
- the observation store (`<ZCODE_HOME>/computer-use/observations`) is a different directory from the
  artifact store (`<appConfigDir>/task-artifacts`), so nothing can pick a frame up incidentally;
- host paths are stripped before the result leaves the runtime, so no CUA result presented to a
  model or client contains one. `run-observe-invariants.mjs` asserts this against live data, and the
  client-side sanitizer is the only code that touches the payload.

**Deferred, and to whom.** _Explicit user-requested_ screenshots becoming normal task artifacts
(reusing `TaskArtifactRegistry` with a `cua` origin — never a second CUA file store) is deliberately
**not** implemented here: it crosses into the artifact module's ownership, needs a
`captureIntent`-equivalent signal that only the protocol layer can place out of a model's reach
(the browser path's `captureIntent: "observation"` lives in protocol params for exactly that
reason), and needs a task/session scope the node_repl CUA bridge has but the observe-only runtime
does not yet consume. The invariant that matters today holds without it: an internal observation has
no registration path at all, so it cannot accidentally deliver. The integration contract is the one
just above — the frame is addressable by `observation_id`, and `sanitizeObservationResult` is the
single place a future bridge would hook.

## Permission semantics: readout versus functional truth

The identity foundation measured that `CGPreflightScreenCaptureAccess()` is process-cached: it stays
`false` in a process that asked before the grant _while a capture already works_, and stays `true` in
one that asked before a revocation. A single boolean therefore cannot express Screen Recording, and
CUA-1 stops pretending it can:

| Field                        | Meaning                                                                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `screen_recording`           | TCC's recorded state, derived from the preflight readout                                                                                                       |
| `screen_recording_readout`   | `{ preflight, source, cached: true, note }` — the raw cached value, named as a readout. `cached` is always `true`; nothing else may be inferred from the field |
| `screen_capture_probe_ok`    | the **functional** capture probe: `true`/`false` when one ran, `null` when it did not                                                                          |
| `screen_capture_probe_state` | `"ok" \| "failed" \| "not_run"` — the discriminator the boolean cannot carry                                                                                   |

`permission_status` never runs a capture, so it reports `null` / `"not_run"` rather than a `false`
that reads as a denial. On the TypeScript side, `resolveCuaScreenCaptureProbeState`
(`services/node.ts`) reports `"not_run"` for the standalone-Helper path and for any read-only
refresh, and `"failed"` only when a probe actually ran and did not succeed. The settings view keeps
using the TCC pair (`accessibility` + `screenRecording`) as its readiness criterion and never
`screenCaptureProbeOk` alone; that split and its reasoning are already recorded in
`packages/ui/src/lib/cuaPermissionStatusStore.ts`. CUA-1 changes no UI file.

## Lifetime, and what CUA-1 explicitly does not do

- The helper serves one socket until told to stop; `--idle-ms` bounds an unattended run. A
  permission change is observed by the running process (measured), so no restart is required to
  serve a newly granted permission.
- Captured frames do not accumulate: `ObservationStore.retainedFrames` (64) newest PNGs are kept and
  older ones are pruned on write, so a long observation session cannot grow the data root without
  bound. Frames are written `0600` inside a `0700` directory.
- The request line is capped at 1 MiB. A client that never sends a newline is answered with
  `bad_request` and dropped rather than being allowed to grow the helper's buffer.
- No input of any kind: no `click`, `type`, `key`, `hotkey`, `scroll`, `drag`, `perform_action`,
  `set_value`, `launch_app`, `activate_window`, `clipboard_*`, `kill_app`. `createComputerUseRuntime`
  keeps returning the unavailable error for every one of those names, and the runtime exposes no
  route that could reach them.
- No window mutation, no menu invocation, no process termination.
- No new protocol surface in `packages/shared/src/zcode-protocol-v4/`: the model-facing tool
  names already exist and are unchanged.

## Acceptance for CUA-1

1. `permission_status`, `list_apps`, `list_windows` and `observe` answer over the broker socket
   through `callBrokerMethod`, with the request/response shape above.
2. `isReadOnlyBrokerMethod` is true for exactly those four and `isBrokerMethod` is false for a
   mutating name, so a mutating call is refused with `not_authorized`.
3. `observe` on a granted Helper returns `effect: "confirmed"` with a non-blank capture and an
   AX tree, and frontmost/cursor are untouched (observation never fronts anything).
4. With Screen Recording absent it returns `effect: "partial"` carrying the AX tree and a blank
   frame with its statistics (a uniform frame is what a refused capture looks like, so it does not
   count as a succeeded rung); with Accessibility absent it returns `partial` carrying the image and
   `tree: null`; with neither it returns `refused`. None of these throw and none report `confirmed`.
5. `createComputerUseRuntime.execute` dispatches observe-only tool names to the broker and every
   other tool name still returns the unavailable error.
6. The helper implements no input synthesis — verifiable by inspection of the sources.
7. On macOS every result carries a verified `helper_identity`; the client refuses a missing, unverified,
   ad-hoc, or unexpected identifier, and refuses a `grant_owner` that disagrees with it.
   `grant_owner`, and `probeHelperHealth().bundleId`, are the verified signing identifier.
8. A tampered Helper (edited `__text`, appended bytes) fails its own check and is refused
   end-to-end, even though the tampered bundle still binds the socket and still holds its TCC
   grants. Measured by `native/cua-helper/run-identity-probe.sh`.
9. One real non-frontmost window capture leaves the desktop unchanged: the frontmost application is
   still the same, it is still showing the same front window, the hardware cursor has not moved, and
   the target window is still present, still ranked the same inside its own application, and still
   behind the frontmost application's front window. Measured by
   `native/cua-helper/run-observe-invariants.mjs`, evidence archived under
   `<ZCODE_CUA_HOME>/evidence/`.
10. A CUA observation result presented to a model contains no host filesystem path, and carries no
    deliverable payload (no image content block, no base64, no `artifactDelivery`).
11. Mutating methods stay refused on direct socket writes, malformed lines produce `bad_request`
    without killing the connection, and the runtime refuses every unregistered tool name without
    touching the socket.
12. AX reads are bounded in the Helper (clamped ceilings, 512-character strings, closed attribute
    list without `AXDocument`/`AXFilename`/`AXURL`) and bounded again on the way out (512 KiB).

---

# CUA-1.5 — trusted helper transport and peer identity hardening

This section is the implementation authority for CUA-1.5. It closes the security gaps CUA-1 named
in "Remaining gaps" and that are acceptable only for read-only observation, before any actuator
capability (CUA-2) can exist. It changes **transport and identity only**: no method is added, no
input synthesis appears, no model-facing surface changes, and the CUA-1 observe-only behaviour is
preserved end to end (see "What CUA-1.5 preserves").

## Why the transport direction flips (verified, not adopted)

CUA-1's gap was structural: the Helper **listened**, so the client had to authenticate the
listener — and the clients are Node processes, which have no binding for Unix-socket peer
credentials (`LOCAL_PEERPID` has no Node API). The client-side identity check could therefore
only ever evaluate the **responder's self-reported envelope**, and whoever won the bind race
owned that envelope. That is the "same-uid socket substitution" gap, and it cannot be closed
client-side in Node at all.

CUA-1.5 flips the direction: **the trusted host owns the listening socket and the Helper
connects out.** The decision rests on one measured fact about this codebase: the only component
with native Security-framework access is the Swift Helper itself. Making the _serving_ party the
connection **initiator** puts the kernel-supplied peer credential (`LOCAL_PEERPID`) on the side
that can act on it: the Helper resolves the listener to a `SecCode` and validates it against a
full designated requirement **before serving anything**. A same-uid process that pre-binds the
path, or wins an unlink+rebind race after the host binds, receives the Helper's connection but
cannot satisfy the requirement (it does not hold the signing identity), so the Helper refuses to
serve and exits. The impersonation _capability_ is destroyed rather than merely detected.

The client-facing hop becomes a host-owned relay of that one authenticated connection (below);
its residual exposure is bounded and named in "Remaining limitations".

## Transport topology

```
        trusted host process (desktop main / CLI runtime, via packages/services)
        ┌──────────────────────────────────────────────────────────────────────┐
        │  <ZCODE_HOME>/computer-use/sessions/s-<random>/   dir 0700           │
        │    ├─ b.sock        listening socket 0600 (chmod after listen)       │
        │    └─ session.json  0600 {pid, socket_path, started_at}              │
        │  1. mkdir session (fresh, random) → prune dead sessions → bind       │
        │  2. mint per-launch capability token (32 B random, never persisted)  │
        │  3. /usr/bin/open -a <Helper.app> --args --connect <sock> …          │
        │  4. admit ONE Helper connection: hello + host-side validation        │
        │  5. relay token-gated client requests onto that connection (serial)  │
        └───────────────┬─────────────────────────────────────▲──────────────┘
   connect (outbound)   │ hello {launch_token, identity, pid} │ newline-JSON
   verify host DR       ▼                                     │ requests
        Helper (Swift) ── serves the four CUA-1 methods ONLY on a connection
                           whose far end satisfied the host requirement
```

Names are kept deliberately short (`s-<random>`, `b.sock`): macOS's `sockaddr_un` holds only
104 bytes of path including the NUL, and a deep data root plus a long session name would fail
`listen()` with EINVAL (measured).

- The Helper **never binds a filesystem socket in connect mode**. `--serve` (bind mode) remains
  exactly as CUA-1 built it for standalone/diagnostic use and for the archived harnesses; it is
  not the transport the host launches.
- No inbound network port anywhere in the chain. The only endpoints are the host's Unix-domain
  socket and the Helper's outbound connection to it.
- The host process dies → the Helper's connection drops → the Helper exits (after at most its
  idle window). A helper restart is a fresh `open` + fresh handshake; the relay admits a new
  helper connection after the previous one closed (reconnect, not possession).

## Launch contract (connect mode)

The host launches the Helper through LaunchServices with `--args` (the environment does not
cross LaunchServices — measured in CUA-0.5 — so everything travels in the launch arguments):

| Argument                          | Meaning                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| `--connect <socket-path>`         | connect out to the host-owned session socket instead of binding    |
| `--launch-token <hex>`            | per-launch capability token, echoed in `hello`                     |
| `--require-host-requirement <DR>` | full code requirement the listener must satisfy **before serving** |
| `--expected-requirement <DR>`     | full code requirement this Helper's own signature must satisfy     |
| `--observation-dir <dir>`         | unchanged from CUA-1                                               |
| `--idle-ms <n>`                   | unchanged from CUA-1                                               |

Environment fallbacks: `ZCODE_CUA_REQUIRED_HOST_REQUIREMENT`,
`ZCODE_CUA_EXPECTED_HELPER_REQUIREMENT` (flags win, as in CUA-1).

## Mutual peer verification

**The Helper verifies the host (new, enforced).** Before any protocol traffic beyond `hello`,
the Helper resolves the connected peer's pid via `LOCAL_PEERPID` (kernel-supplied for a
connected socket — not a value the listener can choose), resolves it to a `SecCode`, and runs
the same three-step validation as its own identity, against the **full designated requirement**
passed at launch (`SecRequirementCreateWithString` → `SecCodeCheckValidity` strict → fresh
on-disk `SecStaticCodeCheckValidity` strict + all-architectures). Failure exits non-zero; the
Helper never serves a listener it did not verify. This is the gate CUA-1 left unconfigured: the
requirement now arrives from the launcher, which computes it from its own installed code.

**Requirement shapes.** The requirement is a string in Apple's requirement language, so the
contract supports every identity branch without new machinery:

- signed host (production): `identifier "…" and anchor apple generic and certificate
leaf[subject.OU] = "<team id>"` — team-anchored;
- self-signed dev host and dev Helper: `identifier "…" and certificate root = H"<sha1>"` — the
  certificate anchors it; a self-signed impostor carrying the same identifier fails because it
  does not hold the certificate. The dev Helper's own installed DR is exactly this shape
  (measured: `identifier "dev.zcode.cua-helper.dev" and certificate root = H"f89ef775…"`);
- ad-hoc dev builds: `cdhash H"…"` — exact for this install; every rebuild changes it, which is
  why ad-hoc stays a recorded-local-dev mode, never the default.

The active AceVra identities (`com.acevra.desktop.development`, `dev.acevra.cua-helper`,
`dev.acevra.cua-helper.development`) are the only identities accepted by the integrated
development build. The historical `dev.zcode.*` values remain in archived CUA-0.5 evidence
only; they are not accepted by the active launcher or broker policy. The certificate-anchored
DR is what makes "don't trust bundle id alone" real — an identifier is chosen by whoever signs;
a certificate root is not.

**The Helper's self-check becomes requirement-anchored.** `--expected-requirement` replaces the
identifier-only expectation with a full requirement enforced in both `SecCodeCheckValidity`
(running) and the fresh on-disk `SecStaticCodeCheckValidity` (all architectures, strict). A
Helper that does not satisfy the launcher-pinned requirement refuses every request exactly as
CUA-1's `helper_identity_unverified` path did — but now the anchor is the certificate, so a
self-signed same-uid impostor cannot pass its own self-check _as the expected identity_.

**The host validates the Helper at admission (new, enforced — and honestly bounded).** On a
`hello {launch_token, helper_identity, pid}` the host requires all of:

1. the hello shape and `launch_token` equal to the token it minted for this launch
   (constant-time compare) — checked **before** the expensive host-derived scan below, so an
   unauthenticated peer cannot buy subprocess work with a hello-shaped line;
2. `pid` is in a **host-derived** validated set: the host enumerates live processes whose
   executable path sits under the helper install roots (`<ZCODE_HOME>/computer-use/…`) and
   validates each candidate bundle with `/usr/bin/codesign --verify --strict
--all-architectures -R=<helper DR>` — the verdict comes from the process table and the
   bundle on disk, not from the connection's claims;
3. the pid is still alive at admission time (`kill(pid, 0)` recheck); and
4. no other helper connection is current — a second hello is refused while one is admitted, and
   re-admission happens only after the previous connection closed (restart).

What this admission is, precisely: **token-strength plus a consistency check**. Steps 2–3 prove
that _some_ live process satisfies the helper requirement; they do **not** bind _this
connection_ to that process, because Node has no peer-credential binding — the connection could
be any same-uid claimant that knows the token (`ps`-readable, a named limitation) and quotes a
validated pid. The host-side admission therefore cannot, by itself, stop an impostor
_connection_; what it does stop is every claimant without the token, and every claimant whose
quoted pid has no genuinely validated helper behind it. Binding the connection itself needs a
native peer-credential check on the admitted connection (a small Swift component, or Node
bindings for `LOCAL_PEERPID`/audit tokens) — deferred with the product host integration and
named in "Remaining limitations". A fake Helper carrying an expected bundle id but the wrong
signing requirement still fails on both sides: its own requirement-anchored self-check, and the
host's `codesign -R` scan (no validated pid exists for it to quote).

## Session authentication

A process that merely discovers the session socket cannot issue CUA requests. The host relay
requires every client request line to carry the per-launch capability token
(`ZCODE_CUA_PERMISSION_BROKER_TOKEN` in the agent's spawn env); the comparison is constant-time;
the token is **stripped before forwarding** to the Helper; a missing token is
`missing_session_capability`, a wrong one is `wrong_caller`. The token is minted at launch,
held only in host memory (and the agent's spawn env), never persisted, and dies with the
session. Host-side in-process callers (probe/status) go through the same pipeline without a
socket. `callBrokerMethod` keeps working token-less against CUA-1's standalone `--serve` socket
so the CUA-1 flow and the archived harnesses are unchanged.

This is deliberately **not** a long-lived static secret and not a same-uid boundary: launch
arguments are scannable by a same-uid process (`ps`), so the token raises the bar from
"discovered the socket" to "raced the launch on the same uid". The same-uid-proof anchors are
the code-signing requirements; the token is the outer door, the requirements are the walls.

## Socket and session security

- The session directory is created fresh per launch with a random name, mode `0700`; the socket
  is `0600` (umask `077` during bind, `fchmod` after); `session.json` is `0600`. No group or
  other access anywhere in the chain.
- Stale files cannot redirect anyone: the path is unpredictable per session, the host unlinks
  any leftover at its own fresh path before binding, and session directories whose recorded
  owner pid is dead are pruned at the next start. A client is _told_ the exact path for this
  launch only; it never guesses a stable path.
- Pre-bind/substitution: an attacker that binds the path before the host gets its socket
  replaced when the host binds (the host creates the directory itself, so "before" requires
  winning a race against an unpredictable name in a `0700` directory owned by the user); an
  attacker that substitutes _after_ the host binds receives the Helper's connection and fails
  the Helper's host-requirement check — the Helper refuses and exits. The serving capability
  cannot be stolen by socket possession.
- Least privilege: the Helper holds no socket it binds in this mode; only the host listens;
  only the verified Helper connection can produce observations; only token-bearing clients can
  reach the relay.
- Public error text carries no host filesystem paths: client-visible failures use stable codes
  (`helper_identity_*`, `peer_not_authorized`, `missing_session_capability`, `wrong_caller`,
  `bad_request`, `not_authorized`, `timeout`, `connect_failed`, `unavailable`) with messages
  built from those codes and OSStatus numbers only. Filesystem paths appear only in the
  Helper's local stderr diagnostics, which are not part of any protocol response.

## Bundle validity (measured — corrects CUA-1's claim)

CUA-1 wrote: "The Helper validates its **executable** image, not the whole bundle's sealed
resources. An added file inside the `.app` is not detected." **That claim is refuted by
measurement** (`native/cua-helper/run-bundle-validity-probe.sh`, evidence archived under
`<CUA_HOME>/evidence/bundle-validity-20260923-153234/`, `BundleValidityProbe.swift` driving the
Security framework directly). What is actually true on this macOS:

- `SecCodeCopyPath` on the running code of a bundle executable resolves to the **`.app`** (not
  the executable), so CUA-1's "fresh on-disk re-open" step was already validating the bundle's
  seal. `SecStaticCodeCheckValidity` validates executable **and** resources by default —
  `kSecCSDoNotValidateExecutable` / `kSecCSDoNotValidateResources` are the opt-outs.
- Tamper matrix, identical verdicts for bundle-level and executable-level validation (creating
  a static code for an executable inside a bundle validates the enclosing bundle's seal too):

| Case                                          | Status | Verdict                       |
| --------------------------------------------- | ------ | ----------------------------- |
| pristine bundle, requirement-anchored         | 0      | accepted                      |
| modified sealed resource (Info.plist)         | -67030 | rejected                      |
| added file in `Contents/Resources/`           | -67054 | rejected                      |
| added file in `Contents/` root                | -67054 | rejected                      |
| added file at bundle root                     | -67014 | rejected                      |
| appended executable bytes                     | -67010 | rejected                      |
| one byte XORed inside `__text`                | -67061 | rejected                      |
| valid re-seal under the approved dev identity | 0      | accepted (the "rebuild" case) |

- Confirmed against a copy of the real dev Helper bundle: a brand-new `Contents/Resources/`
  directory containing one file is rejected (-67054); the pristine bundle passes with the full
  certificate-anchored requirement.
- `kSecCSCheckNestedCode` passes on a bundle with no nested code (measured) and is included in
  the CUA-1.5 self-check so a product Helper that gains embedded frameworks is covered by the
  same code path.

What Apple's model actually supplies — and CUA-1.5 claims no more: validation covers everything
the seal enumerated at signing time plus any _added_ file under the bundle (measured at bundle
root, `Contents/`, and `Resources/`), and the requirement anchors _which_ signing identity is
acceptable. It cannot detect the on-disk bundle being swapped after the one-time per-process
check (the running image cannot change; the file can — unchanged from CUA-1), and it cannot
distinguish two bundles signed by the same approved identity. The CUA-1.5 self-check therefore
validates explicitly at the bundle level, requirement-anchored, all-architectures, strict, with
nested-code checking, and reports `bundle_validated` in the identity envelope.

## What CUA-1.5 preserves

- The four methods (`permission_status`, `list_apps`, `list_windows`, `observe`), the wire
  format, the result envelope, the observation limits, the sanitizer and the artifact boundary
  are byte-for-byte unchanged.
- `--serve` bind mode, the stable socket path and token-less `callBrokerMethod` keep working
  for standalone/diagnostic use; caller identity remains resolved and _reported_ there, with
  `--require-peer-identifier` enforcement available exactly as CUA-1 left it.
- Every mutating tool name stays unreachable: nothing in this phase touches the actuator
  boundary, the runtime map, or the protocol.
- The product-host stubs in `packages/zcode-cua/broker-server.js` stay fail-closed — including
  `buildHelperOpenArgs`, which remains the upstream product-integration surface. The hardened
  transport carries its own launcher (`buildHostConnectOpenArgs`) until that integration.

## Remaining limitations (named, not implied)

Items 3 and 4 are closed (and item 1's helper-impersonation half bounded) by CUA-1.75 below;
that section carries its own measured facts and its own named residual.

1. **Client→listener authentication from Node is still impossible.** A same-uid attacker who
   wins the bind race on the client-facing session socket _and_ knows the launch token (readable
   via `ps` from the Helper's launch arguments) can answer clients with fabricated responses. It
   cannot read the screen (no TCC grant), cannot actuate (nothing exists), and cannot feed the
   real Helper (that connection is DR-gated). Closing this fully needs a native peer-credential
   binding in Node or TLS on the socket — deferred with the product host integration.
2. **Launch arguments are the launch channel and are `ps`-visible** to same-uid processes. The
   token is discovery-resistance, not a same-uid boundary (see "Session authentication").
3. **Host-side admission trusts a host-derived process scan** (`ps` + `codesign -R`) with a
   liveness recheck — and, per "The host validates the Helper at admission", it does not bind
   the connection to the quoted pid. Two consequences, both named rather than softened:
   a same-uid claimant that knows the token can be admitted as the session's helper connection
   (fabricated responses to clients; bounded by the token being ps-readable — consequence 1);
   and a same-uid attacker can _launch the genuine Helper themselves_ with arguments of their
   choosing. The second is a real TCC capability, not a no-op: the genuine Helper holds the
   Screen Recording and Accessibility grants, and the helper's DR gate anchors to whatever
   requirement the launcher passed — an attacker launcher passes their own — so an
   attacker-launched genuine Helper pointed at an attacker listener yields real screen reads
   (`--serve --socket` had the same property in CUA-1; connect mode does not change it).
   Closing either needs a kernel-supplied binding to the launched process (native
   peer-credential check or installer-owned requirement provisioning), not more Node code.
4. **`LOCAL_PEERPID` → pid → `SecCode` has a theoretical pid-reuse window** between the
   `getsockopt` and the code resolution. An audit-token-based resolution would close it and
   needs native bindings. Unchanged from CUA-1, now load-bearing in the Helper→host direction
   as well, where the requirement check (not the pid) is the anchor.
5. **One host session per Helper instance.** LaunchServices `open` on a running Helper does not
   deliver new arguments, so a second simultaneous host process cannot onboard the running
   Helper; it falls back to the CUA-1 stable-socket flow or reports unavailable. Named, not
   fixed: fixing it needs a Helper-side session directory scan, out of CUA-1.5 scope.
6. The identity self-check remains once-per-process (running image cannot change; on-disk swap
   after start is not re-detected until restart) — unchanged from CUA-1.

## Acceptance for CUA-1.5

1. Host-created session endpoints are `0700`/`0600`; session files are `0600`; nothing listens
   on a network port.
2. A Helper launched with `--connect` serves the four CUA-1 methods only after the listener
   satisfied the configured host requirement, and exits without serving when it does not
   (fake-host substitution fails closed).
3. A helper-signed impostor (expected bundle id, wrong certificate) fails its own
   requirement-anchored self-check and the host's `codesign -R` admission.
4. Client requests without the launch token are refused (`missing_session_capability`); with a
   wrong token refused (`wrong_caller`); the token never reaches the Helper; comparisons are
   constant-time.
5. Stale socket files and dead sessions cannot redirect clients; a fresh launch creates a fresh
   session; restart of Helper or host re-establishes the full handshake (reconnect works).
6. Sealed-bundle validation is requirement-anchored, bundle-level, all-architectures, strict,
   nested-code-including, and the tamper matrix above is reproduced by
   `run-bundle-validity-probe.sh`.
7. All CUA-1 tests pass unchanged; new deterministic tests cover hello admission, token
   enforcement, single-session, re-admission after restart, malformed-message fail-closed
   behaviour, and socket-permission assertions; the live verification script drives the four
   methods through the final transport with observation invariants intact.

# CUA-1.75 — binding the admitted Helper connection to the native peer identity

This section is the implementation authority for CUA-1.75. It changes **admission identity
only**: no method is added, no input synthesis appears, the wire format is untouched, the
Helper binary is not modified, and the CUA-1 observe-only behaviour is preserved end to end
(see "What CUA-1.75 preserves"). Its single job is to eliminate the ambiguity CUA-1.5 named as
its admission limit: Node could verify that _a_ helper-looking process existed and that the
connection carried the launch token, but could not prove that **the connected Unix-socket peer
was that exact process** — and could not tell a genuine Helper the _host_ launched from the
same binary an _attacker_ launched with arguments of their choosing.

CUA-1.75 closes CUA-1.5 "Remaining limitations" items 3 (both halves) and 4, and bounds item
1's helper-impersonation half. The required property, end to end:

```
connected socket → kernel-derived peer identity → native code-signing verification
                 → exact admitted Helper identity
```

## Admission event order (owners and sequence)

```
 trusted host (Node, packages/zcode-cua host-transport)        native sidecar (Swift)
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │ 1. accept() on the host-owned session socket (0600 in 0700 dir)                  │
 │ 2. first line: `hello`-shaped → Helper role (anything else: token-gated client)  │
 │ 3. preflight: hello shape + launch token (constant-time) — BEFORE any spawn,     │
 │    so an unauthenticated peer cannot buy native work                              │
 │ 4. spawn peer-identity probe; the ACCEPTED SOCKET FD is inherited as fd 3        │
 │    (public child_process stdio passthrough; no SCM_RIGHTS needed)                │
 │                                    │  a. getsockopt(LOCAL_PEERTOKEN) — audit     │
 │                                    │     token of the connected peer (kernel)    │
 │                                    │  b. LOCAL_PEERPID/LOCAL_PEERCRED cross-check│
 │                                    │  c. SecCodeCopyGuestWithAttributes          │
 │                                    │     (kSecGuestAttributeAudit) — the exact   │
 │                                    │     process INSTANCE (pid + pidversion)     │
 │                                    │  d. describeCode (shared source with the    │
 │                                    │     Helper's CodeIdentity.swift): dynamic   │
 │                                    │     validity + fresh on-disk strict/all-arch│
 │                                    │     + bundle nested-code + signing info,    │
 │                                    │     against the launcher-pinned requirement │
 │                                    │  e. KERN_PROCARGS2 of the bound pid — the   │
 │                                    │     peer's exec argv                        │
 │ 5. policy (pure JS): token ✓ + identity rules + hello-pid consistency +          │
 │    launch-contract equality → admit ONE helper connection                        │
 │ 6. relay token-gated client requests onto it (unchanged); drop → re-admit on a   │
 │    fresh hello (restart/reconnect, unchanged)                                    │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

One owner each, unchanged from CUA-1.5: the host module owns the session and the admission
decision; the probe owns only kernel/Security queries and answers one JSON report; services
owns launch and requirement discovery. A CUA-1.75 session never falls back to a weaker mode:
if the probe, kernel binding, pinned requirement, or admission is unavailable, the integrated
runtime reports Computer Use unavailable and waits for a fresh hardened launch. The historical
CUA-1 standalone flow remains available only to archived diagnostic harnesses; it is not a
product fallback.

## Measured platform facts (macOS 27.0, 2026-09-23 — this fork's verification host)

Every mechanism below is measured on this macOS version, not assumed from headers:

| Fact                                                                                    | Result                                                                                                                                      |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `getsockopt(SOL_LOCAL, LOCAL_PEERTOKEN)` on an accepted AF_UNIX stream socket           | works; 32-byte `audit_token_t`, word order `[auid, euid, egid, ruid, rgid, pid, asid, pidversion]`                                          |
| `LOCAL_PEERPID` / `LOCAL_PEERCRED` cross-checks                                         | agree with the token's `pid` / `euid` (so the token layout reading is self-verifying)                                                       |
| `SecCodeCopyGuestWithAttributes(kSecGuestAttributeAudit)`                               | resolves the live peer; validity + signing information obtained                                                                             |
| same call with the token's **pidversion** bumped                                        | fails `-67065` — resolution is bound to the process **instance**, so a reused pid number cannot resolve                                     |
| same calls after the peer **exits** (socket half-closed)                                | `LOCAL_PEERTOKEN`/`LOCAL_PEERPID` return **ENOTCONN** — a dead peer cannot be bound or authorized                                           |
| `sysctl(KERN_PROCARGS2)` of the bound pid                                               | returns the peer's exec argv **with argument boundaries intact** (spaced values survive)                                                    |
| same read after the owner rewrites its argv memory (`process.title`)                    | the **rewritten** view is returned — argv is NOT an immutable kernel record (see the binding's limits)                                      |
| Node `child_process` stdio fd passthrough of the accepted socket fd into a spawned tool | works; the tool queries the socket at its stdio slot (fd 3)                                                                                 |
| `sendmsg(SCM_CREDS)` / spontaneous per-message credentials, STREAM and DGRAM            | `EINVAL`, no cmsg delivered, `struct cmsgcred` absent from this SDK — **no per-writer identity exists** on this platform's Unix sockets     |
| LaunchServices `/usr/bin/open -a <app> --args …`                                        | the Helper's `argv[1..]` is exactly the `--args` tail — verbatim, boundaries preserved (also true for direct exec of the bundle executable) |
| the dev Helper's signing options (`build-dev-helper.mjs`)                               | `--options runtime` — hardened runtime, so dyld injection and `task_for_pid` into the Helper are platform-blocked                           |

## Why a small Swift sidecar, and not a native Node addon

Both were evaluated; the sidecar integrates more cleanly with this host, for measured reasons:

- The peer query must run **in a process holding the accepted fd**. That rules out any
  out-of-process design that would have to move the fd (no SCM_RIGHTS API exists in Node —
  moving it would itself need native code), and it rules in either an in-process addon or a
  child that inherits the fd. `child_process` stdio passthrough delivers the fd with **public
  API**; a Node addon would need a build toolchain (node-gyp/clang + headers) and an
  Electron-ABI story for the desktop host, none of which this repository otherwise carries.
- The code-signing verification must not drift from the Helper's own. The sidecar compiles the
  **same `CodeIdentity.swift` source** (its `describeCode` — dynamic + on-disk + bundle +
  signing-info) into the probe target, so the two verifications cannot disagree; a C port in an
  addon would be a second implementation to keep in lockstep.
- Cost is one spawn per helper admission (not per request), bounded by a hard timeout, and the
  failure posture is fail-closed: no probe binary, no binding, no admission.

## The native probe (`peer-identity`)

Input: fd **3** is the accepted socket (inherited); `--requirement <DR>` is the
launcher-pinned Helper designated requirement (the same string the Helper's self-check is
anchored to). Output: one JSON line on stdout, exit 0 only with a complete report:

- `binding` — the audit token fields (pid, pidversion, euid, …) plus the cross-check results;
- `identity` — the `describeCode` report (`verified`, `identifier`, `team_id`, `cd_hash`,
  `requirement`, `ad_hoc`, `bundle_validated`, `reason`, …) for the peer resolved **from the
  audit token**, checked against `--requirement`;
- `peer_args` — the bound pid's exec argv from `KERN_PROCARGS2`.

Any failure (no token, unresolved instance, failed validation, unreadable args, or the
probe's own kernel cross-checks disagreeing — both `LOCAL_PEERPID` and `LOCAL_PEERCRED` must
agree with the audit token, and the binder requires those agreements in the report) is
reported with `verified: false` or an error code and **never** produces a partial pass.

**The probe binary is itself gated before any of its verdicts are trusted.** The probe is
trusted code in the admission chain, and it lives in a same-uid-writable install root, so the
binder gate requires ALL of: the probe's on-disk designated requirement **equals** the
requirement pinned at session start (launcher-read — the same anchoring shape as the Helper's
`helperRequirement`, so a binary swapped after that read fails the equality); the requirement
carries the probe identifier (collision filter, same weight as the helper identifier list);
the signature is **not ad-hoc** (`Signature=adhoc` refused, exactly as the helper admission
refuses ad-hoc helpers); and the seal validates strictly, all-architectures, against the
pinned requirement. This gate re-runs **before every spawn** — a one-time, session-cached
check would leave the whole session open to a swap between admissions (adversarial-review
findings 1 and 2, both addressed).

## Admission rules (the policy half, pure and total)

`evaluateHelperHello` keeps its shape and its check order; the host-derived facts it consumes
change from "a validated-pid set" to "the peer binding report". Checks, in order:

1. hello shape (`helper_hello`) — `bad_hello`;
2. `launch_token` equal to the session token (constant-time) — `wrong_helper_token`
   (this stays the pre-spawn preflight as in CUA-1.5);
3. peer binding present and kernel-consistent (probe report exists, token was available,
   `LOCAL_PEERPID` agreed with the token pid) — `peer_identity_unavailable`;
4. identity rules against the **host-derived** report — `verified: true`, non-empty
   identifier, not ad-hoc, identifier in the expected list — codes `helper_identity_*`
   unchanged. The hello's `helper_identity` envelope is no longer a source of trust; if
   present it must merely agree with the host-derived report (a claim that contradicts the
   peer's own signature is refused exactly as CUA-1 refused self-contradiction);
5. **hello-pid consistency**: the hello's `pid` (still self-reported; the Helper binary is
   unchanged) must equal the audit-token pid. The kernel value is authoritative — a quoted
   pid is never consulted for authorization, so a stale, recycled or borrowed pid cannot
   authorize anything — `helper_process_unverified`;
6. **launch-contract equality**: the peer's exec argv flag-set must equal, name for name and
   value for value, the host-connect args the host minted (`buildHostConnectOpenArgs`'s
   `--args` tail: `--connect`, `--launch-token`, `--require-host-requirement`,
   `--expected-requirement`, `--observation-dir`, `--idle-ms`) — `helper_launch_contract_mismatch`;
7. one helper connection per session; re-admission only after close (unchanged).

Stable refusal codes (superset of CUA-1.5's): `bad_hello`, `wrong_helper_token`,
`peer_identity_unavailable`, `helper_identity_policy_missing`, `helper_identity_missing`,
`helper_identity_unverified`, `helper_identity_adhoc`, `helper_identity_mismatch`,
`helper_process_unverified`, `helper_launch_contract_mismatch`.

Check 6 is what rejects a **genuine Helper that an attacker launched** with arguments of
their choosing: the audit token and the code signature cannot distinguish it from the
host-launched one (same binary, same instance quality), but its `--require-host-requirement`
— or any other contract field — differs from the pinned contract the host minted for this
launch. This holds even when the attacker's requirement is one the host would also satisfy
(e.g. a weakened or parenthesized variant of the real DR): textual equality with the pinned
contract is required, not "would match".

## What the launch-contract check is, and is not

The argv is read from the peer pid via `KERN_PROCARGS2`, which is **not** an immutable kernel
record (measured: a process that rewrites its argv memory changes what outsiders read). Its
weight rests on two measured/structural facts, named so the trust is explicit:

- the decision only ever applies to a peer already bound by audit token **and** verified as
  running the approved Helper image (`describeCode`, requirement-anchored); the approved
  Helper code reads its arguments once at startup and never rewrites argv memory, so for any
  process that passes checks 3–4 the read argv is the argv that process consumed;
- rewriting the running Helper's memory needs a debugger or dyld injection, which the Helper's
  hardened runtime blocks (measured in the build flags); forging argv at exec time forges it
  _consistently_ (what the kernel read and what the Helper consumed are the same bytes at
  exec) and is then caught by check 6 as a contract mismatch.

Under the model — no debugger control of the verified process — check 6 makes the admitted
connection indistinguishable from the one the host itself launched, which is the "exact
admitted Helper identity" of the required property.

## What CUA-1.75 preserves

- The four methods, the wire format, the result envelope, the observation limits, the
  sanitizer and the artifact boundary are byte-for-byte unchanged; all CUA-1 observe
  behaviour and its invariants still pass through the final transport.
- Every mutating tool name stays unreachable; the actuator boundary is untouched.
- The Helper binary is unchanged (still LOCAL_PEERPID-verifies the listener against
  `--require-host-requirement` before serving; still hard-fails closed on a listener that
  does not match) — the helper→host direction keeps exactly its CUA-1.5 strength.
- Host-owned socket, fresh 0700 session directory, 0600 socket, random per-launch capability
  token, token stripping before forwarding, constant-time compares: all unchanged.
- `--serve` bind mode and token-less `callBrokerMethod` for standalone/diagnostic use:
  unchanged. The CUA-1 standalone flow is retained only for archived diagnostic harnesses;
  the integrated product runtime does not use it as a fallback when the hardened session cannot
  start (including when the probe binary is missing).
- The product-host stubs in `broker-server.js` stay fail-closed.

## Remaining limitations (named, not implied)

1. **Per-writer identity does not exist on this platform's Unix sockets** (measured:
   `SCM_CREDS` is unimplemented). The audit token identifies the process that _connected_;
   any process the verified Helper handed the connected fd to could write on the connection
   under that identity. This is bounded, not closed: the verified Helper code never forks or
   exports the connection, its hardened runtime blocks injection and `task_for_pid`, and an
   unverified process that merely _creates_ the connection binds as itself and fails checks
   3–4 (an "exec-wrapper" that connects before exec is likewise caught — the bound instance
   must pass `describeCode` _and_ the launch contract of the image it ends up running).
   Closing this completely needs per-message credentials (not available here) or a Mach/XPC
   transport whose messages carry per-message audit tokens — a different transport, out of
   CUA-1.75 scope.
2. **The launch token remains `ps`-visible** in launch arguments (unchanged from CUA-1.5) —
   discovery-resistance, not a same-uid boundary. CUA-1.75 is what makes token possession
   insufficient: with it, the token only opens the door to the binding checks. Because the full
   launch contract is also visible, a same-uid attacker can launch a genuine, correctly signed
   Helper with an exact copy of the valid arguments; that process still satisfies this phase's
   verified-peer identity chain, but host-created launch provenance is not proven. Closing that
   stronger property requires a non-argv launch credential or a different transport and is outside
   CUA-1.75.
3. **The probe binary is trusted code, bounded not proven.** Its gate (session-pinned
   requirement equality + identifier + non-ad-hoc + strict seal validation, re-run before
   every spawn) shrinks the substitution window to the gap between one verification and the
   next exec of the same path; a same-uid writer that wins exactly that gap — or substitutes
   the probe before session start, which is the same pre-start substitution bound the Helper
   requirement discovery already carries — can substitute the verifier. Named, consistent
   with the CUA-1.5 model; closing it fully needs installer-owned provisioning of the pinned
   requirement (product integration).
4. **`socket._handle.fd` is a Node-internal accessor** (there is no public API for the
   accepted fd). It is read synchronously immediately before the probe spawn — no await in
   between, so the fd number cannot be recycled onto a different connection by an interleaved
   accept (adversarial-review finding 3). A Node that removed the accessor would fail closed
   (the probe cannot be given a fd, admission is refused) — availability risk, not a security
   hole.
5. **Admission is checked once per connection.** The running image cannot change and the
   audit identity is fixed for the life of the connection, so nothing re-checks per request;
   a disk swap of the bundle after start is not re-detected until the next launch (unchanged
   from CUA-1).
6. The hello `pid` field remains self-reported (Helper binary unchanged) — but is now only a
   consistency witness against the kernel pid, never a source of authority.

## Acceptance for CUA-1.75

1. A genuine Helper connection (real launch contract, approved signing identity) is admitted
   and serves the four CUA-1 methods.
2. A helper-looking connection whose peer fails the pinned requirement (wrong signer,
   tampered or re-signed bundle) is refused (`helper_identity_unverified`).
3. A genuine Helper launched by an attacker with a different `--require-host-requirement` —
   including a requirement the host would still satisfy — is refused
   (`helper_launch_contract_mismatch`).
4. A fake same-uid client (any unverified process speaking the hello wire format, token and
   fabricated envelope included) is refused on its own kernel identity
   (`helper_identity_*` / `peer_identity_unavailable`); quoting another process's pid in the
   hello never helps (`helper_process_unverified`).
5. A stale or recycled pid authorizes nothing: hello pid claims are never consulted
   (consistency only), a dead peer cannot be bound at all (ENOTCONN), and audit-token
   resolution refuses a mismatched pidversion (`-67065`).
6. Reconnect after Helper restart re-runs the full binding on the fresh connection and is
   admitted again.
7. All CUA-1 observe methods and their result-envelope invariants still pass through the
   final transport.
8. All actuator names remain unavailable.
9. If the integrated hardened session cannot start, is torn down, or is not yet admitted, the
   permission/status path reports Computer Use unavailable and permits a later retry; it does not
   probe the stable CUA-1 socket, call the legacy broker, or inject a legacy socket into a spawned
   agent. The legacy standalone path remains isolated to archived diagnostic harnesses.

Deterministic tests cover the policy half (codes above, contract equality, pid consistency) and
the no-legacy-fallback boundary; `native/peer-identity/run-cua175-verification.mjs` drives the
live matrix on macOS with the real probe and real Helper.
