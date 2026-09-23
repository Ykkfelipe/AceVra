#!/usr/bin/env bash
# Matrix driver: runs one target's trial list through run-pointer-trial.sh.
#
# Each line of the list is: <label>|<tool>|<json-args>
# Between trials the previous trial's window title (the page's own counter, read
# back through CGWindowList rather than through any automation API) is logged so
# the transcript carries the independent readback next to the driver's claim.
#
# Usage: run-matrix.sh <pid> <window_id> <trials_file>

set -uo pipefail

PID="${1:?pid}"
WID="${2:?window_id}"
LIST="${3:?trials_file}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="${SCRIPT_DIR}/build/ZCode CUA Probe.app/Contents/MacOS/ZCodeCuaProbe"

title_of() {
  "${PROBE}" windows --all 2>/dev/null | WID="${WID}" python3 -c '
import json, os, sys
wid = int(os.environ["WID"])
for line in sys.stdin:
    try: w = json.loads(line)
    except Exception: continue
    if w.get("id") == wid:
        print(w.get("title")); break
'
}

while IFS='|' read -r LABEL TOOL JSON; do
  [[ -z "${LABEL}" || "${LABEL}" == \#* ]] && continue
  echo "----- ${LABEL} [${TOOL}] before_title=$(title_of)"
  AX_LABEL_PREFIX="${AX_LABEL_PREFIX:-CLICK}" "${SCRIPT_DIR}/run-pointer-trial.sh" \
    "${LABEL}" "${PID}" "${WID}" "${TOOL}" "${JSON}"
  echo "      ${LABEL} action=$(tr -d '\n' < "${RUN_DIR}/${LABEL}.action.json" 2>/dev/null | head -c 300)"
  echo "      ${LABEL} after_title=$(title_of)"
  echo "      ${LABEL} watch=$(cat "${RUN_DIR}/${LABEL}.watch.json" 2>/dev/null | tr -d '\n' | head -c 200)"
  [[ -f "${RUN_DIR}/${LABEL}.aborted.txt" ]] && echo "      ${LABEL} $(cat "${RUN_DIR}/${LABEL}.aborted.txt")"
done < "${LIST}"
echo "----- matrix complete"
