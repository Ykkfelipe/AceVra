#!/usr/bin/env bash
# Zero-inference deterministic test suite for macOS computer-use primitives.
#
# Every action is bracketed by before/after environment snapshots so that
# "worked in the background" is a measured claim rather than an impression: if
# the frontmost application or the hardware cursor moved, the action is recorded
# as having taken foreground effect regardless of how it appeared.
#
# Success is never taken from an API return code. AX actions report
# kAXErrorSuccess for presses that did nothing (upstream trycua/cua#2619), so
# every semantic action is verified against resulting application state.
#
# No model inference is involved anywhere in this file.

set -uo pipefail

SPIKE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="${SPIKE}/build/ZCode CUA Probe.app/Contents/MacOS/ZCodeCuaProbe"
EVIDENCE="${SPIKE}/evidence"
RUN="${EVIDENCE}/run-$(date +%Y%m%d-%H%M%S)"
mkdir -p "${RUN}"

SUMMARY="${RUN}/summary.log"
PASS=0
FAIL=0

# Abort rather than produce a partial run: a missing or stale binary would
# otherwise show up as a mixture of failures and vacuous passes (an empty event
# count "proving" that PID-routed input is invisible, for example).
if [[ ! -x "${PROBE}" ]]; then
	printf 'FATAL: probe binary missing at %s — run ./build.sh first\n' "${PROBE}" >&2
	exit 3
fi

log() { printf '%s\n' "$*" | tee -a "${SUMMARY}"; }
probe() { "${PROBE}" "$@"; }

assert() { # assert <label> <actual> <expected>
	if [[ "$2" == "$3" ]]; then
		PASS=$((PASS + 1))
		log "    PASS ${1}: ${2}"
	else
		FAIL=$((FAIL + 1))
		log "    FAIL ${1}: got '${2}' expected '${3}'"
	fi
}

assert_contains() { # assert_contains <label> <haystack> <needle>
	if [[ "$2" == *"$3"* ]]; then
		PASS=$((PASS + 1))
		log "    PASS ${1}: ${2}"
	else
		FAIL=$((FAIL + 1))
		log "    FAIL ${1}: '${2}' does not contain '${3}'"
	fi
}

# --- snapshot helpers -------------------------------------------------------

snap() { probe state >"$1" 2>&1; }

# Compare two snapshots and report the facts the background claim depends on.
compare() {
	python3 - "$1" "$2" <<'PY'
import json, sys
a = json.load(open(sys.argv[1]))
b = json.load(open(sys.argv[2]))
def fm(d):
    f = d.get("frontmost") or {}
    return [f.get("pid"), f.get("name")]
def cur(d):
    c = d.get("cursor") or {}
    return [round(c.get("x", -1), 1), round(c.get("y", -1), 1)]
def top(d):
    w = d.get("topWindows") or []
    return w[0].get("owner") if w else None
fa, fb = fm(a), fm(b)
ca, cb = cur(a), cur(b)
print(json.dumps({
    "frontmostBefore": fa, "frontmostAfter": fb, "frontmostChanged": fa != fb,
    "cursorBefore": ca, "cursorAfter": cb, "cursorChanged": ca != cb,
    "topWindowBefore": top(a), "topWindowAfter": top(b), "topWindowChanged": top(a) != top(b),
}, sort_keys=True))
PY
}

# True only when nothing observable moved.
is_background() {
	python3 - "$1" <<'PY'
import json, sys
d = json.loads(sys.argv[1])
ok = not d["frontmostChanged"] and not d["cursorChanged"] and not d["topWindowChanged"]
print("true" if ok else "false")
PY
}

field() { # field <json> <key>
	python3 -c "import json,sys;print(json.loads(sys.argv[1]).get(sys.argv[2]))" "$1" "$2"
}

action() {
	local label="$1"
	shift
	log ""
	log "### ${label}"
	log "    command: probe $*"
	snap "${RUN}/${label}.before.json"
	probe "$@" >"${RUN}/${label}.action.json" 2>&1
	local rc=$?
	sleep 0.35
	snap "${RUN}/${label}.after.json"
	sed 's/^/    out: /' "${RUN}/${label}.action.json" | tee -a "${SUMMARY}"
	log "    exit=${rc}"
	compare "${RUN}/${label}.before.json" "${RUN}/${label}.after.json" | sed 's/^/    env: /' | tee -a "${SUMMARY}"
}

# --- accessibility helpers --------------------------------------------------

# Press a control by AXIdentifier. Calculator renames the same physical button
# between AllClear and Clear depending on whether its display holds a value, so
# identifiers must be matched by pattern or re-resolved at action time and never
# cached across states.
press_id() {
	local label="$1" ident="$2" pid="${3:-${CALC_PID}}"
	snap "${RUN}/${label}.before.json"
	probe ax-press --pid "${pid}" --role AXButton \
		--identifier-regex "${ident}" --max-nodes 4000 \
		>"${RUN}/${label}.action.json" 2>&1
	local rc=$?
	sleep 0.2
	snap "${RUN}/${label}.after.json"
	local err
	err="$(field "$(cat "${RUN}/${label}.action.json" 2>/dev/null)" axErrorName 2>/dev/null)"
	log "    ${label}: identifier=${ident} axError=${err:-<none>} exit=${rc}"
	if [[ "${err}" != "success" ]]; then
		log "      raw: $(cat "${RUN}/${label}.action.json")"
	fi
}

clear_calc() { press_id "$1" '^(AllClear|Clear)$' "${2:-${CALC_PID}}"; }

# Calculator exposes its display as one or more AXStaticText nodes; the last
# non-empty one is the result, any earlier one is the expression.
calc_display() {
	probe ax-elements --pid "${CALC_PID}" --role AXStaticText --max-nodes 4000 2>/dev/null |
		python3 -c '
import json, sys
vals = []
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        d = json.loads(line)
    except Exception:
        continue
    v = d.get("value")
    if v not in (None, ""):
        vals.append(str(v))
print("|".join(vals))
'
}

calc_result() {
	calc_display | python3 -c '
import sys
parts = [p for p in sys.stdin.read().strip().split("|") if p]
print(parts[-1] if parts else "")
'
}

text_area_value() {
	probe ax-elements --pid "$1" --role AXTextArea --max-nodes 4000 2>/dev/null |
		python3 -c '
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        d = json.loads(line)
    except Exception:
        continue
    if d.get("value") not in (None, ""):
        print(d["value"])
        break
'
}

button_point() { # button_point <identifier-regex> -> "x y"
	probe ax-elements --pid "${CALC_PID}" --role AXButton --max-nodes 4000 2>/dev/null |
		python3 -c '
import json, sys, re
pat = re.compile(sys.argv[1])
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        d = json.loads(line)
    except Exception:
        continue
    ident = d.get("identifier") or ""
    if pat.search(ident) and d.get("position") and d.get("size"):
        p, s = d["position"], d["size"]
        print(int(p["x"] + s["w"] / 2), int(p["y"] + s["h"] / 2))
        break
' "$1"
}

# --- setup ------------------------------------------------------------------

log "ZCode CUA Probe — zero-inference primitive test suite"
log "run dir: ${RUN}"
log "host: macOS $(sw_vers -productVersion) ($(uname -m))"
log ""
log "### attribution"
probe permissions | sed 's/^/    /' | tee -a "${SUMMARY}"
log "    note: this run inherits the parent process TCC grant. See"
log "          evidence/attribution-own-identity.log for the standalone bundle,"
log "          which reports accessibility.trusted=false / screenRecording=false."

open -a Calculator >/dev/null 2>&1 || true
open -a TextEdit >/dev/null 2>&1 || true
sleep 3

CALC_PID="$(pgrep -x Calculator | head -1)"
TE_PID="$(pgrep -x TextEdit | head -1)"
CALC_WIN="$(probe windows --pid "${CALC_PID}" 2>/dev/null | python3 -c 'import json,sys
for l in sys.stdin:
    l=l.strip()
    if l.startswith("{"):
        d=json.loads(l)
        if d.get("layer")==0:
            print(d["id"]); break')"

log ""
log "CALC_PID=${CALC_PID} CALC_WIN=${CALC_WIN} TE_PID=${TE_PID}"
if [[ -z "${CALC_PID}" ]]; then
	log "FATAL: Calculator not running"
	exit 1
fi

# === TEST A — OBSERVATION ===================================================

log ""
log "================ TEST A — OBSERVATION ================"

log ""
log "--- A1: application enumeration (no TCC permission required) ---"
T0=$(python3 -c 'import time;print(time.time())')
probe apps >"${RUN}/A1.apps.json" 2>&1
T1=$(python3 -c 'import time;print(time.time())')
log "    apps: $(wc -l <"${RUN}/A1.apps.json" | tr -d ' ') entries, $(python3 -c "print('%.1f ms' % ((${T1}-${T0})*1000))")"

log ""
log "--- A2: window enumeration + z-order (no TCC permission required) ---"
T0=$(python3 -c 'import time;print(time.time())')
probe windows >"${RUN}/A2.windows.json" 2>&1
T1=$(python3 -c 'import time;print(time.time())')
log "    windows: $(wc -l <"${RUN}/A2.windows.json" | tr -d ' ') entries, $(python3 -c "print('%.1f ms' % ((${T1}-${T0})*1000))")"

log ""
log "--- A3: accessibility tree of a non-frontmost app ---"
T0=$(python3 -c 'import time;print(time.time())')
probe ax-tree --pid "${CALC_PID}" --max-depth 6 --max-nodes 400 >"${RUN}/A3.axtree.txt" 2>&1
T1=$(python3 -c 'import time;print(time.time())')
log "    nodes: $(grep -c . "${RUN}/A3.axtree.txt"), $(python3 -c "print('%.1f ms' % ((${T1}-${T0})*1000))")"
assert_contains "A3 tree contains calculator buttons" "$(cat "${RUN}/A3.axtree.txt")" "AXButton"

# === TEST B — SEMANTIC ACTION (AX) =========================================

log ""
log "================ TEST B — SEMANTIC ACTION ================"
log ""
log "--- B1: AXPress a known control, verify resulting UI state ---"
log "    plan: clear, 7, +, 3, = -> display result must be 10"

clear_calc "B1.clear"
press_id "B1.seven" '^Seven$'
press_id "B1.add" '^Add$'
press_id "B1.three" '^Three$'
press_id "B1.equals" '^Equals$'
sleep 0.5
log "    display: $(calc_display)"
assert "B1 semantic arithmetic 7+3=10" "$(calc_result)" "10"

log ""
log "--- B2: pre/post state proves the return code alone is not evidence ---"
python3 - "${RUN}/B1.seven.action.json" <<'PY' | tee -a "${SUMMARY}"
import json, sys
d = json.load(open(sys.argv[1]))
print("    B2 axError=%s (%s) but this element's own elementChanged=%s" % (
    d.get("axError"), d.get("axErrorName"), d.get("elementChanged")))
print("    B2 => the AX return code alone would have been misleading evidence;")
print("    B2    the display read-back above is what establishes success.")
PY

# === TEST C — BACKGROUND (target not frontmost) ============================

log ""
log "================ TEST C — BACKGROUND ================"
log ""
log "--- C0: establish background condition (different app frontmost) ---"
probe activate --pid "${TE_PID}" >"${RUN}/C0.activate.json" 2>&1
sleep 1.2
snap "${RUN}/C0.state.json"
python3 - "${RUN}/C0.state.json" <<'PY' | tee -a "${SUMMARY}"
import json, sys
d = json.load(open(sys.argv[1]))
f = d.get("frontmost") or {}
print("    frontmost: %s (pid %s); top window owner: %s" % (
    f.get("name"), f.get("pid"), (d.get("topWindows") or [{}])[0].get("owner")))
PY

log ""
log "--- C1: capture the target window while NOT frontmost ---"
if [[ -z "${CALC_WIN}" ]]; then
	log "    FAIL C1: could not resolve a window id for Calculator — refusing to"
	log "    capture, because an empty --window silently falls back to a full-screen grab"
	FAIL=$((FAIL + 1))
else
	action "C1.capture" shot --window "${CALC_WIN}" --out "${RUN}/C1.calculator-window.png"
	if [[ -f "${RUN}/C1.calculator-window.png" ]]; then
		C1_STATS="$(probe png-stats --png "${RUN}/C1.calculator-window.png")"
		log "    png: ${C1_STATS}"
		assert "C1 capture is not blank" "$(field "${C1_STATS}" looksBlank)" "False"
		# Without this the test would also pass on a whole-display capture, which
		# is a different (and much easier) capability than per-window capture.
		# `target` is reported by `shot`, not by `png-stats`.
		assert "C1 captured the requested WINDOW, not the display" \
			"$(field "$(cat "${RUN}/C1.capture.action.json")" target)" "window:${CALC_WIN}"
		assert "C1 ran in background" \
			"$(is_background "$(compare "${RUN}/C1.capture.before.json" "${RUN}/C1.capture.after.json")")" "true"
	else
		log "    FAIL C1 no png produced"
		FAIL=$((FAIL + 1))
	fi
fi

log ""
log "--- C2: semantic AX action on the non-frontmost target ---"
clear_calc "C2.clear"
press_id "C2.two" '^Two$'
press_id "C2.add" '^Add$'
press_id "C2.three" '^Three$'
press_id "C2.equals" '^Equals$'
sleep 0.5
log "    display: $(calc_display)"
assert "C2 background arithmetic 2+3=5" "$(calc_result)" "5"
assert "C2 stayed in background across the whole sequence" \
	"$(is_background "$(compare "${RUN}/C2.two.before.json" "${RUN}/C2.equals.after.json")")" "true"

log ""
log "--- C3: PID-routed keyboard to the non-frontmost target ---"
clear_calc "C3.clear"
sleep 0.3
snap "${RUN}/C3.before.json"
probe pid-key --pid "${CALC_PID}" --text "8" >"${RUN}/C3.key8.json" 2>&1
sleep 0.3
probe pid-key --pid "${CALC_PID}" --text "1" >"${RUN}/C3.key1.json" 2>&1
sleep 0.6
snap "${RUN}/C3.after.json"
log "    key out: $(cat "${RUN}/C3.key8.json")"
C3_DISPLAY="$(calc_display)"
log "    display after PID-routed '8','1': ${C3_DISPLAY}"
assert "C3 PID-routed keyboard reached the background app" "${C3_DISPLAY}" "81"
assert "C3 stayed in background" \
	"$(is_background "$(compare "${RUN}/C3.before.json" "${RUN}/C3.after.json")")" "true"

log ""
log "--- C4: PID-routed coordinate click on the non-frontmost target ---"
clear_calc "C4.clear"
sleep 0.4
C4_BEFORE="$(calc_display)"
C4_PT="$(button_point '^Nine$')"
if [[ -n "${C4_PT}" ]]; then
	C4_X="${C4_PT% *}"
	C4_Y="${C4_PT#* }"
	log "    Nine button centre: ${C4_X},${C4_Y}"
	log "    display before PID-routed click: ${C4_BEFORE} (expect 0 after clear)"
	action "C4.pidclick" pid-click --pid "${CALC_PID}" --x "${C4_X}" --y "${C4_Y}"
	sleep 0.5
	C4_AFTER="$(calc_display)"
	log "    display after  PID-routed click: ${C4_AFTER} (would be 9 if it took effect)"
	assert "C4 PID-routed coordinate click stayed in background" \
		"$(is_background "$(compare "${RUN}/C4.pidclick.before.json" "${RUN}/C4.pidclick.after.json")")" "true"
	# Recorded rather than asserted: whether a background pointer event is
	# honoured is app-dependent, and this line is the measurement.
	log "    C4 RESULT: PID-routed pointer click $([[ "$C4_AFTER" == "9" ]] && echo 'TOOK EFFECT' || echo 'had NO effect') on a background app"
else
	log "    SKIP C4: Nine button not found"
fi

# === TEST D — FOREGROUND ===================================================

log ""
log "================ TEST D — FOREGROUND ================"
log ""
log "--- D1: explicit activation, then a global coordinate click ---"
action "D1.activate" activate --pid "${CALC_PID}"
sleep 0.8
assert "D1 activation changed the frontmost app" \
	"$(field "$(compare "${RUN}/D1.activate.before.json" "${RUN}/D1.activate.after.json")" frontmostChanged)" "True"

clear_calc "D1.clear"
D1_PT="$(button_point '^Seven$')"
if [[ -n "${D1_PT}" ]]; then
	D1_X="${D1_PT% *}"
	D1_Y="${D1_PT#* }"
	log "    Seven button centre: ${D1_X},${D1_Y}"
	# Park the cursor somewhere else first. Without this the "did the cursor
	# move" assertion is vacuous whenever the cursor already happens to sit on
	# the target — which is exactly the false pass this suite produced before.
	probe move-cursor --x 100 --y 100 >/dev/null 2>&1
	sleep 0.5
	action "D1.globalclick" global-click --x "${D1_X}" --y "${D1_Y}"
	sleep 0.4
	log "    display after global click: $(calc_display)"
	D1C_ENV="$(compare "${RUN}/D1.globalclick.before.json" "${RUN}/D1.globalclick.after.json")"
	log "    env: ${D1C_ENV}"
	# A global click is expected to move the physical cursor *to the target*.
	# Asserting the exact destination is what distinguishes the foreground path
	# from the background one.
	assert "D1 global click moved the physical cursor to the click point (foreground signature)" \
		"$(python3 -c 'import json,sys;d=json.loads(sys.argv[1])["cursorAfter"];print("%d,%d" % (d[0],d[1]))' "${D1C_ENV}")" \
		"${D1_X},${D1_Y}"
	assert "D1 global click press took effect" "$(calc_result)" "7"
fi

log ""
log "--- D2: foreground typing into a real document ---"
probe activate --pid "${TE_PID}" >/dev/null 2>&1
sleep 1.5
# Dismiss TextEdit's open panel (Escape targeted at its pid), then new document.
probe pid-key --pid "${TE_PID}" --keycode 53 >"${RUN}/D2.escape.json" 2>&1 || true
sleep 0.4
probe ax-press --pid "${TE_PID}" --role AXButton --identifier-regex '^(Cancel|CancelButton)$' \
	--max-nodes 4000 >/dev/null 2>&1 || true
sleep 0.5
probe hotkey --keycode 45 --modifiers cmd >"${RUN}/D2.cmdn.json" 2>&1
sleep 1.5
# Clear the document so this assertion cannot be satisfied by leftover content
# from a previous run.
probe hotkey --keycode 0 --modifiers cmd >"${RUN}/D2.selectall.json" 2>&1
sleep 0.3
probe pid-key --pid "${TE_PID}" --keycode 51 >"${RUN}/D2.delete.json" 2>&1 || true
sleep 0.5
D2_BEFORE="$(text_area_value "${TE_PID}")"
log "    text area after clearing: '${D2_BEFORE}'"
# A unique marker proves the typed characters are the ones we just sent.
D2_MARKER="zcua-$(date +%H%M%S)"
action "D2.type" type-global --text "${D2_MARKER}"
sleep 1.0
D2_AFTER="$(text_area_value "${TE_PID}")"
log "    text area after  typing: '${D2_AFTER}' (sent '${D2_MARKER}')"
assert "D2 foreground typing reached the document intact" "${D2_AFTER}" "${D2_MARKER}"

log ""
log "--- D3: control for C4 — same PID-routed click, but target IS frontmost ---"
log "    This separates 'PID-routed pointer events never work' from"
log "    'PID-routed pointer events do not work in the background'."
if [[ -n "${D1_PT:-}" ]]; then
	# Calculator is frontmost here (from D2 it was TextEdit, so re-activate).
	probe activate --pid "${CALC_PID}" >/dev/null 2>&1
	sleep 0.8
	clear_calc "D3.clear"
	sleep 0.4
	D3_BEFORE="$(calc_display)"
	D3_PT="$(button_point '^Nine$')"
	if [[ -n "${D3_PT}" ]]; then
		D3_X="${D3_PT% *}"
		D3_Y="${D3_PT#* }"
		log "    display before PID-routed click (frontmost): ${D3_BEFORE}"
		probe pid-click --pid "${CALC_PID}" --x "${D3_X}" --y "${D3_Y}" \
			>"${RUN}/D3.pidclick.json" 2>&1
		sleep 0.5
		D3_AFTER="$(calc_display)"
		log "    display after  PID-routed click (frontmost): ${D3_AFTER} (would be 9 if it took effect)"
		log "    D3 RESULT: PID-routed pointer click $([[ "$D3_AFTER" == "9" ]] && echo 'TOOK EFFECT' || echo 'had NO effect') on the frontmost app"
	fi
fi

# === TEST E — USER INTERRUPTION ===========================================

log ""
log "================ TEST E — USER INTERRUPTION ================"
log ""
log "--- E1: does a listen-only global tap see our GLOBAL synthetic events? ---"
# Three spaced global clicks during a 4s window, so a single dropped event
# cannot make this read as a false negative.
(
	sleep 1
	probe global-click --x 500 --y 500 >/dev/null 2>&1
	sleep 1
	probe global-click --x 520 --y 520 >/dev/null 2>&1
	sleep 1
	probe global-click --x 540 --y 540 >/dev/null 2>&1
) &
probe watch --seconds 4 >"${RUN}/E1.watch-global.json" 2>&1
log "    $(cat "${RUN}/E1.watch-global.json")"
E1_SYN="$(field "$(cat "${RUN}/E1.watch-global.json")" syntheticEvents 2>/dev/null)"
assert "E1 tap saw our global synthetic events (tap live + self-tagging works)" \
	"$([[ "${E1_SYN:-0}" -gt 0 ]] && echo true || echo false)" "true"

log ""
log "--- E2: does the same tap see PID-ROUTED events? ---"
(sleep 1; probe pid-key --pid "${CALC_PID}" --text "7" >/dev/null 2>&1; probe pid-click --pid "${CALC_PID}" --x 300 --y 700 >/dev/null 2>&1) &
probe watch --seconds 3 >"${RUN}/E2.watch-pid.json" 2>&1
log "    $(cat "${RUN}/E2.watch-pid.json")"
# A missing or failed watch must not be read as "zero events observed". An
# earlier revision defaulted the count to 0 and reported a PASS for a test whose
# subject never ran.
E2_COUNTS="$(python3 - "${RUN}/E2.watch-pid.json" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print("ERR")
    raise SystemExit
if d.get("ok") is not True or "physicalEvents" not in d or "syntheticEvents" not in d:
    print("ERR")
    raise SystemExit
print(int(d["physicalEvents"]) + int(d["syntheticEvents"]))
PY
)"
assert "E2 event tap actually ran (guards against a vacuous pass)" \
	"$([[ "${E2_COUNTS}" == "ERR" ]] && echo missing || echo present)" "present"
assert "E2 PID-routed input is invisible to the global tap" "${E2_COUNTS}" "0"

# === RESULT =================================================================

log ""
log "================ SUITE COMPLETE ================"
log "assertions passed: ${PASS}"
log "assertions failed: ${FAIL}"
log "evidence: ${RUN}"
[[ "${FAIL}" -eq 0 ]] && exit 0 || exit 1
