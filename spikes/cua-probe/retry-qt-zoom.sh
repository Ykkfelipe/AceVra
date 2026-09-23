#!/usr/bin/env bash
# Repeat the Qt title-bar zoom trial until one attempt runs in a genuinely quiet
# bracket.
#
# Why the title bar: it is the one Qt surface on this machine that is NOT
# AX-actionable (the AXWindow exposes only AXRaise), so the driver is forced
# onto the pointer route; and its postcondition is the window frame, which is
# multi-valued. A binary toggle could not distinguish "two clicks landed" from
# "nothing landed"; a frame change cannot be produced by zero clicks.
#
# An attempt counts only when BOTH hold:
#   - the driver reported a route (the action actually ran), and
#   - the event tap saw no physical input during the bracket (this machine has a
#     human user driving it, so an unclean bracket cannot be attributed).
#
# Usage: retry-qt-zoom.sh <run_dir> [attempts]

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="${SCRIPT_DIR}/build/ZCode CUA Probe.app/Contents/MacOS/ZCodeCuaProbe"
DRV="${DRV:-$HOME/.zcode-fork-cua-home/tools/cua-driver-rs-0.28.2-darwin-arm64/cua-driver}"
RUN_DIR="${1:?run_dir}"
ATTEMPTS="${2:-5}"
export RUN_DIR

PID="$(pgrep -f 'Prism Launcher.app/Contents/MacOS/prismlauncher' | head -1)"
[[ -z "${PID}" ]] && { echo "Qt target not running"; exit 1; }

for n in $(seq 1 "${ATTEMPTS}"); do
  LABEL="Q2-BGZOOM-${n}"
  WID="$("${PROBE}" windows --all 2>/dev/null | python3 -c '
import json, sys
best = None
for line in sys.stdin:
    try: d = json.loads(line)
    except Exception: continue
    if d.get("pid") == int(sys.argv[1]) and d.get("title"):
        best = d
print(best["id"] if best else "")' "${PID}")"
  [[ -z "${WID}" ]] && { echo "no Qt window"; exit 1; }

  # Screenshot must go to a real directory: the driver refuses a path whose
  # ancestor is a symlink, and /tmp is one on macOS.
  COORDS="$("${DRV}" call get_window_state \
    "{\"pid\":${PID},\"window_id\":${WID},\"screenshot_out_file\":\"${RUN_DIR}/qt-point-${n}.png\",\"max_elements\":20}" 2>/dev/null \
    | python3 "${SCRIPT_DIR}/qt-helper.py" point 2>/dev/null)"
  if [[ -z "${COORDS}" ]]; then echo "attempt ${n}: could not resolve window geometry"; sleep 2; continue; fi
  SX="${COORDS% *}"; SY="${COORDS#* }"

  BEFORE="$("${PROBE}" ax-get --pid "${PID}" --role AXWindow --attribute AXSize 2>/dev/null | python3 "${SCRIPT_DIR}/qt-helper.py" size 2>/dev/null)"

  echo "--- attempt ${n}: window=${WID} title-bar shot px=(${SX},${SY}) size_before=${BEFORE}"
  VERIFY_CMD="\"${PROBE}\" ax-get --pid ${PID} --role AXWindow --attribute AXPosition; \"${PROBE}\" ax-get --pid ${PID} --role AXWindow --attribute AXSize" \
  GATE_SECONDS=45 \
    "${SCRIPT_DIR}/run-pointer-trial.sh" "${LABEL}" "${PID}" "${WID}" double_click \
    "{\"pid\":${PID},\"window_id\":${WID},\"x\":${SX},\"y\":${SY},\"delivery_mode\":\"background\"}"

  SUMMARY="$(python3 "${SCRIPT_DIR}/qt-helper.py" action < "${RUN_DIR}/${LABEL}.action.json" 2>/dev/null || echo 'action=missing')"
  PHYS="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("physicalEvents","?"))' \
    "${RUN_DIR}/${LABEL}.watch.json" 2>/dev/null)"
  AFTER="$("${PROBE}" ax-get --pid "${PID}" --role AXWindow --attribute AXSize 2>/dev/null | python3 "${SCRIPT_DIR}/qt-helper.py" size 2>/dev/null)"
  echo "      ${SUMMARY}"
  echo "      size ${BEFORE} -> ${AFTER}   physicalEvents=${PHYS}"

  if [[ "${SUMMARY}" == *"ok=True"* && "${PHYS}" == "0" && "${BEFORE}" != "${AFTER}" ]]; then
    echo "      CLEAN + EFFECTIVE on attempt ${n} -> ${LABEL}"
    break
  fi
done
echo "--- retry complete"
