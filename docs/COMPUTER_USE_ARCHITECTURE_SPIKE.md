# Computer Use Architecture Spike (CUA-0)

Status: spike complete, no production code changed.
Worktree: `/Users/felipemore/Projects/ZCode-Fork-cua`
Branch / HEAD: `feature/native-computer-use` @ `402bc12c0ff93600b890d45585c5834d1701889f`
Baseline check: annotated tag `fork-browser-artifacts-v1` dereferences to exactly `402bc12`, so this branch
sits on the documented known-good browser/artifact baseline. Working tree was clean at spike start.
Host: macOS 27.0 (build 26A428), arm64. Probe toolchain: `/usr/bin/swiftc` 6.2.3, **Command Line Tools
only — no full Xcode**. SDK 26.2.

Machine, verification, and evidence claims in this document are marked with what was actually done.
Where something was **not** executed, it says so.

---

## 1. CURRENT STATE — what exists in this fork today

This is the most important finding of the audit, and it reframes the whole plan:

**The fork already contains the complete seam layer for Computer Use, with a deliberately fail-closed
native core.** The work is not "invent a Computer Use architecture"; it is "supply the native engine
behind an existing, unusually well-specified contract".

`packages/zcode-cua/README.md:1-9` states it outright:

> API-compatible placeholder package for Computer Use. This build ships without Computer Use: every
> runtime surface (Computer Use runtime, broker RPC, Helper install/launch/verify, PiP session client,
> native addon loader) reports **unavailable** and fails closed [...] License: Apache-2.0.

### 1.1 Real, wired, and already correct

| Surface | Location | State |
|---|---|---|
| Broker contract + refusal vocabulary | `packages/zcode-cua/broker.d.ts` | Real types: `foregroundRequired`, `notSelectable`, `notSettable`, `elementUnavailable`, `actionUnavailable`, `isReadOnlyBrokerMethod` |
| Permission contract | `packages/zcode-cua/broker.d.ts:95-124` | `CuaPermissionState = "granted"\|"stale"\|"denied"\|"unknown"`, `grantOwner`, `accessibility_probe_ok`, `screen_capture_probe_ok` |
| Helper install/launch/verify | `packages/zcode-cua/broker-server.d.ts` | `createCuaHelperInstaller`, `resolveHelperPermissionSubjectIdentity`, `buildHelperOpenArgs(spec, launcherPid)`, `publishCuaBrokerRefreshMarker`, `CuaHelperLifecycleManager`, `reapOrphanedHelpers` |
| AX read-only method factory | `packages/zcode-cua/broker-server.d.ts:74-80` | `createAxReadOnlyMethods(source, registry, options)`, `ROLE_TO_KIND`, `roleToKind` |
| Frame/display caps | `frame-contract.js`, `host-display-contract.js` | **Caps only**: 200 KiB inline base64, 16 KiB meta are real constants. The credential-text predicates are **fail-closed stubs returning `false`** (see §1.2) |
| PiP live session events | `packages/zcode-cua/pip-session.d.ts:1-46` | `turn-started / focus-changed / tool-started / turn-completed / turn-failed / session-closed` |
| node_repl CUA broker + bridge | `apps/zcode-cli/packages/node-repl-host/src/cua-broker.ts`, `cua-bridge.ts` | Real unix-socket broker, 32-byte token compared with `timingSafeEqual`, 32 MiB response cap, `Symbol.for("zcode.node-repl.computer-use-bridge")` |
| MCP projection for CUA | `apps/zcode-cli/packages/core/src/mcp/index.ts:46-166` | `mcp__computer-use__*` canonical + `mcp__computer_use__*` provider alias, `permissionCapabilityGroup: "official_cua"`, 256 KiB result budget |
| Permission onboarding UI | `packages/desktop/src/main/cuaPermissionDragPanel.ts`, `cuaAccessibilitySettings.ts` (646 lines), `desktopCuaPermissionIpc.ts` (527), `cuaSystemSettingsWindowWatcher.ts` | Real: opens the exact System Settings panes, verifies the helper bundle fingerprint before dragging, waits for return via `/usr/bin/lsappinfo front` |
| CUA settings + tool renderers | `packages/ui`. ~2,900 lines across ~35 files | `ComputerUseSection.tsx` (820), 15 tool-call renderers covering 26 actions |
| Turn tracker / PiP service | `packages/services/src/zcode-agent/cuaOperationTurnTracker.ts`, `cua-permission-broker/cuaPipSessionService.ts` | Real |

### 1.2 Placeholder / absent

* Everything in `packages/zcode-cua/*.js` that would touch the machine: `createComputerUseRuntime()`
  returns a hardcoded unavailable payload; `callBrokerMethod`, `dispatchRequest` throw; the Helper host is
  a stub with `running=false`, `socketPath=null`; `loadRealNativeAddon` throws; `createAxReadOnlyMethods`
  returns `{}`; `isBrokerReadOnlyMethod` returns `false`.
* **Zero native capture/input code anywhere in the tree.** Searches for `ScreenCaptureKit`,
  `AXUIElement`, `CGEvent`, `NSPasteboard` return no implementation hits.
* **The frame credential-redaction predicates are stubs too.** `containsOfficialCuaImageRefCredentialText`
  returns `false` unconditionally (`packages/zcode-cua/frame-contract.js:11-13`), as do
  `isOfficialCuaImageRefText`, `containsImageRefAuthority`, `parseOfficialCuaImageRef`,
  `attestOfficialCuaFrameContent` and `findOfficialCuaFrameContentPair`. They fail closed because CUA is
  absent, **not** because a credential filter exists. §12's privacy requirement is therefore
  *implement this*, not *preserve this*.
* No CUA Helper app source; `scripts/build-cua-helper-app.mjs` and `scripts/cua-helper-sea-base.mjs` are
  referenced in comments but do not exist.
* No CUA spec document and no CUA tests.
* `docs/` does not exist in this repo (this file creates it at the brief's request; see §15 for the
  durable spec location the repo convention actually expects).

### 1.3 The two findings that drive every recommendation

**(a) The existing contract already encodes the correct macOS permission model.** It has a
`HelperPermissionSubjectIdentity { appPath, executablePath, displayName, bundleId }`, a `grantOwner`
field, a `"stale"` permission state, probe-based verification instead of trust, and — decisively — a
`ZCODE_CUA_LAUNCHER_PID` mechanism. `packages/desktop/src/main/desktopHostProcess.ts` documents why:

> macOS-only: the Computer Use Helper launcher runs inside this forked host utilityProcess, whose
> code-signing identity is a nested Electron helper (NOT dev.zcode.app). Publish THIS (main Electron)
> process's pid — which IS dev.zcode.app — so helperLauncher passes it as `--launcher-pid`

Our PoC **measured this model working** (§4.4): grants follow the responsible process, so a helper
launched on behalf of the signed app inherits the app's grant, while a standalone bundle starts
untrusted. The contract is right; only the engine is missing.

**(b) The dev launcher cannot be used as-is.** `mise.toml [tasks.dev]` hardcodes
`ZCODE_DATA_BASE_DIR = "{{env.HOME}}/.zcode-fork-dev-home"` — the canonical integration namespace this
spike was told not to touch. `mise run dev` therefore must not be used from this worktree; see §15 for the
override recipe (explicit env wins in `scripts/custom-fork-dev-env.mjs`).

---

## 2. REQUIREMENTS

Derived from the mission brief, with the honesty constraints kept explicit.

**R1 Foreground/exclusive control.** Observe the screen; enumerate apps and windows; open/activate apps;
move the cursor; click/double/right-click; drag; scroll; type; keyboard shortcuts; clipboard; menus;
Finder and native/Electron/browser apps; system dialogs where macOS permits; Accessibility tree
inspection; screenshots; user-interruption detection.

**R2 Background control.** Operate a specific app/window while it is not frontmost; capture that window
without raising it; perform semantic actions without moving the user's physical cursor; target input to the
intended app. **The system must distinguish what genuinely works in the background from what requires
foreground activation** — and must not call something "background" merely because a window was not
visibly focused during one test.

**R3 Isolated desktop (later).** A private desktop/VM with its own cursor, apps and state; a small live
preview the user can expand, pause, stop or take over.

**R4 Shared harness capability.** Computer Use belongs to the harness, not to one model or vendor
backend. Not "GPT computer use" or "Claude computer use".

**R5 Permission identity stability.** No churn from repeatedly-generated random helper identities.

**R6 Security boundaries.** Destructive actions, password fields, payments, system settings, app
installation, shell escalation, clipboard exposure.

**R7 Remote (`/fork`) later.** Preview/pause/stop/approve/take-over over the existing outbound relay.
No inbound ports.

**R8 Zero inference during this phase.** All primitives proven deterministically.

---

## 3. CANDIDATE EVALUATION

Method note: two research passes read published source and documentation (via GitHub API and
`raw.githubusercontent.com`), and — for trycua/cua — a **real binary trial was executed on this machine**
(§4.4). Claims the research could not verify from source are marked as such.

| Project | License | Language / runtime | Background model | Real vs claimed | Embeddability | Verdict |
|---|---|---|---|---|---|---|
| **trycua/cua** — `libs/cua-driver` | **MIT** (core, Rust workspace + npm + PyPI). AGPL-3.0-only trap only in optional `cua-som` / `cua-perception` perception artifacts, absent from the default build | Rust daemon + UniFFI SDK; `@trycua/cua-driver` npm; `cua_driver_node_runtime.node` | **Background-first by design.** AX rung + window-scoped pointer via private SkyLight SPI (`SLEventPostToPid`, `CGWarpMouseCursorPosition` avoided); explicit `delivery.mode: background\|foreground`; refuses rather than escalating silently | **Verified by trial**: background AX click succeeded on this machine; it reports route availability per window | Strong: signed daemon outside ASAR + embedded Node host; its docs say the *host* should own permission UI | **Recommended as an optional backend, not as our identity** (§5) |
| **hyprcat/mac-cua** | Apache-2.0 | Python 3.13+, `uv`, MCP stdio, 9 tools | PID-targeted only: `CGEventPostToPid`, **never** `CGEventPost`; headless virtual cursor; AX-first ladder; private SkyLight fallbacks with macOS-26 removals handled | Source read: real, but **very early stage** — repo created 2026-04-20, ~41 commits, ~28 stars, README says "early-stage software" | Weak: unsigned Python, TCC identity belongs to the host | **Reference design, not a dependency.** Its escalation ladder mirrors what we built independently |
| **openclaw/Peekaboo** | MIT | Swift, CLI + optional MCP | "Targeted semantic and typed CLI input uses background delivery"; app/PID-only chords require explicit foreground consent | Not source-verified in this pass | Attractive: Swift CLI matches our in-repo precedent | **Needs a deeper pass** before CUA-1 (§18) |
| cliclick | BSD-3 | Objective-C | Global only (`CGEventPost`); no PID targeting | — | Poor | Rejected: moves cursor by definition |
| steipete/macos-automator-mcp | MIT | TypeScript, AppleEvents/JXA | Indirect, app-dependent | **Archived** | Poor | Rejected |
| Hammerspoon | MIT | ObjC + Lua | Both (`hs.axuielement`, `hs.eventtap`) | Real but no background guarantee | Heavy (Lua host) | Rejected as engine; useful reference |
| tmandry/AXSwift | MIT | Swift | AX only | **Stale (last push 2023)** | Library-level | Rejected |
| `antimatter15/macos-background-cua-skill` | **No license** | Python | AX → `CGEventPostToPid` | Small, closest single-file analogue | — | Rejected: **unlicensed, cannot be used** |
| pyautogui / openai-cua-sample-app | BSD / MIT | Python | Global only | — | — | Rejected: not a background architecture |

### 3.1 The decisive architectural conflict

The fork's contract requires **ZCode to be the TCC grant owner** (`ZCODE_CUA_LAUNCHER_PID`, `grantOwner`,
`resolveHelperPermissionSubjectIdentity`). cua-driver's model is the opposite: it wants **its own** signed
bundle (`com.trycua.driver`, TeamID `YCK386LBJ7`) to hold the grants.

This is not a documentation claim — it was **measured** (§4.4). Its `permissions status` refuses to report
the inherited grant, and its daemon blocks on a permission gate that opens System Settings for its own
identity:

> `daemon_running: false, reason: "no CuaDriver daemon is running under the driver's own identity
> (com.trycua.driver), so its real TCC status can't be read from this process."`

And even with the gate bypassed, its own `check_permissions` says:

> These booleans reflect the TCC identity of the app that launched this process (e.g. your terminal/IDE),
> NOT an installed CuaDriver app bundle. A standalone check can read `true` here while the driver's bundle
> has no grant.

So adopting cua-driver as *the product's* Computer Use identity would mean shipping a second signed app
that owns its own permissions — a second permission-identity surface, a second thing the user must grant,
and a foreign bundle identity in our trust story.

---

## 4. LIVE ZERO-INFERENCE RESULTS (what actually worked on this Mac)

All results below come from a disposable Swift probe built for this spike
(`spikes/cua-probe/`, ad-hoc signed, bundle id `dev.zcode.cua.probe`). The suite is
`spikes/cua-probe/run-tests.sh`. Evidence (JSON snapshots, PNGs, per-action logs) is written under
`spikes/cua-probe/evidence/`.

**Reproducibility, stated honestly.** The final run is **17/17 assertions passing**
(`evidence/run-20260923-014735`). That is *not* a clean streak, and the full archived history is:

| Run | Passed | Failed | Cause of failure |
|---|---|---|---|
| `run-20260923-012828` | — | — | pre-counter revision; two harness defects (element-identifier caching, no cursor warp) |
| `run-20260923-012956` | 13 | 1 | vacuous cursor assertion (cursor already on target) |
| `run-20260923-013103` | 1 | 10 | probe binary absent after a failed compile; this also exposed a test that passed **vacuously** |
| `run-20260923-013138` | 13 | 2 | event tap went flaky; foreground-typing assertion defeated by leftover text |
| `run-20260923-013257` | 13 | 2 | global click did not move the cursor — **the real primitive defect** |
| `run-20260923-013353` | 15 | 0 | first fully clean run |
| `run-20260923-014649` | 16 | 1 | new window-target assertion found a defect in the assertion itself |
| `run-20260923-014735` | 17 | 0 | final |

Every failure was a defect in **the harness or the probe's primitives**, not a capability regression — but
the spike's early claim of reproducibility was overstated, and a suite whose own assertions were wrong
three times deserves that caveat attached. The assertion count grew 13 → 15 → 17 as assertions were added,
so pass/fail counts are only comparable within a given revision.

Method: every action is bracketed by environment snapshots. A result is only recorded as *background* if
the frontmost application, the hardware cursor position, **and** the front window's owner were all
unchanged across the action.

### 4.1 Test A — observation

| Measurement | Result |
|---|---|
| Application enumeration (`NSWorkspace.runningApplications`) | 9–11 entries, **36–44 ms** *as measured; see timing caveat* |
| Window enumeration + z-order (`CGWindowListCopyWindowInfo`) | 8–14 windows, **46–58 ms** *as measured* |
| AX tree walk (`AXUIElementCreateApplication`) | **~242 nodes**, **137–170 ms** *as measured* |

**Timing caveat — these numbers include the harness's own overhead.** `run-tests.sh` brackets each command
with two separate `python3 -c` invocations, so the reported figure is probe time **plus one interpreter
startup** (≈20 ms). The spike's own evidence proves it: `run-20260923-013103/summary.log` reports
`apps: 1 entries, 21.2 ms` for a run in which the probe binary **did not exist** and the exec failed
instantly. Subtract roughly 20 ms: enumeration ≈ 16–24 ms, window list ≈ 26–38 ms, tree walk ≈ 117–150 ms.
The one latency number in this document that is **not** inflated is the capture latency, because the probe
reports it internally (`latencyMs` from `shot`). Treat all in-suite bracket timings as upper bounds.

**Node count caveat.** "249" (quoted in an earlier draft) was a `grep -c .` **line** count and included
multi-line `AXDescription` continuation fragments. The probe's own `nodes=` note reports **242** for the
same walk.

Applications and windows need **no** TCC permission — only capturing window *images* does. This is already
relied upon in-repo: `packages/desktop/native/macos-window-bounds/main.swift:1-8` explains that
`CGWindowListCopyWindowInfo` needs no permission, which is why the permission-onboarding panel can locate
System Settings *before* any grant exists.

### 4.2 Test B — semantic action

`AXUIElementPerformAction(AXPress)` on Calculator's controls by `AXIdentifier`:
clear → 7 → + → 3 → = produced display `7 + 3 | 10`. Verified by AX read-back, not by return code.

Latency: **2.3–32.6 ms** per press (median ≈ 3–7 ms).

**B2 — the return code is not evidence.** A press reported `axError=0 (success)` while
`elementChanged=false` on the pressed element. **Correction to an earlier draft of this document: this is
NOT a reproduction of upstream trycua/cua#2619.** In that same run the arithmetic *worked* —
`PASS B1 semantic arithmetic 7+3=10: 10` — and `elementChanged=false` is simply because a stateless
button's own attributes do not change when it is pressed, which the probe itself documents
(`main.swift`, `elementChanged` field comment). No run in `evidence/` contains an AX press that returned
success and had no effect.

The real reason the return code is insufficient is narrower and still important: **the API's success value
carries no information about the effect.** Success is established only by reading back application state,
which is what B1 does. The specific upstream ghost-action hazard (#2619) is a *disabled* element
(`AXEnabled == false`) silently no-op'ing, which is why §7/§9 now require re-resolving the target and
checking `AXEnabled` before an AX action — a precondition this spike did **not** test.

### 4.3 Test C — background (target NOT frontmost, all three invariants checked)

Background condition established by activating TextEdit; Calculator stayed non-frontmost.

| Test | Action | Result | Frontmost / cursor / top window changed? |
|---|---|---|---|
| C1 | ScreenCaptureKit per-window capture of the non-frontmost window | **WORKED** — 460×816 @ scale 2, not blank (279 distinct colours), **93–123 ms** | **No / No / No** |
| C2 | AXPress sequence on the non-frontmost app | **WORKED** — display `2 + 3 \| 5` | **No / No / No** |
| C3 | PID-routed keyboard (`CGEventPostToPid` + unicode payload) | **WORKED** — typed `8`,`1` into the non-frontmost app | **No / No / No** |
| C4 | PID-routed **coordinate click** (`CGEventPostToPid` mouse down/up) | **NO EFFECT** (display unchanged) | No / No / No |

**True background control was demonstrated** for: window capture, accessibility actions, and keyboard
text entry. It was **not** demonstrated for pointer clicks.

### 4.4 Permission attribution — measured, not assumed

The same binary, two launch paths:

| Launch path | Responsible process | Accessibility | Screen Recording |
|---|---|---|---|
| `open` (LaunchServices) | its own (`dev.zcode.cua.probe`, ppid 1) | **false** | **false** |
| executed as a child of the trusted app | inherited | **true** | **true** |

This empirically confirms the model the existing contract already assumes: **TCC grants follow the
responsible process, so a helper launched on behalf of the signed app inherits the app's grant, while a
standalone bundle starts untrusted.** It is the strongest single piece of evidence in favour of keeping the
`ZCODE_CUA_LAUNCHER_PID` design.

**Precision caveat (raised in review, and correct).** The archived logs record `parentPid` and the two
trust booleans, but **never resolve the parent's identity** — so strictly, they show *a child of a trusted
parent* inherits trust, not that the parent was `dev.zcode.app`. The claim "the ZCode app owns the grant" is
therefore an inference from the process tree plus the in-repo comment, not a measurement of the parent's
bundle id. Two further imprecisions worth stating: the measured *untrusted* case **is** the LaunchServices
path, while the measured *inheritance* case is a plain exec-child — these are two different mechanisms, and
this section should not be read as having measured LaunchServices-with-launcher-pid specifically. §18's
verification step should resolve the parent identity and separate the two variables.

### 4.5 Test D — foreground, and the contrast that makes Test C meaningful

| Test | Result |
|---|---|
| D1 explicit activation | frontmost app changed TextEdit → Calculator in **23 ms** |
| D1 global coordinate click (**with** explicit cursor warp) | cursor moved to exactly the click point `(319,663)`; press took effect (display `7`) |
| D2 foreground typing | unique marker `zcua-013417` landed intact |
| D3 PID-routed click while the target **is** frontmost | **still no effect** |

**D3 is the clean control**: PID-routed pointer clicks did not work on Calculator *even when it was
frontmost*, so C4's negative result is a property of that event route and target app, not of background
mode.

**A real defect found in the primitive, not in the test.** The first implementation of `global-click`
posted a mouse event whose location field pointed at the target but did not move the pointer. The click
was routed by the *actual* pointer position, so it landed wherever the cursor already happened to be — and
the earlier run "passed" only because the cursor was coincidentally already on target. Fixed by warping
the cursor before posting (§9). This is exactly the class of bug that makes a naive CUA layer look correct
in a demo and fail in use.

### 4.6 Test E — user interruption

| Test | Result |
|---|---|
| E1 listen-only `CGEventTap` at `.cghidEventTap` | **live**: saw our global synthetic clicks and identified them as ours via `kCGEventSourceUserData` (tag `0x5A43_4F44_45_0001`) |
| E2 same tap vs PID-routed input (key + click) | **0 events** — PID-routed input never reaches the global chain |

**Disclosure on E1's reliability:** the final run injected 6 mouse events (3 clicks) and the tap recorded
**4**; an earlier run recorded 6, and one recorded **0**. So the tap is *live* but **lossy**, and the
assertion only requires `> 0`. This is a real limitation for interruption detection (§10): a dropped
`.keyDown` is a missed user takeover. Any production monitor needs the tap's own disable/timeout handling
*and* an independent liveness check, and should not be trusted as the sole takeover signal.

E2 is the architectural foundation of interruption detection: a global tap sees real user input and
global injections, but PID-routed events bypass it entirely. A tap that is also tag-filtering our own
global events therefore sees *essentially only* real input.

Honest limitation: no physical keypress or mouse movement occurred during the watch windows, so this run
proves the tap is live and that the filter distinguishes our events, **but it did not itself observe a real
hardware event**. Physical input arrives on the same chain with `kCGEventSourceUserData = 0`, so the
mechanism is sound; it is not yet exercised end to end.

### 4.7 cua-driver trial (real binary, checksum-verified)

Downloaded `cua-driver-rs-v0.28.2-darwin-arm64.tar.gz` (70,078,069 bytes), SHA-256 verified against the
release `checksums.txt`
(`818ddefa0fa8ba2ec9cba837c7aa634a4b064221c748752cf49c5b08e2c94e8c` — **match**). Installed into
`~/.zcode-fork-cua-home/tools/`, never into `/Applications`.

Confirmed facts:

* `cua-driver 0.28.2` runs. The bundle is Developer-ID signed, hardened runtime,
  `Identifier=com.trycua.driver`, `TeamIdentifier=YCK386LBJ7`.
* `Info.plist` declares **`LSMinimumSystemVersion = 13.0`**, which contradicts the project's own tutorial
  claim of "macOS 14 (Sonoma) or later". Documentation/reality drift — relevant for our support floor.
* **Telemetry is on by default** ("Cua Driver sends content-free product telemetry by default"). Disabled
  during this spike (`cua-driver telemetry disable`). **Adopting this dependency would import a
  third-party telemetry channel unless explicitly disabled.**
* Its daemon refuses to start usefully without its own grants and opened System Settings. With
  `--no-permissions-gate`, `check_permissions` returned `accessibility: true` but `screen_recording: false`
  (attribution `caller`, note `disclaim_env: true`).
* `list_windows` worked and independently cross-validated our probe's window IDs (Calculator = 4256).
* `get_window_state` returned 162 elements and, importantly, a per-window **routing report**:
  `routes: [accessibility: available, window_pointer: available, pid_keyboard: available]`.
* **A true background click succeeded**: `click` on Calculator's "9" by `element_index` + `snapshot_id`
  returned `route: "accessibility"`, `delivery: {"mode": "background"}`, the display changed `0 → 9`, and
  frontmost/cursor/front-window were all unchanged.
  **Evidence caveat: this result was observed interactively and its transcript was NOT archived** under
  `evidence/` — the reviewer flagged this as the one decision-relevant claim lacking raw evidence, and
  that is accurate. Everything else in this subsection is file-verifiable (tarball checksum, signatures,
  `Info.plist`, CLI surface, routing report). Treat the click result as a strong observation pending the
  archived re-run specified in §18, not as archived proof. The routing report and the
  `snapshot_id_required` refusal *are* reproducible from the CLI at any time.
* Its honesty model is real: that successful click was reported as **`effect: "unverifiable"`**, not
  "confirmed" — matching its documented contract ("An action that reached an actuator but lacks a trusted
  readback is `unverifiable`, not confirmed").
* The pixel-rung click (x,y) did not take effect, but a system Accessibility prompt
  (`universalAccessAuthWarn`) was on screen at the time, so **this particular result is inconclusive and is
  not counted as evidence**.

**What the trial did and did not establish.** It established that cua-driver's background AX path really
works on macOS 27 and that its self-reported routing model is honest. It did **not** establish the
window-scoped `window_pointer` route end to end: that needs Screen Recording granted to *its own* identity,
which requires an interactive user decision and was outside this spike's unattended budget.

> **Superseded by §4.11.** The missing verification named here (the `window_pointer` route, end to end)
> was subsequently run as a bounded follow-up with the grant question resolved first — it turned out that
> no separate grant was needed at all, because the daemon inherits the launching app's TCC identity. The
> route works; the *decision* it implies is in §4.11.

### 4.8 Latency summary (rough, local, macOS 27, arm64)

| Primitive | Measured |
|---|---|
| App enumeration | 36–44 ms *as bracketed by the harness (≈20 ms of that is interpreter startup)* |
| Window enumeration | 46–58 ms *likewise* |
| AX tree walk, ~242 nodes | 137–170 ms *likewise* |
| AX action (press) | **1.4–32.6 ms** (in-process, not bracketed) |
| Per-window screenshot (SCK, 460×816 @2x) | **93–123 ms** (in-process) |
| PID-routed keystroke/text | **21.1–37.8 ms** (in-process) |
| App activation | **20.6–23.5 ms** (in-process) |

The bracketed figures are upper bounds (see the timing caveat in §4.1); the in-process figures are exactly
as reported by the probe. Ranges are the full observed spread across all archived runs, not a best case.

These are the "System One" motor primitives: all in the tens-to-low-hundreds of milliseconds, deterministic,
and independent of any model call. cua-driver's own documentation notes its AX walk can take **up to 20 s**
on very large trees, which is a caution about tree-walking cost rather than about the primitives
themselves — we measured ~140 ms on a 242-node tree.

### 4.9 Element identity is state-dependent — a hard-won constraint

The **same physical button** at the same position `(349,585)` reports `AXIdentifier = "AllClear"` when the
display is empty and `AXIdentifier = "Clear"` when it holds a value. An early suite run failed precisely
because it cached the identifier across a state change.

Consequence for the contract: **element identity must be re-resolved at action time, never cached across
states.** cua-driver enforces the same lesson from its side — its `get_window_state` documentation states
the index map "is replaced by the next snapshot", and its `click` refuses a bare `element_index`
(`refusal.code: "snapshot_id_required"`).

### 4.10 Verification that could NOT be run

* **`pnpm typecheck` / `pnpm lint` were not executed.** `node_modules` is **not installed** in this
  worktree and `pnpm install` was not performed, so `tsc`/`oxlint` are absent. This must be reported as
  *not run*, not as passing. Mitigating fact: this spike adds **no TypeScript at all** — only Swift
  (`spikes/cua-probe/*.swift`), shell, and Markdown, none of which those gates cover. Any CUA-1 work that
  touches `packages/**` must run them.
* **A live dual-instance isolation launch was not performed** (same blocker: no dependencies, so the dev
  desktop cannot boot). §15 therefore presents the isolation proof as *analytical + filesystem-verified*,
  not as a demonstrated concurrent run.
* `node scripts/check-workspace-freshness.mjs` **was** run (with `--no-fetch` to avoid mutating shared
  remote-tracking refs in a multi-worktree repository): baseline fresh, `ahead 36 / behind 0` vs
  `origin/main` at the default threshold of 50.

### 4.11 Follow-up: the background-pointer route, measured (2026-09-23)

§4.3 left exactly one architecture-changing question open: can cua-driver's window-scoped pointer route
deliver genuine background pointer input, on more than one application class? It was re-run as a bounded
experiment whose raw artefacts are archived in
`spikes/cua-probe/evidence/window-pointer-20260923-021940/` (with its own `README.md`), against a
purpose-instrumented target so that the target's state — not the driver's return code — is the readback.

**Setup.** macOS 27.0 (26A428) arm64; cua-driver 0.28.2, telemetry disabled
(`cua-driver telemetry status` → `disabled (source: persisted)`; archived in the run directory as
`33-permissions-and-identity.log`). Two materially different
classes: **Chromium-family desktop app** (Google Chrome 153, isolated `--user-data-dir`, app-mode,
`--force-renderer-accessibility`) and **Qt/QtWidgets** (Prism Launcher 11.1.0 — the only Qt app installed;
**no Flutter app exists on this machine**). Each action is bracketed by a listen-only `CGEventTap` plus the
five invariants of §4.3; a bracket that saw *any* physical event is discarded, because this machine had a
human user working in it throughout. **20 of the 32 trials were contaminated and discarded**; of the 12
tap-clean trials, 3 were refusals that never reached an actuator and 1 (the Qt foreground control) legitimately
changed the frontmost app — leaving **8 trials that were clean, reached an actuator, and preserved every
invariant**. Those are the ones the table leans on.

**Result: the pointer route works, and it is not the route you get.** The driver chose `accessibility` for
every single `click` with `x,y` on both classes — it hit-tests AX at the point and presses the element it
finds. The pointer route appeared only for `double_click`, `scroll` and the pixel form of `type_text`, where
it reported `route: "synthetic_events"`. Measured effects:

| Class | Action | Route | Independent readback | Bracket | Verdict |
|---|---|---|---|---|---|
| Chromium | AX press by token | `accessibility` | window title field `T1→T2` (the button counter) | clean | **BACKGROUND_CONFIRMED** |
| Chromium | pixel **double-click** | `synthetic_events` | button counter `+2` at the exact coordinate, **no pointer journey** | clean | **BACKGROUND_CONFIRMED** |
| Chromium | pixel double-click on a canvas absent from the AX tree | `synthetic_events` | canvas counter `+2` | clean | **BACKGROUND_CONFIRMED** |
| Chromium | pixel single click | `accessibility` | landed, but registered at `C185x335` where the requested point maps to `C185x311` — **not** the requested coordinate | clean | BACKGROUND_PARTIAL |
| Chromium | pixel wheel scroll (nested `overflow:auto`) | `synthetic_events` | scrollTop `240→480→628` | contaminated | effect real, unattributable |
| Chromium | pixel click + `type_text` | `synthetic_events` | 11 chars landed; a later retry: `delivered_chars: 0`, `effect: partial` | contaminated | **inconsistent** |
| Qt | AX press on `AXCheckBox` | `accessibility` | `AXValue 0→1` | clean | **BACKGROUND_CONFIRMED** |
| Qt | pixel single click | `accessibility` | `AXValue 1→0` | clean | BACKGROUND_PARTIAL (AX route) |
| Qt | pixel double-click on `AXCheckBox` | `synthetic_events` | `AXValue 0→0` | clean | UNVERIFIABLE (even toggles ≡ none) |
| Qt | pixel **double-click on the title bar** (not AX-actionable) | `synthetic_events` | **window frame `800×632 → 1470×874`**; frontmost unchanged, cursor bit-identical, window never raised | 149 events | effect real, **unattributable** |
| Qt | pixel `drag` | — | — | — | **refused: `background_unavailable`** |
| Chromium | same click, `delivery_mode: foreground` | **`global_input`** | page recorded a **real pointer journey**; tap saw the cursor move | control | the contrast that makes the above meaningful |

The foreground control is the load-bearing comparison: the *same* click that in background mode arrives with
no pointer journey and no global events, in foreground mode moves the real cursor (and the driver restores
it afterwards). The instrumented page's `-H` flag — "this click was preceded by a real pointer journey over
the clicked element" — is what separated the two, and it is not something a driver self-report could fake.

**Reliability and verification, which is where it fails.** Three of the four decision-relevant properties of
the pointer route are weaknesses, not strengths:

1. **The common action does not use it.** Every single `click` fell back to AX. The pointer route only serves
   `double_click`, `scroll`, and pixel-form `type_text`.
2. **It cannot be verified.** Every pointer action returned `effect: "unverifiable"` — with the single
   exception of the failed `type_text` retry, which returned `effect: "partial"` with `delivered_chars: 0`.
   The driver never claims a confirmed pointer effect, and *all* confirmations above came from the
   independently instrumented target. Our own helper can only trust it by doing the same work — i.e. by not needing it.
3. **It is not reliable across repeats.** Text entry delivered 11 characters once and 0 the next attempt
   (`effect: partial`); `drag` is refused outright in background; a window that was minimized was refused as
   `minimized_or_hidden_window`; and on the Qt target the driver refused the keyboard route entirely
   (`pid_keyboard: refused — same_pid_keyboard_ambiguity`).
4. **In every tap-clean *background* trial the invariants held** — that part is genuinely good. Frontmost,
   cursor and z-order were unchanged in each, and the target windows sat 14–62 windows deep (measured per
   window: 20–23 for the Chromium button target, 58–62 for the canvas target, 14–23 for the Qt window) while
   still receiving clicks. The one tap-clean trial that *did* change the frontmost app is the Qt foreground
   control `P-FG1`, which is exactly what a foreground control should do; it is therefore excluded from both
   result tables and the blanket claim is scoped to background trials.

**Private API: yes, and it is the *only* reason any of this worked.** Read from the open-source upstream
(`libs/cua-driver/rust/crates/platform-macos/src/input/`), not inferred from the binary. **Caveat: the
upstream files were read from `main`; no `v0.28.2` tag resolves on raw.githubusercontent.com, so the line
numbers and file sizes below are `main`'s, and the *behaviour* claims were independently reproduced against
the installed 0.28.2 binary (symbol probe, route strings, measured effects) rather than assumed to match:**

* `skylight.rs` — "SkyLight SPI bridge — Rust port of Swift's `SkyLightEventPost`". It `dlopen`s
  `/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight` and resolves every symbol lazily with
  `dlsym` (cached in `OnceLock`). SPI = private.
* `mouse.rs` — "Background mouse event synthesis via `SLEventPostToPid` (SkyLight SPI), with fallback to the
  public `CGEvent::post_to_pid`". Its header states that `SLEventPostToPid` goes through the
  `IOHIDPostEvent` path which *"Triggers CGSTickleActivityMonitor (required for Catalyst / Chromium)"* and
  *"Reaches Mac Catalyst windows that CGEventPostToPid misses"*. The sentence that explains the earlier
  spike's negative result verbatim — **"the public `CGEventPostToPid` skips the activity-monitor tickle so
  Chromium/Catalyst targets don't accept those events as live input"** — is in `skylight.rs`'s module doc
  (lines 6–8), not in `mouse.rs`. That is exactly §4.3 C4 / §4.5 D3, now explained rather than merely
  observed.
* Keyboard additionally attaches a private `SLSEventAuthenticationMessage` via
  `SLEventSetAuthenticationMessage`; activation uses `SLPSPostEventRecordTo` / `SLPSSetFrontProcessWithOptions`.

| Private-API question | Measured answer |
|---|---|
| Exact route | `SLEventPostToPid` (+ `SLSEventSetAuthenticationMessage` for keyboard; `SLPSPostEventRecordTo` for activation) — private SkyLight |
| Symbols available on macOS 27? | **Yes.** `spikes/cua-probe/skyprobe.c` `dlopen`+`dlsym`s all 15 symbols the driver uses; all resolve except the legacy `GetProcessForPID`, which the source uses only as an older-system fallback |
| Behaviour when unavailable | `post_to_pid` returns `false` and the caller falls back to the public `CGEventPostToPid`. No unwrap, no panic — a graceful, silent capability downgrade |
| Crash / failure mode | None observed; the failure mode is *degradation to a route that does not work on Chromium* — i.e. silent loss of function, not a crash |
| Fallback behaviour | Public `CGEventPostToPid`, which §4.3/§4.5 already measured as ineffective on this class |
| App Store / notarization | The shipped binary is Developer ID signed, hardened-runtime and **notarized with a stapled ticket**, so notarization tolerates it. **App Store review would not**: private-framework use is an automatic rejection. Any product shipping this cannot also ship via the Mac App Store |
| OS-update fragility | Real and already visible: the source guards the macOS-14-vs-15 `SLSEventAuthenticationMessage` selector with `class_respondsToSelector` ("See #1503"), and one symbol is already gone on macOS 27. Each OS release is a re-verification, not a formality |
| Capability-detect instead of assuming? | **Yes, cheaply** — every symbol is already resolved that way, and `is_available()` exists. Detection is not the problem; it is that a *silent* downgrade is unobservable to the caller |

**Decision (by the rule §18 originally set and which this section discharges): DO NOT DEPEND ON CUA-DRIVER FOR POINTER CONTROL.** The rule requires background
pointer control to be demonstrated on both classes *with all invariants preserved and acceptable
reliability*. The Chromium class passes cleanly. The Qt class does not: its one effective pointer-route
attempt could not be made attributable, its binary-toggle target could not disambiguate at all, `drag` is
unavailable in background, and the keyboard route is refused on that target. Independently of the class
question, the rule also fails on "too fragile / private-API dependent" and on "cannot be verified
reliably" — the working route is private SkyLight SPI, and the driver marks its own pointer effects
`unverifiable`. This is not a softened result: it is the one the criteria actually produce.

**What this does not say.** It does not say the route is broken. It demonstrably works on Chromium — cleanly,
coordinate-accurately, on a heavily occluded window — and it produced a real background frame change on Qt.
It is the only mechanism measured on this Mac that produced genuine background pointer effects at all, and
its core is a `dlsym`-gated symbol table (roughly 130 lines in `skylight.rs`, against ~950 lines for the
whole file and ~1 860 for `mouse.rs`). If a future phase wants background pointer
input badly enough to own a private-API backend, the *technique* is proven and reimplementable in our own
helper (which we control, and which can capability-detect the same way). That is a CUA-3+ decision with an
App-Store cost attached, not a reason to adopt cua-driver now.



### 4.12 CUA-0.5 — the permission/identity foundation, measured (2026-09-23)

CUA-0.5 built a real development Helper from this repository and settled the permission question §4.4 left
open. The spec it produces is `packages/zcode-cua/specs/computer-use.md`; the harness is
`packages/zcode-cua/native/cua-helper/`, and the run is archived under
`spikes/cua-05-identity/evidence/`.

> **Product rename note.** The fork and the product are now named **AceVra**. This branch introduces no
> new permanent ZCode-branded production identity; it records the reserved targets (`AceVra` / `AceVra Dev`
> apps, helpers `dev.acevra.cua-helper` / `dev.acevra.cua-helper.development`) for integration to wire up.
> `zcode://` stays untouched because it remains an OAuth compatibility requirement. The measurements below
> were taken under the fork's current in-contract development id (`dev.zcode.cua-helper.dev`) and are kept
> under it deliberately: a bundle id is part of the TCC requirement, so renaming it creates a new identity
> and would have silently invalidated the archived proof.

**The grant subject is the Helper, not the app.** Two launch paths, same bundle, same binary:

| Launch path | `parentPid` | Accessibility | Screen Recording |
|---|---|---|---|
| `exec` child of the app's process tree (the inheritance path) | the app | `true` | capture OK |
| `/usr/bin/open` via LaunchServices (the path `buildHelperOpenArgs` actually uses) | **1** | **`false`** | refused: "The user declined TCCs" |

With and without `--launcher-pid` the LaunchServices result is the same, so **`ZCODE_CUA_LAUNCHER_PID` is
not a permission mechanism**; it exists so the Helper can verify the caller's code signature. The
`exec` path's inheritance is real but irrelevant, because the contract never uses it. A second, identically
signed control bundle stayed untrusted at the same path, and an `exec` run with
`AXIsProcessTrustedWithOptions(prompt: true)` did **not** create a grant for a fresh bundle id — so the
trusted state cannot appear without a user decision.

**Grants survive rebuild, reinstall and version changes — because they key on the requirement, not the
cdhash.** Under one stable signing identity the cdhash changed five times (rebuild, delete-and-reinstall,
version/build bump, and two code changes) while Accessibility and Screen Recording both stayed granted, with
no re-authorization. Re-signing the same bundle id and path with a *different* certificate lost both grants;
restoring the original identity brought both back **with no new user action**, which is the evidence that
the stored decision had persisted through the mismatch. That pair of rows is also what makes `stale` a real,
measurable OS condition rather than a guess — it is indistinguishable from `denied` at the preflight API,
so the permission owner must compute it from remembered prior-grant state.

**No restart is required to use a new grant; the preflight API is the thing that goes stale.** A running
Helper was granted both permissions mid-flight: real capture started working at +7 s, and `AXIsProcessTrusted`
flipped by +37 s, with no new process. Meanwhile `CGPreflightScreenCaptureAccess()` stayed `false` in that
same process while capture worked, and only reported `true` in a fresh process. Consequence for the UI: judge
Screen Recording by the functional capture probe, never by preflight, and treat a poll timeout as
"still propagating", not as failure. (Note also that the in-repo comment asserting a running Helper must be
restarted to observe an Accessibility grant is not what this run measured.)

**Security, measured.** The Helper cannot be trivially replaced by another program: a different
certificate and identically signed control bundles all fail to inherit the grant, and a never-granted
control bundle stays denied with *and* without `--launcher-pid`. But a trusted grant is *not* a
whole-binary integrity guarantee: with archived commands (`final/tamper.log`, five distinct pids), changing
one byte in `__text`, changing one byte in `__cstring`, and appending bytes past the signed code limit each
made `codesign --verify` fail while the bundle still launched and still held **both** grants — `tccd`
validates the requirement against the embedded signature blob, not the code windows. Integrity therefore has
to be checked explicitly with `SecCodeCheckValidity`. And because LaunchServices detaches the Helper,
`getppid()` is `1`, so **the parent relationship cannot authenticate anything**: `--launcher-pid` must be
resolved to a code signature and validated against the expected requirement.


---

## 5. RECOMMENDED ENGINE

**Build a first-party macOS helper (Swift) behind the fork's existing `@zcode/zcode-cua` broker contract,
and treat cua-driver as an optional pluggable backend rather than as the product's identity.**

The reasoning is architectural, not NIH:

1. **The permission identity is the product decision — and CUA-0.5 measured what it actually is.**
   `ZCODE_CUA_LAUNCHER_PID` + `grantOwner` do exist, but inheritance is **not** what the shipping launch
   path gives you: the contract launches the Helper through LaunchServices (`/usr/bin/open`), where the
   Helper is its own responsible process and inherits nothing from the app, while `--launcher-pid` confers
   no permission at all. Inheritance only happens if the Helper is an `exec` child inside the app's process
   tree, which is not how it is launched. So the signed Helper owns its own TCC surface and its own
   permission onboarding — the same shape the argument above was using to reject cua-driver. This
   correction is measured, not inferred: see §4.12.
   *(CUA-0's §4.4 measurement was correct; only this interpretation of it was wrong.)*
2. **We already reach parity on the background capabilities that are measurable.** Background per-window
   capture, background AX actions, and background keyboard entry were all demonstrated with public APIs
   only (§4.3). The engine's main added value would be the window-scoped **pointer** route, which rests on
   private SkyLight SPIs — see risk R-1.
3. **Dependency risk is real and asymmetric.** cua-driver self-describes as experimental
   (`contract: "experimental": true`, package classified "Development Status :: 4 - Beta"), sits at
   0.28.x with ~1,044 open issues/PRs, ships daily nightlies, and its macOS E2E validation runs only on a
   maintainer-owned Lume VM, not in CI. We would own our own QA regardless.
4. **But do borrow its ideas, which are excellent.** Adopt: the two-rung ladder (element ⇒ AX rung,
   coordinate ⇒ pixel rung) chosen at action time; `delivery.mode: background|foreground` with explicit
   refusal; `effect: confirmed|partial|unverifiable|refused` with the rule that a missing readback is
   `unverifiable`, never `confirmed`; snapshot-scoped element indices; `--permission-mode
   standard|bounded|unrestricted` with a human-reviewed `--capability-manifest`; and per-window route
   availability reporting.

**If the CUA-1 evaluation finds a Flutter/Electron/Qt target class where our AX+keyboard path cannot reach
and cua-driver's `window_pointer` can, the recommendation should flip to embedding it as the
foreground/pointer backend while keeping our contract.** That evaluation is §18.

---

## 6. INTEGRATION ARCHITECTURE

```
                    ZCode Agent (any provider / execution backend)
                                    │
                      ToolRegistry → MCP project, canonical
                      names: mcp__computer-use__*  (alias mcp__computer_use__*)
                      permissionCapabilityGroup: "official_cua"
                                    │
                        node_repl CUA bridge  (existing)
              Symbol.for("zcode.node-repl.computer-use-bridge")
              token-authenticated unix-socket broker, 32 MiB cap
                                    │
                        <bounded context>  packages/zcode-cua
                                    │
                    ┌───────────────┴────────────────┐
                    │                                │
        MacHelperBackend (primary)          CuaDriverBackend (optional)
        Swift helper, ZCode owns TCC        cua-driver sidecar,
        launched via LaunchServices         owns its own TCC identity
        with ZCODE_CUA_LAUNCHER_PID
                    │                                │
        ┌───────────┼───────────┐                    │
        │           │           │                    │
   AX rung    pid keyboard  screenshot/SCK     window_pointer (private SPI)
   (background-safe)        (background-safe)  (BACKGROUND_BEST_EFFORT)
```

Both backends implement one interface. The model-facing surface is the MCP projection that already exists;
the model never learns which backend is behind it.

**Where each piece lives (following existing repo boundaries):**

* Native helper sources + build: `packages/zcode-cua/native/macos/` (new), built by a `swiftc` + `lipo`
  script modelled on `packages/desktop/scripts/build-macos-window-bounds.mjs`, which already proves this
  pattern works with **Command Line Tools only, no Xcode**.
* Broker/installer/verifier: fill in the existing `packages/zcode-cua/*.js` stubs — do not add a parallel
  package.
* Real implementation behind the runtime: `packages/services/src/cua-permission-broker/` already holds the
  two-phase spawn/health state machine (`windowsCuaDevHelperHost.ts`, 506 lines) to mirror.
* Artifact registration: `packages/services/src/task-artifacts/app/` (§13).
* Protocol additions, if any: `packages/shared/src/zcode-protocol-v4/` and, for the legacy surface,
  `packages/shared/src/zcode-protocol/index.ts:3565-3696`.

---

## 7. MODEL-FACING CONTRACT

Reuse what the repo already projects rather than inventing names. The existing UI renderers already cover
these 26 action names (`packages/ui/.../cuaSummaryMessages.ts:1-27`):
`request_access, list_apps, get_app_state, screenshot, zoom, left_click, double_click, triple_click,
right_click, middle_click, scroll, left_click_drag, mouse_move, type, set_value, select_text, key,
hold_key, perform_action, wait, read_clipboard, write_clipboard, stop_computer_control, …`

Proposed normalized capability layer (internal, backend-independent — not necessarily the MCP tool names):

| Capability | Rung | Expected class |
|---|---|---|
| `list_apps()` / `list_windows()` | observation | BACKGROUND_SAFE |
| `observe(window)` — screenshot + AX tree | observation | BACKGROUND_SAFE |
| `ax_press(element)` / `ax_set_value(element, v)` | AX | BACKGROUND_SAFE (verify post-state) |
| `type_text(pid, text)` | AX `kAXSelectedText` or PID keyboard | BACKGROUND_SAFE (measured) |
| `hotkey(pid, combo)` | PID/global | BACKGROUND_BEST_EFFORT |
| `click(pid, element\|point)` | pointer | BACKGROUND_BEST_EFFORT → REQUIRES_FOREGROUND |
| `drag`, `scroll` | pointer | BACKGROUND_BEST_EFFORT |
| `launch_app`, `activate_window` | workspace | REQUIRES_FOREGROUND (activation is the point) |
| `clipboard_*`, `invoke_menu`, `kill_app` | privileged | REQUIRES_FOREGROUND + approval |

Every result must carry, per action: `route`, `delivery.mode`, `effect`
(`confirmed | partial | unverifiable | refused`), and `evidence[]` (`value_readback`, `window_change`).
A call that reached an actuator without a trusted readback is **`unverifiable`**, never `confirmed`.
This is the "escalation reported honestly" requirement, and it is the single most important contract rule
this spike produced.

Two preconditions the contract must enforce **before** dispatching an AX action, both derived from measured
failures rather than from documentation:

* **Re-resolve the element at action time.** Identifiers and indices are state-dependent (§4.9). A cached
  identifier is a bug, not an optimisation. cua-driver reaches the same conclusion from the other side by
  refusing a bare `element_index` without a `snapshot_id`.
* **Check `AXEnabled` and require a post-state read-back.** A disabled element can silently no-op; and
  because the return code carries no information about the effect (§4.2), the only trustworthy success
  signal is the resulting state. An action with no read-back is `unverifiable`.

---

## 8. MACOS NATIVE / PERMISSION ARCHITECTURE

### 8.1 What each operation requires

| Operation | Permission | Notes |
|---|---|---|
| App enumeration, window enumeration | **none** | Observed working while the probe was *untrusted*, so this holds in both states. The in-repo comment (`native/macos-window-bounds/main.swift:3-6`) is corroboration, not the measurement |
| AX tree read, AX actions | **Accessibility** | Probe-verify, never trust the return code |
| Per-window / display capture (SCK) | **Screen Recording** | **Granting requires an app relaunch** — this is Apple's documented behaviour, not something this spike measured (no archived run captures the pre/post-relaunch transition) |
| Listen-only global event tap | **Accessibility** (Input Monitoring also grants it) | Measured working *with* the grant. The negative case (tap denied without any grant) was **not** exercised |
| PID-routed events (`CGEventPostToPid`) | Accessibility in practice (Apple documents no semantics) | The positive case is measured (C3). The negative — that these fail without the grant — was **not** exercised |

### 8.2 Identity design

* **Grant owner = the ZCode app** (`dev.zcode.app`), not the helper. Measured working via inheritance.
* Helper bundle id: reuse the existing constants — `dev.zcode.cua-helper` (`HELPER_BUNDLE_ID`) with dev
  variant `dev.zcode.cua-helper.dev`; display name `ZCode Computer Use.app`.
* Helper launched **via LaunchServices** (`buildHelperOpenArgs(spec, launcherPid)` →
  `ZCODE_CUA_LAUNCHER_PID`) so responsibility resolves to `dev.zcode.app`.
* **Signing is not cosmetic.** This machine has **0 valid code-signing identities**
  (`security find-identity -v -p codesigning`). The probe had to be ad-hoc signed, and an ad-hoc
  signature's designated requirement *is its cdhash*, which changes on every rebuild — so every rebuild
  invalidates the grant and re-prompts. Production needs a **Developer ID** (and a stable self-signed
  identity for dev builds), plus a **stable install path**, or every update will strand the user's grant.
  The existing `ZCODE_CUA_HELPER_BUILD_ID` / install-variant roots (`~/.zcode/computer-use/dev|preview`)
  are already shaped for this.
* `CuaPermissionStatus` must be produced by **probes**, and must be able to say `"stale"` — a recorded
  grant whose subject no longer matches (exactly the ad-hoc rebuild failure mode we hit) is the normal
  case, not an edge case.

### 8.3 Toolchain hazard found on this machine

`swiftc`'s default target here is `arm64-apple-macosx28.0` while the OS reports 27.0 and the SDK is 26.2.
Without an explicit `-target arm64-apple-macos14.0`, the linked binary records `minos 28.0`, and
LaunchServices then refuses to open the bundle with `kLSIncompatibleSystemVersionErr (-10825)`. The helper
build must always set an explicit deployment target. (This is also why the spike pinned a macOS 14 floor.)

---

## 9. BACKGROUND ACTION SEMANTICS

Measured classification for Calculator/AppKit-class targets on macOS 27. This is a *measured* table, not a
capability wish-list.

| Primitive | Class | Evidence |
|---|---|---|
| Screenshot a specific window, not raised, not frontmost | **BACKGROUND_SAFE** | C1: 93–123 ms, frontmost/cursor/top window unchanged |
| AX tree read of a non-frontmost app | **BACKGROUND_SAFE** | A3: 249 nodes, 150–170 ms |
| `AXUIElementPerformAction` (press) | **BACKGROUND_SAFE** | C2: `2 + 3 = 5`, invariants unchanged |
| `AXUIElementSetAttributeValue` (set value) | **not measured here** — expected `BACKGROUND_SAFE` | The probe implements `ax-set-value` but **no archived run exercises it**. Do not treat as demonstrated |
| `AXUIElement` on a **disabled** element (`AXEnabled == false`) | **UNSUPPORTED** — silently no-ops | Not tested here; this is the specific upstream hazard (trycua/cua#2619). Verify `AXEnabled` before acting |
| `CGEventPostToPid` Unicode keyboard text | **BACKGROUND_SAFE** | C3: typed `81` into a non-frontmost app |
| `CGEventPostToPid` mouse down/up | **UNSUPPORTED** (public API path) | C4 (background) and D3 (frontmost): no effect in either state |
| Window-scoped pointer via private SkyLight SPI | **BACKGROUND_BEST_EFFORT** | Not proven here; cua-driver self-reports `window_pointer: available` |
| Global `CGEventPost` pointer click | **REQUIRES_FOREGROUND** | D1: moves the physical cursor to the click point |
| Global keyboard / hotkeys | **REQUIRES_FOREGROUND** | D2: lands in the frontmost app |
| App activation | **REQUIRES_FOREGROUND** | D1: by definition |

Two implementation rules the measurements force:

* **A global click must warp the cursor first.** Posting a mouse event whose location points at the target
  does not move the pointer, and the click is routed by the actual pointer position — so without a warp the
  click lands wherever the cursor happened to be. Measured the hard way (§4.5).
* **Post-activation settle time matters.** Typing immediately after activating a window can lose the first
  keystroke; the suite now activates, waits, clears, then types, and asserts the exact string.

Honest restatement of the brief's demand: window capture, AX actions, and keyboard entry **genuinely work**
in the background. Background **pointer** control is the one capability that is *not* available through
public APIs; it is available only via private SPI and only best-effort, and it must therefore be reported
as such rather than promised.

---

## 10. USER INTERRUPTION MODEL

Mechanism (proven in §4.6):

1. A listen-only `CGEventTap` at `.cghidEventTap` watching mouse-down/up, key-down/up,
   `flagsChanged`, `mouseMoved`, drag and scroll.
2. Every synthetic event we post carries `CGEventSource(stateID: .privateState)` with
   `userData = <our tag>`. The tap classifies each event by `kCGEventSourceUserData`. Apple's own guidance
   is that remote-control tools should use a private source state, which is what makes this work.
3. PID-routed events never reach the global chain (measured: 0 events in E2), so the tap sees essentially
   only real user input plus our own global injections.
4. Re-enable the tap on `.tapDisabledByTimeout` / `.tapDisabledByUserInput`. A monitor that silently dies
   is worse than no monitor — this was added after the tap went flaky between runs.

Modes: `BACKGROUND` (agent works beside the user), `EXCLUSIVE` (agent may take foreground),
`ISOLATED` (private desktop). On a detected physical input during `EXCLUSIVE`: **pause immediately**,
surface "You took control", and require explicit resume. Do **not** attempt to lock the user out.

Honest limits: userland cannot build an unforgeable "is this physical?" test, because another process can
also create HID-state sources; source-state plus our own user-data tag is the strongest available signal.
A tap placed at the HID location does not see PID-routed injections at all, which cuts both ways — it is
why interruption detection is tractable, and why our own background actions are invisible to it.

---

## 11. ISOLATED DESKTOP ROADMAP (Lume assessment)

Not implemented in this phase. Findings:

* **Lume** lives inside the same repository as `libs/lume`, is a **Swift 6** package targeting
  `.macOS(.v14)`, and uses Apple's **Virtualization.framework** (not QEMU-in-userspace).
* Runs macOS guests on Apple Silicon; documented requirements ~8 GB free memory and ~50 GB free disk.
* Headless operation is supported (`lume run --no-display` / `--display none`, `--detach`, plus `--vnc`).
* External control surface: `lume serve` binds an HTTP API to **`127.0.0.1:7777`**, plus a Swift MCP
  server, VNC and SSH.
* **Snapshot support was not found.** There is cloning (`commands/Clone.swift`) and registry
  push/pull/`Prune`; treat "clone an image" as the snapshot story.
* License: repo-level MIT; **`libs/lume` carries no per-package LICENSE file**, so the package-level
  position is implicit.
* **Apple EULA: unresolved and requiring legal review.** The commonly cited clause (on Apple-branded
  hardware you own or control, for development/testing/IT support) could not be verified from primary
  sources during research — Apple's agreement is a PDF that could not be read, and Lume's own
  documentation never addresses licensing. **Do not ship VM-hosted macOS without legal sign-off.**

How a driver would connect: the guest is a full macOS, so the same helper architecture applies *inside* the
guest; the host-side connection would be over the guest's SSH/VNC or a small in-guest agent — not by
reusing the host helper. That makes it a **separate worker**, not an in-process backend, which is the right
boundary anyway: it gives isolation of crash, permission and state.

Cloud workers are a distinct axis: a `/fork`-style outbound relay to a remote desktop, sharing the same
model-facing contract but a different backend implementation.

---

## 12. SECURITY MODEL

Boundaries to define and enforce (not implemented in this phase):

* **Destructive and system-level actions are reachable through the AX tree.** This was observed directly:
  Calculator's own AX tree exposes menu items for **Shut Down, Restart, Log Out, Lock Screen, Force Quit**.
  Any agent with Accessibility permission can reach those. They must be classified and gated, not merely
  allowed.
* **Capability narrowing.** Adopt cua-driver's strongest idea: a `--permission-mode` of
  `bounded` requiring a **human-reviewed capability manifest** that a trusted launcher asserts was
  reviewed at startup. Narrow-only: a session cannot widen its own grants.
* **Clipboard is exfiltration surface.** Reading/writing the clipboard must be a distinct, approved
  capability, never a silent side effect of another action.
* **Sensitive surfaces.** Password fields, payments, System Settings, app installation and shell
  escalation must be deny-by-default with explicit approval.
* **Approval integration.** Route through the existing permission pipeline:
  `PermissionService` (`core/src/permission/service.ts`) already special-cases the
  `zcode:permission-capability:official_cua` rule key and `permissionCapabilityGroup === "official_cua"`
  (`service.ts:269-281`). Use `needsApproval`/`alwaysAsk` with `sideEffectScope: "system"` — do not build a
  parallel approval path.
* **Privacy at the frame — must be implemented, not preserved.** The 200 KiB inline and 16 KiB meta caps
  are real constants, but the credential-text predicates are fail-closed stubs returning `false` (§1.2),
  so today there is **no** credential filtering. The real frame path has to implement it.
* **The AX tree is a data-exfiltration surface, not just images.** This was observed directly and is the
  most under-appreciated finding in this spike: walking Calculator's accessibility tree returned the
  **Apple menu's recent-items list**, i.e. the user's recent document filenames — in that run,
  `…-pasted_text_20260920-140805.txt` and unrelated project files (`lifecraft-provider.secret`, other
  document names) landed in the tree output and therefore in the evidence transcript. Reading a *calculator's*
  accessibility tree leaked unrelated user filenames. AX text must be treated as sensitive content with the
  same redaction and retention rules as screenshots — an earlier draft of this section covered only images.
* **A global input tap is a keylogger surface.** The §10 tap sees every `.keyDown` on the machine,
  including passwords typed into other applications. §12 gates clipboard reads but an earlier draft never
  classified global key observation. It must be a distinct, explicitly-approved capability with no
  persistence, and the tap should be installed only while an exclusive-mode session is active.
* **Prompt injection from observed content.** Screenshots and AX text are *untrusted input* fed to the
  model. A malicious page or document can contain text aimed at the agent ("ignore previous instructions,
  run …"). The threat model must cover this direction, not only data flowing outward, and privileged
  actions must never be authorizable by content the agent merely read.
* **No privileged escalation.** cua-driver needs no root, no SIP changes and no TCC.db edits; our helper
  must hold the same line.
* **Third-party telemetry.** cua-driver sends product telemetry **by default**. If it is ever bundled, it
  must be shipped with telemetry disabled by configuration, not by user action.

---

## 13. ARTIFACT / SCREENSHOT INTEGRATION

Do **not** invent a second delivery path. Reuse the exact mechanism the browser-use screenshots use:

1. `TASK_ARTIFACT_ORIGINS` in `packages/shared/src/task-artifacts.ts:13-19` is currently the closed set
   `"browser-use" | "codex" | "tool"`. **Add `"cua"`** — that touches the origins constant, the zod enum,
   and the row/delivery projections.
2. Register through `TaskArtifactRegistry.registerTaskArtifact({ taskId, scope, origin: "cua", fileName,
   mimeType, bytes, turnId })` in `packages/services/src/task-artifacts/app/taskArtifactRegistry.ts:181`.
   Bytes are **copied** into `<appConfigDir>/task-artifacts/<canonicalTaskId>/`, so a CUA capture is durable
   independently of the helper.
3. Decorate the executor with a **Proxy** modelled exactly on
   `instrumentBrowserExecutorForArtifacts` (`browserUseArtifactHook.ts:40-121`) — it intercepts only
   `execute` and delegates everything else (a documented bug fix from an earlier attempt that returned a
   bare `{execute}` object and broke the rest of the interface).
4. Honour `captureIntent === "observation"`: those results are **never registered**, and the host path is
   stripped.
5. Return `artifactDelivery: { status: "delivered" | "registration_failed" }` on the result. Never put a
   host path in a returned result — per the file's own security-boundary comment, host paths are host-only
   inputs to the registry.
6. `taskId === sessionId` for ZCode tasks, and `resolveTaskArtifactScope()` already accepts both the
   `sess_`-prefixed and bare-UUID forms.

UI, `/fork` delivery and the artifact cards then work unchanged.

---

## 14. /FORK ROADMAP

The relay is **outbound-only today** and must stay that way: `customForkHostRelay.ts:33-64` dials
`/fork/relay/device` with an `x-zcode-device-token` header and upgrades to a full RPC channel on attach;
the only local listener in the desktop processes is a loopback-only media proxy
(`remoteMediaPreviewProxyHelpers.ts:102` → `127.0.0.1:0`). The relay server itself keeps **no** session or
snapshot state.

A live CUA preview therefore needs no new transport:

* Session state, pause/stop/approve: reuse the existing attached **service channel**
  (`CuaPermission`, `CuaPipSession`, `TaskArtifacts` are already in `shared/src/channels.ts:56-164`).
* Near-live preview frames: reuse the v4 conversation frame path with snapshot-on-subscribe, or the
  existing **`PipSessionEvent`** union, which is purpose-built for exactly this presentation.
* Screenshots: the artifact pipeline of §13 already reaches the phone.
* Take-over: an approval interaction over the existing `resolveInteraction` command.

Caveat to verify in CUA-6: PiP events are currently wired only to local services; whether they are
forwarded across the relay is **unverified**.

---

## 15. IMPLEMENTATION PHASES

Adjusted from the brief's sketch where repo evidence demands it. The biggest change: the permission
identity work is pulled forward, because it gates every capability and is the most common source of
user-visible breakage (measured: ad-hoc rebuild invalidates the grant).

| Phase | Scope | Exit criteria |
|---|---|---|
| **CUA-0** | This spike: architecture, deterministic driver, evidence | Done. 15/15 assertions; this document reviewed |
| **CUA-0.5** *(new)* | **Permission identity + install path.** Developer ID for release, stable dev identity, stable install root, `grantOwner`/`stale` probe semantics, relaunch-after-Screen-Recording flow | A helper keeps its Accessibility + Screen Recording grants across a rebuild and an app update |
| **CUA-1** | Native helper behind the **existing** broker contract: `permissions`, `list_apps`, `list_windows`, `observe` (SCK capture + AX tree). Observe-only | Real `createComputerUseRuntime` replaces the fail-closed stub for observe-only tools; graceful degradation when a grant is missing |
| **CUA-2** | Safe semantic interaction: AX action + value set with mandatory post-state verification, PID keyboard, `set_value`, background classification keys | Every action returns `route` / `delivery.mode` / `effect`; `unverifiable` is never reported as success |
| **CUA-3** | Foreground/exclusive control: pointer with cursor warp, drag, scroll, menus, focus; user-interruption monitor with auto-pause | Foreground signature (cursor moved) is reported honestly; interruption pauses the agent |
| **CUA-4** | Normalized agent tool interface across execution backends; backend selection; capability-manifest gating | No provider-specific naming; bounded mode refuses out-of-manifest tools |
| **CUA-5** | ZCode UI: live preview, pause/stop, mode selector, permission status. Un-hide `ComputerUseSection` and remove `"computerUse"` from `HIDDEN_SETTINGS_SECTIONS` (`packages/ui/src/lib/settingsNavigation.ts:37-50`) | Feature reachable end to end on macOS desktop |
| **CUA-6** | `/fork` remote observation/control over the outbound relay | Preview + pause/stop from a phone; no inbound port |
| **CUA-7** | Isolated desktop / Lume, subject to legal review of Apple's EULA | — |

---

## 16. RISKS / UNKNOWNS

| ID | Risk | Severity | Notes / mitigation |
|---|---|---|---|
| R-1 | **Window-scoped background pointer input depends on private SkyLight SPIs**, partially removed in macOS 26; we are on macOS 27 | **Highest** | Public `CGEventPostToPid` pointer input measured *not working* (§4.3 C4). Mitigation: treat pointer background as best-effort and always provide a foreground escalation; evaluate cua-driver's `window_pointer` route (§18) |
| R-2 | AX actions can silently no-op while returning success | High | Measured locally and upstream (#2619). Mitigation: mandatory post-state verification; `unverifiable` ≠ success |
| R-3 | Element identity is state-dependent | High | Measured (`AllClear`/`Clear`). Mitigation: re-resolve at action time; snapshot-scoped indices |
| R-4 | TCC grants break on rebuild/update without a stable signing identity | High | This machine has **0** signing identities; ad-hoc = cdhash-keyed. Mitigation: CUA-0.5 |
| R-5 | Screen Recording grant requires an app **relaunch** | Medium | Documented by Apple; must be in the onboarding UX and the `stale` state |
| R-6 | AX tree cost on large apps | Medium | cua-driver documents up to 20 s on 10k+ element trees; we measured 150 ms on 249 nodes. Mitigation: bound depth/elements, use query projection |
| R-7 | Third-party dependency churn if cua-driver is embedded | Medium | 0.28.x, `experimental: true`, ~1,044 open issues, maintainer-only macOS E2E |
| R-8 | Third-party telemetry | Medium | cua-driver sends telemetry by default; ship disabled if ever bundled |
| R-9 | Other automation agents may run on the user's machine | Medium | `com.zhipuai.autoclaw` was running during this spike and its own cursor activity appears in measurements. Any e2e harness must snapshot immediately around each action |
| R-10 | Environment: dependencies not installed; CLT-only Swift; SDK/OS version skew | Medium | `pnpm typecheck`/`lint` could not run; helper build needs an explicit `-target`; a full Xcode install may be required for anything beyond `swiftc` |
| R-11 | Apple EULA for VM-hosted macOS | Unknown | Requires legal review (§11) |
| R-12 | Unverified: PiP events across the relay | Low | Confirm in CUA-6 |

---

## 17. OPEN-SOURCE LICENSE OBLIGATIONS

| Component | License | Obligation if adopted |
|---|---|---|
| trycua/cua core (`cua-driver` Rust crates, npm, PyPI) | **MIT** (repo `LICENSE.md`, copyright Cua AI, Inc.; npm `@trycua/cua-driver@0.28.2` licence field also MIT) | Retain copyright + permission notice. Shippable in a closed-source commercial product. **Note: the macOS release tarball ships no LICENSE/NOTICE file** (`find … -iname '*license*'` is empty), so the MIT text must be sourced from the repository and a copy must be shipped — §15 currently assigns this to nobody, so add it to whichever phase bundles the dependency |
| `cua-som` | **AGPL-3.0-or-later** (`libs/python/som/pyproject.toml`; classifier "AGPLv3+") | **Do not bundle.** Source-disclosure obligations. Note this is *or-later*, a different SPDX obligation from *only* |
| `cua-perception` OmniParser detector artifact | **AGPL-3.0-only** (per the driver's own `perception-third-party-notices.md`) | **Do not bundle.** Absent from the default MIT driver build |
| PP-OCR artifacts | Apache-2.0 | Attribution, if ever used |
| ONNX Runtime (pulled by the perception extension) | **MIT** | Attribution; omitted from an earlier draft of this table |
| `libs/lume` | MIT by repository license; **no per-package LICENSE file** and nothing in its README | Confirm with counsel before shipping |
| hyprcat/mac-cua | **Apache-2.0** | Permissive; NOTICE/attribution if code is copied. Early-stage; prefer reimplementation |
| openclaw/Peekaboo | MIT | Retain notice |
| `antimatter15/macos-background-cua-skill` | **No license** | **Cannot be used or copied** |
| cliclick | BSD-3 | Attribution if copied |

**Result: no licensing blocker to the recommended architecture.** The recommended path (our own Swift
helper behind our own contract) carries **no** new third-party license obligation at all; borrowing
*design ideas* from MIT/Apache projects creates no obligation, though attribution is good practice. The
only genuine traps are `cua-som`/`cua-perception` (AGPL) and the unlicensed reference repo.

**Not a licence problem, but a distribution one (§4.11):** the route that makes cua-driver's background
pointer input work is the private **SkyLight SPI** (`SLEventPostToPid`, `SLSEventAuthenticationMessage`,
`SLPSPostEventRecordTo`), `dlopen`ed from `/System/Library/PrivateFrameworks/`. Developer-ID notarization
tolerates it — the shipped binary is notarized with a stapled ticket — but **Mac App Store review would not**.
If a future phase reimplements the technique in our own helper, the same App-Store cost applies and must be
a deliberate product decision, not an incidental dependency.

---

## 18. EXACT NEXT IMPLEMENTATION STEP

The pointer-backend question §18 previously deferred was **settled by measurement in §4.11**: do not depend
on cua-driver for pointer control. The pointer route works, but it is private SkyLight SPI, it serves only
`double_click`/`scroll`/pixel-`type_text` (never a single `click`, which always resolves to AX), it is
self-reported `unverifiable`, and it could not be confirmed on both application classes with all invariants
preserved. That decision is now closed; do **not** re-open it in CUA-0.5.

**CUA-0.5 is delivered** — the trust-persistence question is answered and the foundation is proven; see
§4.12 and the durable spec at `packages/zcode-cua/specs/computer-use.md`. What follows is what it
established, retained here because it is the acceptance criterion CUA-1 inherits:

The decisive open risk was no longer capability but *trust persistence*: our own helper must keep its
Accessibility + Screen Recording grants across a rebuild and an update.

1. Obtain a Developer ID (or generate a stable self-signed dev certificate).
2. Fix the helper install path.
3. Prove that the helper keeps its Accessibility + Screen Recording grants across a rebuild and an update.
4. Record, per grant, the exact bundle identity that receives it, whether a relaunch was required, whether
   the grant survived a helper restart, and whether a rebuild invalidated it. §4.11 measured the *inheritance*
   half of this for cua-driver and archived it (`33-permissions-and-identity.log`): the daemon ran as a child
   of the launching app, `check_permissions` reported `attribution: "caller"` with `disclaim_env: true`, and
   both booleans were true with **no grant made to `com.trycua.driver`** — while `permissions status` still
   says `unknown` and the driver's own earlier gated start (kept in `~/.zcode-fork-cua-home/tools/daemon.log`)
   shows it asking for the two grants its *bundle* does not have. So inheritance works; a bundle's own
   identity does not get them for free. That is an inheritance measurement for a third-party daemon, **not** a
   proof that our helper, launched through `ZCODE_CUA_LAUNCHER_PID`, will inherit the signed ZCode app's
   grant — which is precisely what step 3 must show rather than assume.

**Architecture after §4.11 (unchanged from §5, now with the pointer question closed):** a first-party Swift
helper behind the fork's existing `@zcode/zcode-cua` contract —

* background screenshots (ScreenCaptureKit, measured in §4.3 C1);
* background AX semantic actions (measured in §4.3 C2 and again on Qt in §4.11);
* background targeted keyboard **where verified** (measured in §4.3 C3; §4.11 showed it is not uniform
  across targets, so it stays capability-gated per target);
* pointer actions classified `REQUIRES_FOREGROUND` (the foreground control in §4.11 shows exactly what that
  costs: a real pointer journey that must be restored);
* an isolated desktop later, as the only place fully independent pointer use exists (§11).

Everything else in §15 stays blocked behind step 3.

---

## Appendix A — spike artifacts

| Path | Purpose |
|---|---|
| `spikes/cua-probe/main.swift` | Disposable Swift probe: observation, AX actions, SCK capture, PID + global input, event tap |
| `spikes/cua-probe/build.sh` | `swiftc` + ad-hoc `codesign` build, with the deployment-target and signing caveats documented inline |
| `spikes/cua-probe/run-tests.sh` | Zero-inference test suite; 15 assertions, before/after environment invariants |
| `spikes/cua-probe/run-pointer-trial.sh` | §4.11: one guarded background trial — quiet-gate, five invariants, event-tap contamination check, window-scoped before/after captures, optional per-target verify command |
| `spikes/cua-probe/run-matrix.sh` | §4.11: drives a list of trials, logging the target's own title readback next to the driver's claim |
| `spikes/cua-probe/run-qt-matrix.sh` | §4.11: Qt driver — relaunches the target via `launch_app` (which does not front it) and verifies against the `AXCheckBox` value |
| `spikes/cua-probe/retry-qt-zoom.sh` | §4.11: repeats the title-bar trial until a quiet bracket, deriving the click point from the driver's own frame so it survives zooms |
| `spikes/cua-probe/summarize-trial.py` | §4.11: prints the five invariants and the clean/contaminated verdict for one trial |
| `spikes/cua-probe/summarize-state.py` | §4.11: one-line projection of the probe's environment state |
| `spikes/cua-probe/qt-helper.py` | §4.11: coordinate/size/action parsing kept in a file to avoid nested shell quoting |
| `spikes/cua-probe/skyprobe.c` | §4.11: `dlopen`+`dlsym` capability probe for the 15 private SkyLight symbols the driver uses |
| `spikes/cua-probe/verify-claims.py` | §4.11: re-derives every number quoted in §4.11 from the raw artefacts and exits non-zero on any mismatch (33/33 pass; output archived as `34-claim-verification.log`) |
| `packages/zcode-cua/native/cua-helper/main.swift` | §4.12: the CUA-0.5 development Helper — permission state, app enumeration, a harmless AX read, a real ScreenCaptureKit capture, and self-reported code identity. Implements **no** input |
| `packages/zcode-cua/native/cua-helper/build-dev-helper.mjs` | §4.12: builds/signs the dev Helper into the contract's dev install path; refuses the product helper bundle id and refuses ad-hoc signing unless explicitly asked |
| `packages/zcode-cua/native/cua-helper/signing/create-dev-signing-identity.sh` | §4.12: creates the dedicated self-signed identity in an isolated keychain (touch no other identity, write no trust setting) |
| `packages/zcode-cua/native/cua-helper/run-permission-probe.sh` | §4.12: one observation with its launch path, process tree and signature recorded alongside the permission reading |
| `packages/zcode-cua/native/cua-helper/run-permission-matrix.sh` | §4.12: the persistence matrix (restart / rebuild / reinstall / version / requirement-mismatch) |
| `packages/zcode-cua/native/cua-helper/run-tamper-probe.sh` | §4.12: the tamper probe — records the exact command, the signature-verify result and the permission state per case |
| `packages/zcode-cua/native/cua-helper/tamper-offsets.py` | §4.12: correct `__text`/`__cstring` file offsets for the tamper probe (the first attempt conflated a virtual address with a file offset) |
| `packages/zcode-cua/native/cua-helper/verify-cua05-claims.py` | §4.12: re-derives every number in the CUA-0.5 spec and evidence README from the artifacts (41/41 pass) |
| `packages/zcode-cua/native/cua-helper/show-report.py` | §4.12: one-line projection of a helper report |
| `spikes/cua-05-identity/evidence/` | §4.12: the archived CUA-0.5 run — every observation with its launch path, identity, permission probes and capture result |
| `spikes/cua-probe/pointer-target/target.html` | §4.11: the instrumented Chromium target; publishes its own state in `document.title` and flags injected clicks with no pointer journey |
| `spikes/cua-probe/evidence/` | Raw per-action JSON snapshots, PNG captures, `summary.log`, the attribution logs, and `evidence/window-pointer-20260923-021940/` (§4.11, with its own README) |
| `~/.zcode-fork-cua-home/` | Isolated spike namespace (never `~/.zcode-fork-dev-home`) |

## Appendix B — isolation recipe for this worktree

`mise run dev` **must not** be used from this worktree: `mise.toml` hardcodes
`ZCODE_DATA_BASE_DIR=$HOME/.zcode-fork-dev-home`, which is the canonical integration namespace. Explicit
environment wins in `scripts/custom-fork-dev-env.mjs`, so drive the underlying script directly:

```bash
ZCODE_FORK_DEV=1
ZCODE_DATA_BASE_DIR=$HOME/.zcode-fork-cua-home
ZCODE_HOME=$HOME/.zcode-fork-cua-home/.zcode
ZCODE_DESKTOP_HOME_DIR=$HOME/.zcode-fork-cua-home
ZCODE_DESKTOP_APPLICATION_NAME="ZCode CUA Spike"
ZCODE_DESKTOP_PROTOCOL_SCHEME=zcode-cua-spike
ZCODE_DESKTOP_DEV_RENDERER_PORT=<free>          # default 5174, strictPort
ZCODE_DESKTOP_REMOTE_DEBUGGING_PORT=<free>      # default 9229 collides with other instances
ZCODE_FORK_DEVICE_NAME=cua-spike                # otherwise the relay evicts the other instance
ZCODE_LOG_DIR=$HOME/.zcode-fork-cua-home/logs
ZCODE_STORAGE_DIR=$HOME/.zcode-fork-cua-home/storage
# leave ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA unset (it disables isolation)
# leave ZCODE_DEBUG unset (the host --inspect-brk port would collide)
```

Because `ZCODE_DESKTOP_APPLICATION_NAME` differs, Electron's `userData` — and therefore the
single-instance lock derived from it — cannot collide with the installed app. A separate
`ZCODE_DATA_BASE_DIR` yields a separate `deviceMid` (`…/.zcode/v2/telemetry-state.json`) and a separate
credential store.

**Known isolation gaps (from the audit, not guesses):** `~/.zcode/cli/config.json`, `~/.zcode/plugins`,
`~/.agents/skills` and `~/.claude` are **HOME-scoped only** — `ZCODE_DATA_BASE_DIR` does not relocate
them; only `HOME`, or `ZCODE_LOG_DIR` + `ZCODE_STORAGE_DIR`, does. `packages/web/vite.config.ts` hardcodes
its dev proxies to `localhost:3030`.

**Demonstrated:** the override precedence above is verified against the repo's own
`resolveDataBaseDir` semantics, the spike ran entirely inside `~/.zcode-fork-cua-home`, no write occurred to
`~/.zcode`, and the official app was never touched. **Not demonstrated:** a live concurrent second Electron
instance, because this worktree has no `node_modules` (`pnpm install` was not run).

## Appendix C — side effects created during this spike

Recorded so nothing is a surprise:

* `~/.zcode-fork-cua-home/` created (the sanctioned spike namespace), containing `tools/` only.
* `~/.cua-driver/` created by cua-driver for its own config; **telemetry was disabled**.
* cua-driver's permission gate opened **System Settings → Privacy & Security**, and a pending
  Accessibility prompt (`universalAccessAuthWarn`) plus the **Screen & System Audio Recording** pane were
  on screen at the end of the spike.
* TextEdit and Calculator were opened as test targets; Calculator's display holds a test value.
* TextEdit contains leftover probe text (`Untitled` document).
* No write to `~/.zcode`, no modification of `/Applications/ZCode.app`, no commit, no merge, no
  modification of any file under `packages/`, `apps/`, or `scripts/`.

**Added by CUA-0.5 (§4.12), recorded so nothing is a surprise:**

* Two code-signing keychains created inside the isolated namespace:
  `~/.zcode-fork-cua-home/signing/` (the primary `ZCode CUA Dev Signing` identity) and
  `~/.zcode-fork-cua-home/signing-alt/` (a deliberately different certificate used only to model a
  requirement mismatch). Each holds its own generated password in a `0600` file beside it. The login
  keychain, any existing identity, and every system/user trust setting are untouched; the certificate is
  deliberately *not* trusted, so `spctl` rejects the bundle (a distribution concern, not a TCC one).
* A development Helper installed at `~/.zcode-fork-cua-home/.zcode/computer-use/dev/ZCode Computer Use
  Dev.app` plus two control bundles (`ZCode CUA Control.app`, `ZCode CUA Control2.app`) used to prove the
  grant is per-bundle-id. Deleting them removes every artifact of this phase.
* **TCC entries.** The user granted Accessibility and Screen Recording to
  `dev.zcode.cua-helper.dev` (the development Helper). This is the one durable system-side effect:
  `tccutil reset Accessibility dev.zcode.cua-helper.dev` and
  `tccutil reset ScreenCapture dev.zcode.cua-helper.dev` remove it. The same commands were run mid-experiment
  (scoped to that bundle id only) to create the denied baseline, and no other application's grants were
  touched. The control bundles ended untrusted, as intended.
* The product's own installed helpers under `~/.zcode/computer-use/` were **read-only inspected for their
  identity metadata** (bundle id, certificate authority, designated requirement) so this work could avoid
  colliding with the grant they already hold; nothing under `~/.zcode` was written, re-signed or launched.
* `node_modules` was installed in this worktree so `pnpm typecheck`, `pnpm lint` and
  `pnpm architecture:check` could actually be run instead of reported as not-run (all three pass).
* The harness only ever reads: it performs no input synthesis. The Helper itself implements no pointer or
  keyboard events at all.

The harness itself posts **real global clicks** at fixed screen coordinates during Test E
(`run-tests.sh`, three clicks at 500,500 / 520,520 / 540,540) and sends a global Cmd+A / Delete to the
frontmost app during D2. Whatever window occupies those coordinates receives a genuine click. The
coordinates were chosen to sit over the Calculator window, but this is a real, if small, hazard of running
the suite and is called out here rather than left implicit.

## Appendix D — independent review and disposition

An independent read-only reviewer inspected this document, the probe source, both shell scripts, and every
archived evidence run, with instructions to hunt for unsupported claims, licensing errors, permission
assumptions, security issues, unnecessary reinvention and code defects. It found **two critical, seven
major and fourteen minor** issues. Its verdict on the core technical findings was that they are
**supported by the archived evidence**. The material findings and their disposition:

| Finding | Disposition |
|---|---|
| "15/15 reproducible" contradicted by its own evidence directory | **Fixed** — replaced with the full per-run history, including the failures (§4) |
| Claimed local reproduction of trycua/cua#2619 was **false** (the press worked) | **Fixed** — corrected, and #2619 restated accurately as a *disabled-element* hazard (§4.2), which added an `AXEnabled` precondition to the contract (§7) |
| The single most decision-relevant third-party claim (cua-driver background click) had no archived evidence | **Fixed** — explicitly downgraded to an unarchived observation, with the reproducible parts named (§4.7) |
| Latency numbers misattributed and inflated by ≈20 ms of harness interpreter startup | **Fixed** — caveat added, ranges corrected, in-process vs bracketed distinguished (§4.1, §4.8) |
| "249 nodes" was a line count, not a node count | **Fixed** — 242 per the probe's own counter |
| §9's "measured" table included an API never exercised (`AXSetAttributeValue`) | **Fixed** — split into measured / not-measured rows (§9) |
| Frame credential predicates listed as "real, wired, already correct" — they are stubs | **Fixed** — moved to placeholders; §12 now says *implement*, not *preserve* (§1.1, §1.2, §12) |
| `E2` could pass **vacuously** (proven: it passed in a run where the binary did not exist) | **Fixed in code** — the assertion now requires `ok == true` and key presence |
| `C1` could not tell per-window capture from a full-screen grab | **Fixed in code** — now asserts the capture target is the window |
| Right-click was broken in both click paths (mouse-up constructed as `.left`) | **Fixed in code** |
| JSON interpolated into Python source via `'''…'''` (injection/crash risk) | **Fixed in code** — passed via `argv` instead |
| Attribution section presents an inference as a measurement | **Fixed** — precision caveat added (§4.4); verification added to §18 |
| Permission table tagged "measured" for untested cases | **Fixed** — §8.1 now distinguishes measured from documented |
| Licensing: `cua-som` is AGPL-3.0-**or-later** not *-only*; ONNX Runtime MIT omitted; the driver tarball ships no LICENSE/NOTICE | **Fixed** (§17), and the NOTICE task is now called out as unassigned |
| Security blind spots: AX text as an exfiltration surface, the tap as a keylogger surface, prompt injection from observed content | **Fixed** — added to §12; the recent-items leak is recorded as a first-class finding |
| Phantom `C5` citation; 26 vs 25 action names; dead guard in the suite | **Fixed** (phantom citation and count); the guard ordering is cosmetic and noted, not changed |

**Findings accepted without change:** the reviewer verified that the author's four earlier self-caught
fixes (run-loop pump instead of a nested-`defer` semaphore, sorted-key canonical comparison, cursor warp
before global clicks, incremental event-mask construction) are correct as written; that the design reuses
in-repo mechanisms rather than reinventing them (`TASK_ARTIFACT_ORIGINS`, the browser-use artifact Proxy
hook, the existing permission pipeline, the node_repl CUA broker, the helper bundle ids); and that the
document's relay, artifact, phase and isolation-recipe citations are accurate. It also independently
confirmed the §8.3 toolchain hazard is already handled in-repo by
`packages/desktop/scripts/build-macos-window-bounds.mjs`, which passes an explicit `-target` — so that
finding is corroboration rather than new information.

**Residual, unresolved:** the reviewer noted that the evidence set may be incomplete (a leftover
per-run marker implies at least one run directory is absent), and that `E2`'s zero-event result would be
stronger with a same-window positive control. Both are recorded here rather than papered over.

## Appendix E — independent review of the §4.11 follow-up

A second independent read-only reviewer was run over the §4.11 material before this document was finalised:
the archived artefacts under `evidence/window-pointer-20260923-021940/`, the harness scripts, the
private-API/licensing claims (re-derived by reading upstream itself, not by trusting this document), and the
conclusion. It was instructed to verify claims against raw files rather than prose. It found **no
unsupported claim in the core technical result** and independently reproduced the decisive ones: the route
mapping (`accessibility` for every coordinate single `click`; `synthetic_events` only for
`double_click`/`scroll`/pixel-`type_text`; `global_input` for foreground), the state readbacks, the
`skyprobe.c` symbol probe (15 symbols, 14 resolved, only `GetProcessForPID` missing), and the notarization
status of the shipped binary (`codesign`/`spctl`/`stapler`). Its material findings and their disposition:

| Finding | Disposition |
|---|---|
| "8 of 32 trials discarded as contaminated" was wrong in its numerator — **20** of the 32 had a contaminated bracket | **Fixed** — §4.11 and the evidence README now state 20 contaminated / 12 tap-clean / 8 clean-and-intact, with the per-trial tally archived |
| "All invariants were preserved in every attributable trial" was falsified by an unlisted trial — the Qt foreground control `P-FG1` is tap-clean yet changes the frontmost app | **Fixed** — the claim is now scoped to tap-clean *background* trials, and `P-FG1`'s behaviour is named as correct control behaviour |
| The Qt window z-order was given as 17 in the README and "17–23" in §4.11; measured values are 23 and 20–23 / 58–62 / 14–23 | **Fixed** — both documents now carry the measured per-window values |
| Permission/identity/telemetry claims had **no archived artefact**, and `daemon.log` records the driver's own identity *lacking* both grants | **Fixed** — `33-permissions-and-identity.log` now archives `check_permissions` (`attribution: "caller"`), `permissions status` (`unknown`), `telemetry status`, and the signature assessment; §4.11 and §18 now state the inheritance measurement *and* its limit (no grant to `com.trycua.driver` was ever made, so "no grant needed" holds only for this configuration) |
| "Every pointer action returned `effect: "unverifiable"`" is false for one archived action (`Q-TXT1` returned `effect: "partial"`) | **Fixed** — qualified in both documents |
| "the whole mechanism is under 100 lines of `dlsym`-gated FFI" materially understated the reimplementation cost | **Fixed** — now cites the real sizes (~130-line symbol table in a ~950-line file; ~1 860-line `mouse.rs`) |
| The `CGEventPostToPid` quote was attributed to `mouse.rs`'s header; it is `skylight.rs` lines 6–8 | **Fixed** — each sentence attributed to its own file |
| Upstream was read from `main`; no `v0.28.2` tag resolves on raw URLs | **Fixed** — §4.11 carries the caveat and separates *read from `main`* from *reproduced against the installed 0.28.2 binary* |
| "landed at the resolved AX element's centre" (`Q-PXC1`) was an inference with no captured AX frame | **Fixed** — replaced with the measured landing point versus the requested point |
| `summarize-trial.py` labelled a quiet bracket "attributable" even when the action was **refused**, so a no-op could score as a result | **Fixed in code** — the verdict now requires a reported route, and says `REFUSED/NO-OP` otherwise |
| `retry-qt-zoom.sh`'s first version printed `CLEAN BRACKET` for an attempt whose action never ran (malformed JSON), and the stale log survived | **Fixed in code**; the superseded log is deliberately **kept** and called out in the evidence README, because deleting it would hide that a false "clean" was once emitted |
| `run-matrix.sh` hard-coded `AX_LABEL_PREFIX` (later fixed, but the leftover default `CLICK` now disagrees with `run-pointer-trial.sh`'s `CLICKED`) | **Recorded** — cosmetic; the correct prefix was always passed explicitly by the callers |
| The `README` described one page-title format while the `C-*` trials ran against an earlier page whose field was `T`, and called it the "page counter" when it is the button counter | **Fixed** — both page versions documented; `T`/`B` identified as the button counter |
| Dangling reference to "§18's rule" after §18 was rewritten; `summary.log` cited at the wrong path in Appendix A | **Fixed** — the rule is restated inline where it is applied, and the appendix no longer claims a root-level `summary.log` |
| Chrome profile-integrity check and the "user closed the apps by hand" attribution are conversational, not archived | **Accepted, not hidden** — both are now explicitly listed in the evidence README as assertions without artefacts, alongside the half of the Chrome incident that *is* corroborated |

**Reviewer verdict:** §4.11's conclusion — do not depend on cua-driver for pointer control — **is supported
by the archived evidence**, and it is not an overstatement of failure: the reviewer specifically checked
whether the recommendation was reverse-engineered to a preferred answer and concluded it was not, noting
that the route genuinely worked (coordinate-exact background double-click on an occluded Chromium window; a
real Qt window-frame change) and that the decisive reasons stand independently — single `click` never takes
the pointer route, the route is private SkyLight SPI, every pointer effect is self-reported
`unverifiable`, and `drag` is refused in background. The licensing/App-Store claims were confirmed correct.
The **weakest evidentiary leg is the Qt class**, and the reviewer said so: its one effective pointer
attempt (`Q2-BGZOOM-1`) had a contaminated bracket, and the other Qt pointer targets were either refused or
non-disambiguating, so "both classes with all invariants preserved" was never cleanly demonstrated. That is
the honest reason the decision rule lands on B, and §4.11 now says it that way rather than implying an
invariant *failure* where there was only contamination.
