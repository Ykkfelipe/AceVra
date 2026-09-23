# CUA-0 follow-up — background-pointer measurement (2026-09-23)

Bounded follow-up experiment: does cua-driver's window-scoped pointer route produce
**genuine background pointer interaction** on this Mac, on more than one application
class? Measured, not inferred. macOS 27.0 (26A428), arm64. cua-driver 0.28.2
(`com.trycua.driver`, Developer ID `Cua AI, Inc. (YCK386LBJ7)`, notarized, stapled —
see `33-permissions-and-identity.log`). Telemetry disabled (`source: persisted`, same log).
That log also records how permissions resolved: the daemon was started as a child of the
launching app's shell, and `check_permissions` reports `attribution: "caller"` with
`disclaim_env: true` — so its Accessibility/Screen Recording booleans are **inherited from
the launching app**, and no grant to `com.trycua.driver` itself was made or needed in this
configuration. `permissions status` still reports `unknown` because no daemon runs under
that bundle identity, and the driver's own earlier gated start (kept in
`~/.zcode-fork-cua-home/tools/daemon.log`) shows it asking for both grants it does not
have. Both facts belong together: "no grant needed" is true only because we never ran it
under its own identity.

## How a trial was judged

Every action is bracketed by a listen-only `CGEventTap` at `.cghidEventTap` and by the
five invariants from the spike's strict definition of "background":

1. frontmost application   2. hardware cursor position   3. keyboard focus
4. target window not raised   5. independently verified state change in the target

A returned success code is never the result. The target's *own* state is the readback,
read through `CGWindowList` (window title) or `AXUIElement` — never through the driver.
A trial whose bracket observed **any** physical event is reported as CONTAMINATED and is
not counted, because this machine has a human user driving it throughout.

`summarize-trial.py <run_dir> <label> <pid>` prints the invariants for one trial.

`verify-claims.py <run_dir>` re-derives every number quoted in §4.11 of the architecture
document straight from these files and exits non-zero on any mismatch. Its output is
archived here as `34-claim-verification.log` (33/33 pass). It exists so that the document can
be checked against the evidence rather than either being taken on trust.

## Targets

| Class | Target | Discovery |
|---|---|---|
| A. Chromium-family desktop app | Google Chrome 153.0.8010.53, isolated `--user-data-dir`, app-mode, `--force-renderer-accessibility` | installed; purpose-built page (see `pointer-target/target.html`) because no installed app offered a harmless, independent readback |
| B. Qt / QtWidgets (non-AppKit) | Prism Launcher 11.1.0 (`org.prismlauncher.PrismLauncher`), Qt6 + QtWidgets | the **only** Qt app installed; no Flutter app exists on this machine |
| control | Calculator (AppKit) | carried over from the main spike |

The Chromium target page publishes its state in `document.title`, so an external observer
reads it without any automation API. There were **two successive page versions**; the
`C-*` trials ran against the first and the `Q-*` trials against the second:

```
v1 (C-* trials):  CUA-T<button clicks>-C<x>x<y>[-H]-M<moves>-N<chars>
v2 (Q-* trials):  CUA-B<button>-K<canvas>-P<page>-S<scrollTop>-C<x>x<y>[-H]-M<moves>-N<chars>
```

`T` in v1 and `B` in v2 are both the **button** counter (clicking the button is exempted
from the page-level handler); `P` is the page-level counter for clicks that no specific
handler claimed.

`-H` marks a click preceded by a real pointer journey over the clicked element (how a
human click presents itself). Its absence marks a click that materialised on the element
with no journey — how an injected background click presents itself. This flag is what
separated background delivery from the foreground control below.

## Trial tally

32 trials were run. **20 had a contaminated bracket** (the tap recorded physical input,
all of it `mouseMoved`/`scrollWheel`/mouse-button/key events — i.e. a human). Of the 12
tap-clean trials, 3 were refusals that never reached an actuator, and 1 (the Qt foreground
control `P-FG1`) legitimately changed the frontmost app. That leaves **8 trials that were
clean, reached an actuator, and preserved every invariant** — the ones the tables below
lean on. `summarize-trial.py` prints this per trial; note that a quiet bracket alone is
*not* evidence of anything if the action was refused, which is why its verdict now checks
for a reported route as well.

## Results — Class A (Chromium)

| Trial | Action | Driver-reported route / mode / effect | Independent readback | Bracket | Verdict |
|---|---|---|---|---|---|
| C-AX2 | AX press by `element_token` | `accessibility` / background / unverifiable | window title `T1→T2` | clean (0) | **BACKGROUND_CONFIRMED** |
| C-DBL1 | pixel double-click (button centre) | `synthetic_events` / background / unverifiable | page counter `T4→T6` — two clicks, exact coordinate, **no `-H`** | clean (0) | **BACKGROUND_CONFIRMED** |
| Q-DBL2 | pixel double-click (canvas, absent from the AX tree) | `synthetic_events` / background | canvas counter `K1→K3`, page counter `+2` | clean (0) | **BACKGROUND_CONFIRMED** |
| Q-PXC1 | pixel single click (canvas) | `accessibility` | page counter `+1`, registered at `C185x335` instead of the requested point (which maps to `C185x311`) | clean (0) | BACKGROUND_PARTIAL — landed, but **not** at the requested coordinate |
| Q-WHL2/3 | pixel wheel scroll (nested `overflow:auto`) | `synthetic_events` / background | scrollTop `240→480→628` (max) | contaminated | effect demonstrated, attribution not clean |
| C-TXT1 | pixel click field + `type_text` | `synthetic_events` / background / unverifiable | 11 chars landed (`N0→N11`) | contaminated | effect demonstrated, attribution not clean |
| Q-TXT1 | same, later retry | `type_text_incomplete`, `delivered_chars: 0`, `effect: partial` | nothing landed | contaminated | **inconsistent** |
| C-FG1 / Q-FG1 | same click, `delivery_mode: foreground` | **`global_input`** / foreground | page recorded **`-H`** (real pointer journey); tap saw the cursor moves | n/a (control) | foreground control: real pointer is transiently hijacked |

Coordinate fidelity: the background `double_click` registered at the exact button centre,
while the AX-resolved single `click` registered at the web area's centre instead. In
foreground mode the same single click registered at exactly the requested coordinate.
So the pointer route is coordinate-accurate and the AX route is element-accurate.

## Results — Class B (Qt)

Target: Prism Launcher's `Meow` `AXToolButton` (exposed as `AXCheckBox`, `AXValue` 0/1) and
its title bar. Routes reported: `accessibility: available`, `window_pointer: available`,
**`pid_keyboard: refused — same_pid_keyboard_ambiguity`**.

| Trial | Action | Route / mode | Independent readback | Bracket | Verdict |
|---|---|---|---|---|---|
| P-AX1 | AX press by `element_token` | `accessibility` / background | `AXValue 0→1` | clean (0) | **BACKGROUND_CONFIRMED** |
| P-PX1 | pixel single click | `accessibility` / background | `AXValue 1→0` | clean (0) | BACKGROUND_PARTIAL (AX route, not the pointer route) |
| P-DBL1 | pixel double-click | `synthetic_events` / background | `AXValue 0→0` | clean (0) | UNVERIFIABLE — an even number of toggles is indistinguishable from none |
| Q2-FGZOOM | title-bar double-click, foreground | `global_input` / foreground | frame `800×632 → 1470×874` | control | control confirmed the title bar drives macOS window zoom |
| Q2-BGZOOM-1 | title-bar double-click, background | `synthetic_events` / background | **frame `800×632 → 1470×874`** | 149 events (see below) | effect real; **not attributable** |
| P-DRG1 | pixel drag | — | — | — | **refused: `{"code":"background_unavailable"}`** |
| Q2-BGZOOM-2..6 | same, later | — | — | — | **refused: `minimized_or_hidden_window`** |

The title bar was chosen because it is the one Qt surface that is *not* AX-actionable (the
`AXWindow` exposes only `AXRaise`), so the driver is forced onto the pointer route, and
because a window-frame change is multi-valued — it cannot be produced by zero clicks, which
is exactly what the binary checkbox could not rule out.

On `Q2-BGZOOM-1` the pointer route really did change the target in the background:
frontmost unchanged (ZCode), hardware cursor **bit-identical** before and after
(610.921875, 261.87890625), the window stayed behind (z-order 23) and was never raised.
But the tap recorded 149 `mouseMoved` events during the bracket, so the trial is not
attributable and is not counted. Those events cannot be attributed to the driver either —
the pointer sat at exactly the same coordinate afterwards.

## Reliability across repeated attempts

* Single `click` **never** used the pointer route on either class: it always resolved to
  `accessibility`. The pointer route appeared only for `double_click`, `scroll` and the
  pixel form of `type_text`.
* Bottom text entry: 11 characters once, 0 characters (`effect: "partial"`, retryable)
  on the next attempt.
* `drag`: explicitly refused in background on macOS.
* A window left minimized was refused as `minimized_or_hidden_window`, although it was
  visible when maximized — so the exact-window gate is sensitive to window state.
* Every pointer action returned `effect: "unverifiable"` — except the one `type_text`
  retry, which returned `effect: "partial"` with `delivered_chars: 0`. In no case does the
  driver claim a confirmed pointer effect, and every confirmation in this table came from
  the independently instrumented target.

## Private-API route

The route that produced the background pointer effects is the private SkyLight SPI.
Read from the upstream open-source tree (`libs/cua-driver/rust/crates/platform-macos/src/input/`):

* `skylight.rs` — "SkyLight SPI bridge"; `dlopen`s
  `/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight` and resolves every symbol
  lazily with `dlsym`, cached in `OnceLock`.
* `mouse.rs` — "Background mouse event synthesis via `SLEventPostToPid` (SkyLight SPI), with
  fallback to the public `CGEvent::post_to_pid`". Its header states the mechanism: `SLEventPostToPid`
  goes through `IOHIDPostEvent` and triggers `CGSTickleActivityMonitor`, which is "required for
  Catalyst / Chromium" — and that **the public `CGEventPostToPid` skips that tickle, so
  Chromium/Catalyst targets don't accept those events as live input.** This is precisely the
  earlier spike's measured `CGEventPostToPid` click failure (§4.3 C4 / §4.5 D3).
* Keyboard additionally attaches a private `SLSEventAuthenticationMessage` via
  `SLEventSetAuthenticationMessage`; activation uses `SLPSPostEventRecordTo` /
  `SLPSSetFrontProcessWithOptions`.
* Fallback: `post_to_pid` returns `false` when the SPI is absent, and the caller falls back to
  the public `CGEventPostToPid`. No unwrap, no panic.

Capability probe run on this machine (`spikes/cua-probe/skyprobe.c`, macOS 27.0 / 26A428):
every symbol resolves except the legacy `GetProcessForPID` (used only as an older-system
fallback). So the route is **capability-detectable** and degrades rather than crashing, but on
macOS 27 the private path is live.

## Reasoning

* Chromium class: background pointer delivery is real, coordinate-accurate and
  attributable — the pointer route passed there.
* Qt class: the pointer route produced a real background effect, but the one effective
  attempt could not be made cleanly attributable, the binary-toggle target could not
  disambiguate at all, `drag` is unavailable in background, and `pid_keyboard` is refused
  on this target.
* Independently of the class question, the route depends on private SkyLight SPI, and every
  pointer action is self-reported as `unverifiable`.

Therefore the "both classes, all invariants preserved, acceptable reliability" bar is not
met, and the private-API criterion in the decision rule applies on its own. See
`docs/COMPUTER_USE_ARCHITECTURE_SPIKE.md` §4.11 for the disposition.

## Reproducing

```bash
# 1. driver daemon (grants are inherited from the launching app: attribution "caller")
~/.zcode-fork-cua-home/tools/cua-driver-rs-0.28.2-darwin-arm64/cua-driver serve --no-permissions-gate
# 2. Chromium target
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$HOME/.zcode-fork-cua-home/chrome-pointer-profile" \
  --no-first-run --no-default-browser-check --force-renderer-accessibility \
  --window-position=40,430 --window-size=660,500 \
  --app="file://$HOME/.zcode-fork-cua-home/pointer-target/target.html"
# 3. one guarded trial
RUN_DIR=$PWD/evidence/<run> ./run-pointer-trial.sh <LABEL> <pid> <wid> double_click \
  '{"pid":<pid>,"window_id":<wid>,"x":660,"y":438,"delivery_mode":"background"}'
# 4. verdict
python3 summarize-trial.py evidence/<run> <LABEL> <pid>
```

`run-matrix.sh` drives a list of trials; `run-qt-matrix.sh` and `retry-qt-zoom.sh` are the
Qt-specific drivers (the latter derives the title-bar point from the driver's own frame, so
it survives the window being zoomed and unzoomed between attempts).

## Environment caveat (recorded honestly)

The user of this machine was working throughout, so the machine was never idle: 20 of the
32 trials were contaminated and discarded (see the trial tally above).

**Two method defects found and fixed during the run, recorded rather than hidden:**

* `31-qt-zoom-retry.log` is a superseded log from a broken first version of
  `retry-qt-zoom.sh`. It printed `CLEAN BRACKET on attempt 1` for an attempt whose action
  never ran at all (the driver received malformed JSON, `{"x":,"y":}`). The success
  condition was then wrong; the current script requires a reported route, a clean bracket
  *and* an actual frame change. The log is kept because deleting it would hide that a
  "clean" result was once emitted for a no-op.
* `summarize-trial.py` originally labelled any quiet bracket `attributable`, including
  trials whose action was refused. It now requires a reported route before it will say
  `attributable`.

**Assertions in this document that have no archived artefact** (flagged because an earlier
review of the main spike faulted exactly this class of claim):

* Prism Launcher and Unity Hub were closed by the user within seconds-to-minutes of launch;
  the user said so in conversation after the run. The surviving evidence is indirect:
  Prism Launcher's own log ends mid-session with no shutdown sequence, and no crash report
  exists. The author initially misattributed these terminations to the driver or the OS.
* The Chrome profile-integrity check (four profiles with Cookies/Login Data present,
  `Profile 3` written 01:56) was performed interactively on the filesystem and is not
  captured in this directory. The half of that incident that *is* corroborated is the stray
  process: `16-chrome-launch5.log` and the process table show the isolated instance (pid
  11026, `--user-data-dir=…/chrome-pointer-profile`) alive ~27 minutes after its tests.
