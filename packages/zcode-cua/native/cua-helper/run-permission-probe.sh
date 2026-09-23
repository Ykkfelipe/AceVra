#!/usr/bin/env bash
# Run one helper observation and archive everything needed to attribute its permissions.
#
# A permission reading is meaningless without the launch path that produced it: macOS
# attributes TCC grants to the *responsible process*, so "the helper reports
# accessibility: true" is only interpretable together with how the helper was started and
# which identity that process tree resolves to.
#
# Modes:
#   exec : run the helper binary directly, as a child of this shell. This is the
#          inheritance path — the responsible process is whatever app is responsible for
#          this shell, which the log names explicitly.
#   open : launch the bundle through LaunchServices (`/usr/bin/open -n`), the path the
#          shipping contract uses. Here the helper is its own responsible process.
#
# Both modes pass --launcher-pid, mirroring the argument shape the contract documents, so
# the helper can report what it received. Whether that argument confers any permission is
# something to measure, not assume.
#
# Usage: run-permission-probe.sh <label> <exec|open> [helper args...]

set -uo pipefail

LABEL="${1:?label}"
MODE="${2:?exec|open}"
shift 2

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CUA_HOME="${ZCODE_CUA_HOME:-$HOME/.zcode-fork-cua-home}"
ZCODE_HOME="${ZCODE_HOME:-$CUA_HOME/.zcode}"
APP="$ZCODE_HOME/computer-use/dev/ZCode Computer Use Dev.app"
BIN="$APP/Contents/MacOS/ZCodeComputerUseDev"
OUT_DIR="${OUT_DIR:?OUT_DIR must be set}"

mkdir -p "$OUT_DIR"
REPORT="$OUT_DIR/$LABEL.report.json"
LOG="$OUT_DIR/$LABEL.log"

# Delete first: LaunchServices returns before the app writes, and a report left over from
# an earlier run would otherwise be read as this run's result. The helper writes
# atomically, so the file is either absent or complete.
rm -f "$REPORT"

{
  echo "### label=$LABEL mode=$MODE at $(date -u +%FT%TZ)"
  echo "### helper bundle: $APP"
  echo "### helper source sha256: $(shasum -a 256 "$HERE/main.swift" | awk '{print $1}')"
  echo "### helper binary sha256: $(shasum -a 256 "$BIN" | awk '{print $1}')"
  echo "### launch command: /usr/bin/open -n <bundle> --args --launcher-pid <this shell> --report $REPORT"
  echo "### ancestry of this harness, with the identity each pid resolves to:"
  # `ps` alone cannot name an app: the ZCode main process reports comm="ZCode" with no
  # path, which is why the first version of this walk printed "no app bundle in ancestry".
  # lsappinfo resolves a pid to its bundle id, which is the identity TCC actually uses.
  pid=$$
  for _ in $(seq 1 12); do
    comm="$(ps -o comm= -p "$pid" 2>/dev/null)"
    [[ -z "$comm" ]] && break
    bundle="$(lsappinfo info -only bundleid -app "$pid" 2>/dev/null | sed -n 's/.*bundleID="\([^"]*\)".*/\1/p')"
    echo "    pid=$pid comm=$comm bundleId=${bundle:-<none>}"
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    [[ -z "$ppid" || "$ppid" == "1" || "$ppid" == "$pid" ]] && break
    pid="$ppid"
  done
} > "$LOG" 2>&1

if [[ "$MODE" == "exec" ]]; then
  "$BIN" --launcher-pid "$$" --report "$REPORT" "$@" > "$OUT_DIR/$LABEL.stdout.json" 2>> "$LOG"
  echo "### exec exit=$?" >> "$LOG"
elif [[ "$MODE" == "open" ]]; then
  /usr/bin/open -n "$APP" --args --launcher-pid "$$" --report "$REPORT" "$@" >> "$LOG" 2>&1
  echo "### open exit=$?" >> "$LOG"
  for _ in $(seq 1 80); do
    [[ -s "$REPORT" ]] && break
    sleep 0.25
  done
else
  echo "unknown mode: $MODE" >&2
  exit 2
fi

{
  echo "### helper process tree at observation time:"
  ps -eo pid,ppid,command | grep -F "ZCodeComputerUseDev" | grep -v grep | sed 's/^/    /' || true
  echo "### helper bundle signature:"
  codesign -dv --verbose=3 "$APP" 2>&1 | grep -E "Identifier|CandidateCDHashFull|TeamIdentifier|Authority" | sed 's/^/    /'
  codesign -d -r- "$APP" 2>&1 | grep "=>" | sed 's/^/    /'
} >> "$LOG" 2>&1

echo "probe $LABEL ($MODE) done:"
python3 "$HERE/show-report.py" "$REPORT" "$LABEL"
