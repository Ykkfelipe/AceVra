# CUA-0.5 — permission/identity foundation (2026-09-23)

Run archive for the permission/identity proof. Spec: `packages/zcode-cua/specs/computer-use.md`.
Harness: `packages/zcode-cua/native/cua-helper/`. Host: macOS 27.0 (26A428), arm64.

Every observation below is a real launch of a real helper built from this repository. Each
report is the helper's own JSON, containing its bundle id, cdhash, designated requirement,
launch arguments, Accessibility trust, Screen Recording preflight, and — where requested — a
real ScreenCaptureKit capture and an Accessibility read. Nothing is inferred from System
Settings appearance.

## What was measured, and what it means

**1. The grant subject is the Helper, not the app** (`L1-exec`, `L2-open`, `L2b`,
`L3a-exec-request`, `L4-open`, `L5-control`, `CTRL2a`, `CTRL2b`)

| Launch path | parentPid | Accessibility | Screen Recording |
|---|---|---|---|
| `exec` child inside the app's process tree | the shell | `true` | capture OK |
| `/usr/bin/open` (LaunchServices — the contract's path) | **1** | **`false`** | refused: "The user declined TCCs" |

Identical results with and without `--launcher-pid`, so the launcher pid is not a permission
lever. A second identically signed control bundle stayed untrusted (`L5-control`,
`CTRL2b-open`), and an `exec` run carrying `AXIsProcessTrustedWithOptions(prompt: true)` did
**not** grant a fresh bundle id (`CTRL2a` → `CTRL2b`) — tested precisely because "the prompt
silently granted it" was the competing explanation for the helper becoming trusted, and it is
refuted. The helper became trusted only after the user authorized it.

**2. Grants survive rebuild / reinstall / version change** (`matrix.log`, `baseline`,
`A`, `C`, `D`, `E`, and later rebuilds `F`, `I`, `K`, `L`)

| Case | cdhash | requirement | Accessibility | Screen Recording |
|---|---|---|---|---|
| baseline | `b284522c…` | `f89ef775…` | GRANTED | GRANTED (1470×956, 42 colours) |
| A helper restart | unchanged | unchanged | GRANTED | GRANTED |
| C rebuild, same identity | `e62b809c…` | unchanged | GRANTED | GRANTED |
| D reinstall at same path | `24aff175…` | unchanged | GRANTED | GRANTED |
| E version + build change | `895bbf4f…` | unchanged | GRANTED | GRANTED |
| F/I/K/L later rebuilds | `ac0c9743…`, `91afe3fe…` | unchanged | GRANTED | GRANTED |
| S different certificate | `5ef4ddaf…` | **`4dcf904d…`** | **LOST** | **LOST** |
| S restore original identity | `895bbf4f…` | `f89ef775…` | GRANTED, **no user action** | GRANTED, no user action |

The cdhash changed while both grants held in every case; they broke exactly when the
*requirement* changed, and returning to the original identity made them usable again. The
"no user action" half of that is inferred from the matrix being non-interactive end to end
(seconds, no prompts), not instrumented — nothing here observes the absence of a click.

Case F (Electron rebuild) is not applicable: the Helper is a separate signed process, so
rebuilding the app cannot alter its requirement.

**3. No restart is needed to use a grant — the preflight API is what goes stale**
(`G-after-reset`, `H-watch.jsonl`, `I-fresh-after-grant`)

128 one-second samples from a single process (`H-watch.jsonl`, all `pid=61220`; an earlier
draft said 115 — the file has 128 lines). Sample times are offsets from the start of the watch,
**not** from the grant: the grant moment is not observable in this run, so no propagation delay
is claimed:

| time | Accessibility | SR preflight | real capture |
|---|---|---|---|
| before grant | `false` | `false` | refused |
| +7 s | `false` | `false` | **works** |
| +37 s | **`true`** | `false` | works |
| fresh process after | `true` | **`true`** | works |

So the running process observed both permissions with no restart, while
`CGPreflightScreenCaptureAccess()` kept returning `false` in the process that had already
called it — it only reported `true` from a fresh process. Judge Screen Recording by the
functional capture probe, never by preflight. The exact tccd delay is not measurable here
(the user's toggle time is unobservable); ≤37 s is the only bound this run supports.

**4. "stale" is a real condition, but not one the OS reports as such** (`S-*`, `H-watch`)

Two reproducible conditions: a stored decision that the current binary cannot satisfy
(requirement mismatch — preflight says `false` exactly like `denied`, yet the decision is
still there, proven by the no-action restore), and a process-cached readout that a fresh
probe contradicts. Neither is derivable from one preflight call, so the permission owner
must compute `stale` from remembered prior-grant state.

**5. Security** (`J-tampered`, `J2-tampered`, `J3-text-tampered`, `matrix.log` S row, `L5`, `CTRL2b`)

A different certificate and control bundles do not inherit the grant, so the Helper cannot be
trivially replaced by another program. But `final/tamper.log` (cases A–E, five distinct pids)
shows that changing one byte in `__text`, changing one byte in `__cstring`, and appending bytes
past the signed code limit all make `codesign --verify` fail while the bundle still launches and
still holds **both** grants — `tccd` validates the requirement against the embedded signature
blob, not the code windows. A grant is therefore not a whole-binary integrity guarantee, and
integrity must be checked explicitly with `SecCodeCheckValidity`. Under LaunchServices the
parent is `launchd` (`parentPid = 1`), so the parent relationship authenticates nothing:
`--launcher-pid` must be resolved to a code signature.

## Files

`final/` — the authoritative pass: `matrix.log` (with per-row source/binary sha256 and the
launch command), `commands.log`, `tamper.log`, and the `R1`/`R2`/`R3` launch-path rows.
`*.report.json` — one helper report per observation; the file name is the case label.
`H-watch.jsonl` — the per-second series from the single long-running granted process.
`matrix.log` — the full persistence-matrix transcript, including signatures and requirements
printed after each case. `identity.log` — signing identities, certificate fingerprints,
bundle identity, and the product-adjacent identities deliberately not used.
`L1-exec.log`, `L2-open.log` — launch-path transcripts with the process tree.

## Reproducing

```bash
export ZCODE_CUA_HOME="$HOME/.zcode-fork-cua-home" ZCODE_HOME="$HOME/.zcode-fork-cua-home/.zcode"
bash packages/zcode-cua/native/cua-helper/signing/create-dev-signing-identity.sh
node packages/zcode-cua/native/cua-helper/build-dev-helper.mjs
OUT_DIR=$PWD/spikes/cua-05-identity/evidence/<new> \
  bash packages/zcode-cua/native/cua-helper/run-permission-probe.sh L1 exec --capture
OUT_DIR=... bash packages/zcode-cua/native/cua-helper/run-permission-probe.sh L2 open
OUT_DIR=... bash packages/zcode-cua/native/cua-helper/run-permission-matrix.sh "$PWD/spikes/cua-05-identity/evidence/<new>"
```

Reproducing case 2/3 requires granting the helper once in System Settings → Privacy &
Security → Accessibility and Screen Recording. Use `tccutil reset Accessibility|ScreenCapture
dev.zcode.cua-helper.dev` to return to the denied baseline; that is the only durable
system-side effect of this phase and it is scoped to this bundle id.

## Caveats recorded rather than hidden

* The measured bundle id is the fork's current in-contract development id
  `dev.zcode.cua-helper.dev`. The product is being renamed to AceVra, whose reserved helper
  identities are `dev.acevra.cua-helper` / `dev.acevra.cua-helper.development`; they are not
  wired in on this branch because a bundle id is part of the TCC requirement and renaming it
  would have invalidated this archive.
* The persistence proof uses a **self-signed** development certificate, not a Developer ID.
  The requirement shape differs (no Apple anchor, no Team), but TCC keys on the requirement
  either way, so the persistence property is expected to carry over; the Developer ID variant
  is argued from the requirement shape, not measured, because no Developer ID exists here.
* `spctl` rejects the helper: an untrusted self-signed certificate is a distribution
  limitation, not a TCC one.
* Case B (app restart) is not a separate row: under LaunchServices every row is already
  launched by a fresh caller, and the app is not in the permission path. Case F is explained
  above.
* All rows are the persistence matrix's own output; the earlier rows in the parent directory
  predate the final helper revision and are kept only as the exploratory pass.
