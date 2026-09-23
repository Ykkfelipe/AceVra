#!/usr/bin/env bash
# Qt-class background-pointer matrix.
#
# The Qt target (Prism Launcher) is the only Qt6/QtWidgets application installed
# on this machine and it terminates unpredictably within seconds-to-minutes of
# launch (no crash report, no shutdown sequence in its own log), so this driver
# launches it with `launch_app` — which does NOT front the target, unlike
# `open` — waits for its window, and then runs each trial immediately with a
# short gate. A trial whose target vanished is reported as missed, not retried
# silently.
#
# Usage: run-qt-matrix.sh <run_dir>

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="${SCRIPT_DIR}/build/ZCode CUA Probe.app/Contents/MacOS/ZCodeCuaProbe"
DRV="${DRV:-$HOME/.zcode-fork-cua-home/tools/cua-driver-rs-0.28.2-darwin-arm64/cua-driver}"
RUN_DIR="${1:?run_dir}"
export RUN_DIR

pid_of_target() {
  "${PROBE}" windows --all 2>/dev/null | python3 -c '
import json, sys
best = None
for line in sys.stdin:
    try: d = json.loads(line)
    except Exception: continue
    if str(d.get("owner","")).startswith("Prism") and d.get("title"):
        best = d
print(best["pid"] if best else "")
'
}
wid_of_target() {
  "${PROBE}" windows --all 2>/dev/null | python3 -c '
import json, sys
best = None
for line in sys.stdin:
    try: d = json.loads(line)
    except Exception: continue
    if str(d.get("owner","")).startswith("Prism") and d.get("title"):
        best = d
print(best["id"] if best else "")
'
}

ensure_target() {
  if ! pgrep -qf "Prism Launcher.app/Contents/MacOS/prismlauncher"; then
    echo "  launch_app: Prism Launcher"
    "${DRV}" call launch_app '{"bundle_id":"org.prismlauncher.PrismLauncher"}' >/dev/null 2>&1
  fi
  for _ in $(seq 1 20); do
    [[ -n "$(wid_of_target)" ]] && return 0
    sleep 2
  done
  return 1
}

run_trial() {
  local LABEL="$1" TOOL="$2" JSON_TPL="$3"
  ensure_target || { echo "----- P-${LABEL}: no Qt window available"; return; }
  local PID WID
  PID="$(pid_of_target)"; WID="$(wid_of_target)"
  [[ -z "${PID}" ]] && { echo "----- P-${LABEL}: no Qt window available"; return; }

  # The "Meow" AXCheckBox is at screen (849,169) 42x42 in an 800x632 window at
  # (335,136) with screenshot_scale 2, so its centre is shot px (1070,108).
  local JSON="${JSON_TPL//@PID/${PID}}"
  JSON="${JSON//@WID/${WID}}"

  echo "----- P-${LABEL} [${TOOL}] pid=${PID} wid=${WID}"
  # Quoted so the eval inside the trial runner survives the space in the path.
  VERIFY_CMD="\"${PROBE}\" ax-get --pid ${PID} --role AXCheckBox --attribute AXValue" \
  GATE_SECONDS="${QT_GATE_SECONDS:-25}" AX_LABEL_PREFIX=Meow \
    "${SCRIPT_DIR}/run-pointer-trial.sh" "P-${LABEL}" "${PID}" "${WID}" "${TOOL}" "${JSON}"

  echo "      action : $(tr -d '\n' < "${RUN_DIR}/P-${LABEL}.action.json" 2>/dev/null | head -c 300)"
  echo "      checkbx: before=$(cat "${RUN_DIR}/P-${LABEL}.verify.before.txt" 2>/dev/null | head -c 240)"
  echo "      checkbx: after =$(cat "${RUN_DIR}/P-${LABEL}.verify.after.txt" 2>/dev/null | head -c 240)"
  echo "      watch  : $(cat "${RUN_DIR}/P-${LABEL}.watch.json" 2>/dev/null | head -c 180)"
  [[ -f "${RUN_DIR}/P-${LABEL}.aborted.txt" ]] && echo "      ! $(cat "${RUN_DIR}/P-${LABEL}.aborted.txt")"
}

run_trial AX1  click        '{"pid":@PID,"element_token":"@AUTO","delivery_mode":"background"}'
run_trial PX1  click        '{"pid":@PID,"window_id":@WID,"x":1070,"y":108,"delivery_mode":"background"}'
run_trial DBL1 double_click '{"pid":@PID,"window_id":@WID,"x":1070,"y":108,"delivery_mode":"background"}'
run_trial FG1  click        '{"pid":@PID,"window_id":@WID,"x":1070,"y":108,"delivery_mode":"foreground"}'
echo "----- qt matrix complete"
