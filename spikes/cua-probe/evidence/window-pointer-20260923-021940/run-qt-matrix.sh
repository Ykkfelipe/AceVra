#!/usr/bin/env bash
set -uo pipefail
cd "/Users/felipemore/Projects/ZCode-Fork-cua/spikes/cua-probe"
export RUN_DIR="/Users/felipemore/Projects/ZCode-Fork-cua/spikes/cua-probe/evidence/window-pointer-20260923-021940"
PROBE='/Users/felipemore/Projects/ZCode-Fork-cua/spikes/cua-probe/build/ZCode CUA Probe.app/Contents/MacOS/ZCodeCuaProbe'
DRV=~/.zcode-fork-cua-home/tools/cua-driver-rs-0.28.2-darwin-arm64/cua-driver
ensure() {
  if ! pgrep -qf "Prism Launcher.app/Contents/MacOS/prismlauncher"; then
    echo "relaunching Prism Launcher"
    open -g -a "/Applications/Prism Launcher.app"; sleep 5
  fi
}
run_trial() {
  local LABEL="$1" TOOL="$2" JSON="$3"
  ensure
  local PID WID
  PID=$($PROBE windows --all 2>/dev/null | grep -i '"owner":"Prism' | python3 -c 'import sys,json
for l in sys.stdin:
    d=json.loads(l)
    if d.get("title"): print(d["pid"]); break')
  WID=$($PROBE windows --all 2>/dev/null | grep -i '"owner":"Prism' | python3 -c 'import sys,json
for l in sys.stdin:
    d=json.loads(l)
    if d.get("title"): print(d["id"]); break')
  [[ -z "$PID" ]] && { echo "P-$LABEL no window"; return; }
  echo "----- P-$LABEL [$TOOL] pid=$PID wid=$WID"
  VERIFY_CMD="$PROBE ax-get --pid $PID --role AXCheckBox --attribute AXValue"   GATE_SECONDS=75 AX_LABEL_PREFIX=Meow \
    ./run-pointer-trial.sh "P-$LABEL" "$PID" "$WID" "$TOOL" "$JSON"
  echo "      P-$LABEL action=$(tr -d '\n' < "/Users/felipemore/Projects/ZCode-Fork-cua/spikes/cua-probe/evidence/window-pointer-20260923-021940/P-$LABEL.action.json" 2>/dev/null | head -c 260)"
  echo "      P-$LABEL checkbox before=$(cat "/Users/felipemore/Projects/ZCode-Fork-cua/spikes/cua-probe/evidence/window-pointer-20260923-021940/P-$LABEL.verify.before.txt" 2>/dev/null | head -c 200)"
  echo "      P-$LABEL checkbox after =$(cat "/Users/felipemore/Projects/ZCode-Fork-cua/spikes/cua-probe/evidence/window-pointer-20260923-021940/P-$LABEL.verify.after.txt" 2>/dev/null | head -c 200)"
  echo "      P-$LABEL watch=$(cat "/Users/felipemore/Projects/ZCode-Fork-cua/spikes/cua-probe/evidence/window-pointer-20260923-021940/P-$LABEL.watch.json" 2>/dev/null | head -c 170)"
  [[ -f "/Users/felipemore/Projects/ZCode-Fork-cua/spikes/cua-probe/evidence/window-pointer-20260923-021940/P-$LABEL.aborted.txt" ]] && echo "      P-$LABEL $(cat "/Users/felipemore/Projects/ZCode-Fork-cua/spikes/cua-probe/evidence/window-pointer-20260923-021940/P-$LABEL.aborted.txt")"
}
# Coordinates: the "Meow" AXCheckBox is at screen (849,169) 42x42; the window is
# at (335,136) with screenshot_scale 2, so its centre is shot px (1070,108).
run_trial AX1  click        '{"pid":$PID,"element_token":"@AUTO","delivery_mode":"background"}'
run_trial PX1  click        '{"pid":$PID,"window_id":$WID,"x":1070,"y":108,"delivery_mode":"background"}'
run_trial DBL1 double_click '{"pid":$PID,"window_id":$WID,"x":1070,"y":108,"delivery_mode":"background"}'
run_trial FG1  click        '{"pid":$PID,"window_id":$WID,"x":1070,"y":108,"delivery_mode":"foreground"}'
echo "----- qt matrix complete"
