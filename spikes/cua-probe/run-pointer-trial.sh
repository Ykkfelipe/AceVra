#!/usr/bin/env bash
# One guarded background-pointer trial.
#
# A returned success code is not evidence. This runner brackets every action
# with the five environment invariants the experiment must hold, plus a
# listen-only event tap that reveals whether a *human* touched the machine
# during the bracket. A trial whose bracket saw physical input is contaminated
# and is reported as such rather than as a result.
#
# This machine has a human user driving it throughout the experiment, so the
# runner waits for a genuinely quiet window instead of forcing one: demoting the
# target ourselves would steal focus and invalidate the very measurement.
#
# Usage:
#   run-pointer-trial.sh <label> <pid> <window_id> <driver_tool> <driver_json>
#
# driver_json may contain the literal @AUTO, which is replaced by the token of
# the first AX element whose label starts with $AX_LABEL_PREFIX (default
# "CLICKED"). The snapshot is taken *after* the gate because the driver fails
# closed on a token superseded by any newer snapshot of the same window.
#
# Artefacts written into $RUN_DIR:
#   <label>.before.json / .after.json     probe state (frontmost, cursor, z-order)
#   <label>.before.png  / .after.png      window-scoped ScreenCaptureKit capture
#   <label>.before.windows / .after.windows
#   <label>.action.json                   raw cua-driver response
#   <label>.watch.json                    event-tap counters across the bracket
#   <label>.gate.json                     why the gate opened

set -uo pipefail

LABEL="${1:?label}"
PID="${2:?pid}"
WID="${3:?window_id}"
TOOL="${4:?driver_tool}"
DJSON="${5:-{\}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="${SCRIPT_DIR}/build/ZCode CUA Probe.app/Contents/MacOS/ZCodeCuaProbe"
DRV="${DRV:-$HOME/.zcode-fork-cua-home/tools/cua-driver-rs-0.28.2-darwin-arm64/cua-driver}"
RUN_DIR="${RUN_DIR:?RUN_DIR must be set}"

mkdir -p "${RUN_DIR}"
state() { "${PROBE}" state; }
windows() { "${PROBE}" windows --all; }
front_pid() { state 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["frontmost"]["pid"])' 2>/dev/null; }
cursor_xy() { state 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin)["cursor"]; print("%.1f,%.1f" % (d["x"], d["y"]))' 2>/dev/null; }

# 0. Background gate: wait for a window in which the target is not frontmost,
#    the hardware cursor is parked, and the tap sees no human input at all.
DEADLINE=$((SECONDS + ${GATE_SECONDS:-120}))
GATE_OK=0
while (( SECONDS < DEADLINE )); do
  [[ "$(front_pid)" == "${PID}" ]] && { sleep 1; continue; }

  C1="$(cursor_xy)"; sleep 1; C2="$(cursor_xy)"
  [[ "${C1}" != "${C2}" ]] && continue

  "${PROBE}" watch --seconds 2 > "${RUN_DIR}/${LABEL}.gate-watch.json" 2>&1
  PHYS="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("physicalEvents"))' \
    "${RUN_DIR}/${LABEL}.gate-watch.json" 2>/dev/null)"
  if [[ "${PHYS}" == "0" ]] && [[ "$(front_pid)" != "${PID}" ]]; then
    GATE_OK=1
    printf '{"gate":"clean","cursor":"%s","frontmost_pid":"%s","physicalEvents":0}\n' \
      "${C2}" "$(front_pid)" > "${RUN_DIR}/${LABEL}.gate.json"
    break
  fi
done

if (( GATE_OK == 0 )); then
  echo "trial ${LABEL} ABORTED: no quiet non-frontmost window within ${GATE_SECONDS:-120}s" \
    > "${RUN_DIR}/${LABEL}.aborted.txt"
  exit 0
fi

# 0c. Optional target-specific independent readback (VERIFY_CMD). This is how a
#     Qt/AX-visible state is read back without involving the driver at all.
if [[ -n "${VERIFY_CMD:-}" ]]; then
  eval "${VERIFY_CMD}" > "${RUN_DIR}/${LABEL}.verify.before.txt" 2>&1
fi

# 0b. AX addressing: fresh snapshot now that the gate has opened.
if [[ "${DJSON}" == *"@AUTO"* ]]; then
  SNAP="$("${DRV}" call get_window_state \
    "{\"pid\":${PID},\"window_id\":${WID},\"include_screenshot\":false,\"max_elements\":600}" 2>&1)"
  printf '%s\n' "${SNAP}" > "${RUN_DIR}/${LABEL}.snapshot.json"
  TOKEN="$(printf '%s' "${SNAP}" | AX_LABEL_PREFIX="${AX_LABEL_PREFIX:-CLICKED}" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
sc = d.get("structuredContent", d)
prefix = os.environ["AX_LABEL_PREFIX"]
for e in sc.get("elements") or []:
    if str(e.get("label") or "").startswith(prefix):
        print(e["element_token"]); break
')"
  if [[ -z "${TOKEN}" ]]; then
    echo "no AX element with label prefix ${AX_LABEL_PREFIX:-CLICKED}" \
      > "${RUN_DIR}/${LABEL}.aborted.txt"
    exit 0
  fi
  DJSON="${DJSON//@AUTO/${TOKEN}}"
  printf '%s\n' "${DJSON}" > "${RUN_DIR}/${LABEL}.resolved.json"
fi

# 1. Before.
state > "${RUN_DIR}/${LABEL}.before.json" 2>&1
"${PROBE}" shot --window "${WID}" --out "${RUN_DIR}/${LABEL}.before.png" \
  > "${RUN_DIR}/${LABEL}.before.shot.json" 2>&1
windows > "${RUN_DIR}/${LABEL}.before.windows" 2>&1

# 2. Listen-only tap across the bracket.
"${PROBE}" watch --seconds 5 > "${RUN_DIR}/${LABEL}.watch.json" 2>&1 &
WATCH_PID=$!

# 3. The action under test.
sleep 0.7
"${DRV}" call "${TOOL}" "${DJSON}" > "${RUN_DIR}/${LABEL}.action.json" 2>&1

# 4. After.
state > "${RUN_DIR}/${LABEL}.after.json" 2>&1
windows > "${RUN_DIR}/${LABEL}.after.windows" 2>&1
if [[ -n "${VERIFY_CMD:-}" ]]; then
  eval "${VERIFY_CMD}" > "${RUN_DIR}/${LABEL}.verify.after.txt" 2>&1
fi
"${PROBE}" shot --window "${WID}" --out "${RUN_DIR}/${LABEL}.after.png" \
  > "${RUN_DIR}/${LABEL}.after.shot.json" 2>&1

wait "${WATCH_PID}" 2>/dev/null

echo "trial ${LABEL} complete -> ${RUN_DIR}"
