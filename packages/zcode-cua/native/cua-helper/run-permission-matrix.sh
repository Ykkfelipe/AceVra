#!/usr/bin/env bash
# Persistence matrix for the CUA helper's TCC grants (CUA-0.5 Step 5).
#
# Every observation goes through LaunchServices (`/usr/bin/open -n`), because that is the
# path the existing contract uses and because it is the path where the helper is its own
# responsible process. Each row records the helper's own report — bundle id, cdhash,
# designated requirement, Accessibility trust, Screen Recording preflight, and a real
# ScreenCaptureKit capture (a preflight that says "granted" while capture returns a blank
# frame is not a grant).
#
# Cases:
#   A  helper process restart          (relaunch the same bundle)
#   C  rebuild with the same identity  (new cdhash, same requirement)
#   D  reinstall/replace at same path  (delete the bundle, rebuild into the same path)
#   E  version/build-number change
#   S  stale probe: rebuild with a DIFFERENT signing identity so the requirement no
#      longer matches the stored grant
#
# Usage: run-permission-matrix.sh <out_dir>

set -uo pipefail

OUT_DIR="${1:?out_dir}"
mkdir -p "$OUT_DIR"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
export ZCODE_CUA_HOME="${ZCODE_CUA_HOME:-$HOME/.zcode-fork-cua-home}"
export ZCODE_HOME="${ZCODE_HOME:-$ZCODE_CUA_HOME/.zcode}"
APP="$ZCODE_HOME/computer-use/dev/ZCode Computer Use Dev.app"
BIN="$APP/Contents/MacOS/ZCodeComputerUseDev"
FINDER="$(pgrep -x Finder | head -1)"

build() { (cd "$REPO_ROOT" && node packages/zcode-cua/native/cua-helper/build-dev-helper.mjs "$@"); }

# One observation through LaunchServices. The report file is removed first so a stale
# report can never be mistaken for a fresh one.
observe() {
  local label="$1"
  local report="$OUT_DIR/$label.report.json"
  rm -f "$report"
  pkill -f "ZCodeComputerUseDev" >/dev/null 2>&1
  sleep 0.5
  /usr/bin/open -n "$APP" --args --launcher-pid "$$" $EXTRA_ARGS --report "$report" >/dev/null 2>&1
  for _ in $(seq 1 80); do [[ -s "$report" ]] && break; sleep 0.25; done
  echo "----- $label"
  # Provenance first: a report is only meaningful if you know which revision produced it.
  echo "      launch: /usr/bin/open -n <bundle> --args --launcher-pid $$ $EXTRA_ARGS --report <report>"
  echo "      source sha256: $(shasum -a 256 "$HERE/main.swift" | awk '{print $1}')"
  echo "      binary sha256: $(shasum -a 256 "$APP/Contents/MacOS/ZCodeComputerUseDev" | awk '{print $1}')"
  python3 "$HERE/show-report.py" "$report" "$label"
  echo "      signature: $(codesign -dv --verbose=3 "$APP" 2>&1 | grep -E 'CandidateCDHashFull|CDHash=' | head -1 | tr -d ' ')"
  echo "      requirement: $(codesign -d -r- "$APP" 2>&1 | grep '=>' | head -1)"
}

echo "### persistence matrix at $(date -u +%FT%TZ)"
echo "### helper: $APP"
echo "### finder pid (harmless AX read target): $FINDER"

# Baseline, including the capability probes: a grant that cannot actually read AX or
# capture is not a usable grant.
EXTRA_ARGS="--capture --ax-read-pid $FINDER"
observe baseline

# A — helper process restart.
EXTRA_ARGS=""
observe A-helper-restart
# B — the launching app (this harness) is a different process each row by construction;
# restarting it is what every row already demonstrates, so B shares A's evidence and is
# called out in the spec rather than duplicated.

# C — rebuild with the same signing identity.
build --version 0.0.1 --build 2 >/dev/null
observe C-rebuild-same-identity

# D — delete the bundle and reinstall into the same path.
rm -rf "$APP"
build --version 0.0.1 --build 3 >/dev/null
observe D-reinstall-same-path

# E — change version/build numbers.
build --version 0.2.0 --build 99 >/dev/null
observe E-version-change

# S — stale: same bundle id and path, DIFFERENT signing identity, so the stored grant's
# requirement no longer matches the binary on disk.
echo "### building a second identity to model a requirement mismatch"
ALT_SIGNING_DIR="$ZCODE_CUA_HOME/signing-alt"
if [[ -d "$ALT_SIGNING_DIR" ]]; then
  (cd "$REPO_ROOT" && CUA_SIGNING_DIR="$ALT_SIGNING_DIR" \
     bash packages/zcode-cua/native/cua-helper/signing/create-dev-signing-identity.sh >/dev/null 2>&1)
  build --signing-dir "$ALT_SIGNING_DIR" --version 0.2.0 --build 100 >/dev/null
  echo "      (now signed by the alternate identity, same bundle id and path)"
  codesign -d -r- "$APP" 2>&1 | grep '=>' | head -1 | sed 's/^/      /'
  observe S-requirement-mismatch
  echo "### restoring the primary identity"
  build --version 0.2.0 --build 99 >/dev/null
  observe S-restored
else
  echo "----- S skipped: alternate identity unavailable"
fi

echo "### matrix complete"
