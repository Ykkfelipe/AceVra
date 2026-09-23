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

macOS attributes a grant to the *responsible process*. Under LaunchServices the Helper is
its own responsible process (`ppid = 1`), so it is granted or denied on its own identity.
`ZCODE_CUA_LAUNCHER_PID` is published by the desktop main process and forwarded as
`--launcher-pid`, but it exists for **peer verification of the caller**, not for permission
inheritance: it confers no TCC grant (measured — see the LaunchServices rows below).

### Permission owner model

| Question | Answer | Evidence |
|---|---|---|
| Who owns the grant? | The Helper bundle, per (bundle id + code requirement) | `L2-open` vs `L1-exec` |
| Does the app's grant flow to the Helper? | Only when the Helper is an `exec` child inside the app's process tree — **not** through the LaunchServices path the contract uses | `L1-exec`: `ax=true`, capture OK; `L2-open`: `ax=false`, capture refused with `ppid=1` |
| Does `--launcher-pid` grant anything? | No. A never-granted control bundle launched by LaunchServices is denied with the flag and without it | `final/R3-ctl3-with-launcherpid` and `final/R3-ctl3-without-launcherpid`: `ax=false`/`sr=false` in both |
| Is the grant per-bundle-id? | Yes. Two identically signed control bundles at the same path stayed untrusted while the authorized one was trusted | `L5-control`, `CTRL2b` (`ax=false`) |
| Does an `exec` + `AXIsProcessTrustedWithOptions(prompt:)` create a grant? | No — this was tested explicitly and refuted, so the trusted state cannot appear without a user decision | `CTRL2a` (exec, prompt → `ax=true` via inheritance) then `CTRL2b` (LaunchServices → `ax=false`) |

### Signing model

The grant is bound to a **code requirement**, not to a hash of the binary:

```
designated => identifier "<bundle-id>" and certificate root = H"<certificate sha1>"
```

An ad-hoc signature has no stable requirement (its cdhash is the requirement), so every
rebuild produces a new cdhash and the grant is lost. Therefore:

* **Development** uses a dedicated self-signed certificate (`ZCode CUA Dev Signing`) created
  by `signing/create-dev-signing-identity.sh` in a dedicated keychain under the isolated CUA
  namespace. The certificate is deliberately **not** trusted system-wide (no user trust
  settings are written) — `codesign` signs with it regardless, and TCC honours the resulting
  requirement. `spctl` will reject the bundle, which affects distribution, not TCC.
* **Production** must use a Developer ID, giving a Team-anchored requirement
  (`anchor apple generic and certificate leaf[subject.OU] = "<team>"`) — the same mechanism
  as the shipped product Helper. That specific requirement shape is **not measured here**
  (no Developer ID exists on this machine); the persistence property it depends on is the
  same one measured below, because TCC keys on the requirement either way.

### Install path

Resolved by the existing contract, unchanged by this work:

| Variant | Path |
|---|---|
| production | `<ZCODE_HOME>/computer-use/ZCode Computer Use.app` |
| preview | `<ZCODE_HOME>/computer-use/preview/ZCode Computer Use.app` |
| development | `<ZCODE_HOME>/computer-use/dev/ZCode Computer Use Dev.app` |

Development and preview use separate sub-roots because their build ids differ and a shared
root would let one install overwrite the other. `ZCODE_HOME` resolves below the runtime's
own data root, so the custom-fork runtime never writes the product's `~/.zcode`.

## Ownership and invariants

* **One owner per grant:** the Helper bundle owns its TCC grants. The desktop main process
  owns the decision to launch it and the `--launcher-pid` value; it must not keep a second
  notion of "granted" that competes with the Helper's own probe.
* The contract declares `grantOwner`/`grant_owner` (`packages/zcode-cua/broker.d.ts`) as the
  identity TCC attributed to, which under LaunchServices is the Helper itself; the settings UI
  displays it so the user can find the right row in System Settings. **The CUA-0.5 helper does
  not report this field yet** — its report carries `identity.bundleId` and
  `identity.designatedRequirement` instead. Populating `grant_owner` from the Helper's own
  verified identity is a CUA-1 task, not something this phase measured.
* **Signature is the identity.** The Helper must never be built with the product's Helper
  bundle id (`dev.zcode.cua-helper`): an installed product Helper already holds a grant under
  that id, so reusing it both collides with the product install and makes any permission
  measurement meaningless. `build-dev-helper.mjs` refuses to build with it.
* **The launch relationship is not an identity.** Because LaunchServices detaches the Helper
  (`ppid = 1`), no parent-pid or process-tree check can authenticate the caller. Any peer
  check must resolve the caller's pid to a code signature and validate it against the
  expected requirement.
* Every helper run self-reports its own bundle id, cdhash and designated requirement, so an
  archived observation is attributable without extra tooling.
* The Helper never implements pointer or keyboard synthesis. Pointer input is
  `REQUIRES_FOREGROUND` per the capability decision; nothing in this foundation depends on it.

## Persistence matrix (measured)

All rows are LaunchServices launches of the same bundle id and path. "granted" means
`AXIsProcessTrusted() == true` for Accessibility and a real ScreenCaptureKit capture that
returns non-blank pixels for Screen Recording.

| Case | cdhash | requirement | Accessibility | Screen Recording |
|---|---|---|---|---|
| baseline | `b284522c…` | `f89ef775…` | GRANTED | GRANTED (1470×956, 42 colours) |
| A helper process restart | unchanged | unchanged | GRANTED | GRANTED |
| C rebuild, same identity | `e62b809c…` changed | unchanged | GRANTED | GRANTED |
| D reinstall/replace at same path | `24aff175…` changed | unchanged | GRANTED | GRANTED |
| E version + build-number change | `895bbf4f…` changed | unchanged | GRANTED | GRANTED |
| later rebuilds in the same session | `ac0c9743…`, `91afe3fe…` changed | unchanged | GRANTED | GRANTED |
| S rebuilt with a **different** certificate | `5ef4ddaf…` | `4dcf904d…` **changed** | LOST | LOST |
| S restore the original identity | `8acace10…` | `f89ef775…` | GRANTED again | GRANTED again |

F: an Electron rebuild is not applicable — the Helper is a separate signed process that does
not link against or live inside the Electron bundle, so rebuilding the app cannot change the
Helper's requirement. Reinstalling the *app* at the same path is likewise irrelevant for the
same reason; what matters is the Helper bundle, covered by C/D/E.

**Result:** a Helper keeps both grants across restart, rebuild, reinstall at the same path,
and version/build changes, and no TCC churn or re-authorization is needed — provided the
signing identity is stable. Changing the certificate loses both grants, and restoring the
identity restores them again. That restore is the evidence that the stored decision survived the
mismatch — with the caveat that "no user action occurred" is *inferred* from the matrix being
non-interactive end to end (it runs in seconds and prompts nothing), not instrumented: nothing
in the archive observes the absence of a click.

## Restart requirements (measured)

A single helper process was granted both permissions while it was running, sampling its state
every second. **Sample times are offsets from the start of the watch, not from the grant** —
the grant moment is not observable in this run, so no propagation delay is claimed:

| Sample | Accessibility | SR preflight | Real capture |
|---|---|---|---|
| before the grant | `false` | `false` | refused: "The user declined TCCs" |
| +7 s | `false` | `false` | **works** (non-blank frame) |
| +37 s | **`true`** | `false` | works |
| a fresh process afterwards | `true` | **`true`** | works |

* **Accessibility and Screen Recording capability require no restart.** The already-running
  process observed both: capture succeeded by the +7 s sample and AX trust read true by the
  +37 s sample, with no new process. **No propagation delay is measured**, so none is claimed:
  those are offsets from watch start, the user's toggle time is unobservable, and the grant may
  have landed immediately before either sample. This run therefore does *not* establish that
  the UI's 6 s restart-verify timeout (`cuaPermissionRestartVerify.ts`, `DEFAULT_TIMEOUT_MS`)
  is too short — that needs a grant time the observer can see. What it does contradict is the
  in-repo comment that a running Helper cannot observe an Accessibility grant without a
  restart: this process did. The readout lag that is real belongs to the preflight API below.
* **`CGPreflightScreenCaptureAccess()` is process-cached.** In the process that had already
  called it before the grant it stayed `false` while capture worked, and it only reported
  `true` in a fresh process. The settings UI must therefore treat the **functional capture
  probe** (`screen_capture_probe_ok` / `queryScreenCaptureProbe`) as the Screen Recording
  truth, and must not report "denied" from preflight alone.
* **Operational restart rule:** no restart is needed to *use* a new grant. Restarting the
  Helper is the reliable way to refresh a *stale readout*, and only that. The UI's existing
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

* granted → preflight (or functional probe) is positive;
* stale → a grant was previously observed for this bundle id, and the current binary reports
  untrusted, or a cached readout disagrees with a functional probe;
* denied → no grant has ever been observed and the probe is negative.

This cannot be derived from the OS alone, so the enum is computed by the permission-service
owner from state it already persists. Do not invent a third OS API to "detect stale": none
exists, and the two conditions above are what the label actually means.

## Development and production identities

The fork and the product are being renamed **AceVra**. Identity reconciliation happens during
integration; this branch records the reserved targets rather than wiring them in, and
introduces **no new permanent ZCode-branded production identity**.

| Purpose | Reserved identity |
|---|---|
| App (production) | `AceVra` |
| App (development) | `AceVra Dev` |
| Helper (production) | `dev.acevra.cua-helper` |
| Helper (development) | `dev.acevra.cua-helper.development` |

`zcode://` stays untouched regardless of the rename, because it remains an OAuth
compatibility requirement.

Migration implications of the rename: **a bundle id is part of the TCC requirement**, so
renaming a Helper creates a *new* TCC identity and every user must authorize it once more;
the old rows remain in System Settings until removed. The CUA-0.5 measurements used the
fork's current in-contract development id (`dev.zcode.cua-helper.dev`) and are kept under it
on purpose — rewriting them to the AceVra id would have silently invalidated the archived
grant proof. The mechanics measured here (requirement-bound persistence, restart behaviour,
stale conditions) are identity-agnostic and carry over unchanged.

## Security implications

* **Grants are requirement-bound, so the Helper cannot be trivially replaced.** A different
  executable at the same path does not satisfy the stored requirement and does not inherit
  the grant: the control bundles and the "different certificate" case both measured
  untrusted. An attacker without the signing key cannot mint a binary that satisfies the
  requirement.
* **A trusted grant is not a whole-binary integrity guarantee.** Measured
  (`final/tamper.log`, cases A–E, five distinct pids): changing one byte inside `__text`,
  changing one byte inside `__cstring`, and appending bytes past the signed code limit all make
  `codesign --verify` fail (`rc=1`), and in every case the bundle still launched through
  LaunchServices and still held **both** grants. `tccd` checks the *requirement* against the
  embedded signature blob, which none of those edits touched; it does not re-hash the code
  windows. So possession of the grant proves the requirement was satisfied, not that the image
  on disk matches what we built. Integrity decisions must call code-signature validation
  explicitly (`SecCodeCheckValidity` with strict/all-architecture flags) — which is exactly the
  check that would catch these edits.
* **The parent process is not an authenticator.** Under LaunchServices the Helper's parent is
  `launchd` (`ppid = 1`), so `getppid()` carries no information about who asked for the
  launch. `--launcher-pid` must be validated by resolving that pid to a code signature and
  checking it against the expected requirement; a pid alone is trivially spoofable.
* **Broker channel authentication is inherited, not built here.** The contract already
  carries a token/`pluginAuthority` transport for the broker; this foundation only proves the
  identity the channel can be bound to. CUA-1 must keep verifying the peer's signature
  before honouring broker requests, and must not rely on the TCC grant as a stand-in.
* Not measured here (and therefore still assumptions): broker token enforcement, the
  `same_pid_keyboard_ambiguity`-style route guards, and anything requiring a Developer ID.

### Development-identity portability caveats

* The requirement is anchored to the **certificate's SHA-1**, so the identity is stable on this
  machine but not across machines: regenerating the certificate (a fresh machine, a deleted
  keychain, or `--force`) yields a new requirement and every grant must be given again. The
  create script is idempotent for this reason and reuses an existing identity.
* The keychain auto-locks (after 6 h, and on sleep). The create script unlocks on its reuse
  path as well as its create path, and the build signs with an explicit `--keychain`; if a build
  fails on a locked keychain, run `security unlock-keychain -p "$(cat
  <signing-dir>/keychain-password)" <keychain>` first.
* The certificate expires 2036-09-20. Rotation is not addressed here: a rotation is a new
  requirement and therefore a re-grant.
* The password file is `0600` inside the isolated namespace and is a development-only secret,
  not a product credential.

## Failure semantics and migration boundary

* If the signing identity is unavailable, `build-dev-helper.mjs` fails rather than falling
  back to ad-hoc signing, because ad-hoc signing silently produces a grant that dies on the
  next rebuild. The contract's explicit local-development escape hatch
  (`ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL`) is honoured only when asked for, and the mode is
  printed and recorded in the report so an unsigned run cannot be mistaken for a signed one.
* Removing the signing keychain, the dev helper bundle and the evidence directory restores
  the machine to its prior state; the only durable system-side effect is the TCC entry for the
  development helper id, which `tccutil reset Accessibility|ScreenCapture <bundle-id>` removes.
* No product bundle id, and no existing installed Helper (the product's own installs under
  `~/.zcode/computer-use/`) is read, written or re-signed by this work.
* Nothing here is wired into packaging: the dev helper is never bundled into the app. When
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

* The Helper is its own TCC owner and is launched via LaunchServices with `--launcher-pid`;
  the app's own grant does **not** cover the Helper.
* A stable signing identity is a prerequisite; a rebuild with the same identity preserves
  grants, so the permission onboarding flow does not need to run again after an update.
* Screen Recording must be judged by a functional capture probe (window-scoped capture),
  never by preflight, and never by System Settings appearance.
* No restart is required to use a freshly granted permission; a Helper restart is a readout
  refresh, and tccd propagation can take up to tens of seconds, so onboarding must poll
  rather than fail.
* Accessibility is read via the Helper's own AX authorization; `AXIsProcessTrusted()` is the
  authority, and the granted/denied/stale verdict is computed by the permission owner.
* Pointer input remains `REQUIRES_FOREGROUND` and is not covered by this foundation.
