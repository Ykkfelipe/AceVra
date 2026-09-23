#!/usr/bin/env bash
# Tamper probe: what does macOS actually do to the Helper's grant when the signed
# executable is altered?
#
# This exists because the first attempt at this measurement was reported with more
# confidence than the data supported: section file offsets were derived by mixing a
# virtual address with a file offset, one case wrote past the end of the file, and no
# command was archived. Each case here records the exact command, whether the signature
# still verifies, and the resulting permission state.
#
# Cases (all through LaunchServices, the shipping launch path):
#   A  control   — untouched bundle; the granted baseline for the run
#   B  __text    — one byte changed inside executable code
#   C  __cstring — one byte changed inside string data (never executed)
#   D  append    — bytes appended past the signed code limit (structural change)
#   E  restored  — rebuilt from source, control for the restore path
#
# Usage: run-tamper-probe.sh <out_dir>

set -uo pipefail

OUT_DIR="${1:?out_dir}"
mkdir -p "$OUT_DIR"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
export ZCODE_CUA_HOME="${ZCODE_CUA_HOME:-$HOME/.zcode-fork-cua-home}"
export ZCODE_HOME="${ZCODE_HOME:-$ZCODE_CUA_HOME/.zcode}"
APP="$ZCODE_HOME/computer-use/dev/AceVra Computer Use Dev.app"
BIN="$APP/Contents/MacOS/AceVraComputerUseDev"
LOG="$OUT_DIR/tamper.log"

: > "$LOG"
say() { echo "$*" | tee -a "$LOG"; }

# Section file offsets for the first __text and __cstring. The `addr` field is a virtual
# address and only `offset` is a file offset; __text also appears in __DATA_CONST, so the
# first occurrence is the one we want.
section_offsets() {
  python3 "$HERE/tamper-offsets.py" "$BIN"
}

rebuild() {
  (cd "$REPO_ROOT" && node packages/zcode-cua/native/cua-helper/build-dev-helper.mjs >/dev/null 2>&1)
}

observe() {
  local label="$1"
  local report="$OUT_DIR/$label.report.json"
  rm -f "$report"
  say "  launch: /usr/bin/open -n \"$APP\" --args --launcher-pid \$\$ --capture --report \$OUT_DIR/$label.report.json"
  /usr/bin/open -n "$APP" --args --launcher-pid "$$" --capture --report "$report" >/dev/null 2>&1
  for _ in $(seq 1 40); do [[ -s "$report" ]] && break; sleep 0.25; done
  if [[ ! -s "$report" ]]; then
    say "  RESULT $label: NO REPORT -> the bundle did not run"
    return
  fi
  say "  RESULT $label: $(python3 "$HERE/show-report.py" "$report" "$label" | tr '\n' ' ' | sed 's/  */ /g')"
}

say "### tamper probe at $(date -u +%FT%TZ)"
say "### bundle: $APP"

OFFSETS="$(section_offsets)"
eval "$OFFSETS"
say "### $OFFSETS"

# A — control.
rebuild
say "----- A control (untouched)"
say "  codesign --verify rc=$(codesign --verify "$APP" >/dev/null 2>&1; echo $?)"
observe A-control

# B — one byte inside executable code.
rebuild
TARGET=$((TEXT_OFF + TEXT_SIZE / 2))
say "----- B __text tamper"
say "  printf '\\xff' | dd of=\$BIN bs=1 seek=$TARGET conv=notrunc"
printf '\xff' | dd of="$BIN" bs=1 seek="$TARGET" conv=notrunc 2>/dev/null
say "  codesign --verify rc=$(codesign --verify "$APP" >/dev/null 2>&1; echo $?)"
say "  binary sha256: $(shasum -a 256 "$BIN" | awk '{print $1}')"
observe B-text

# C — one byte inside string data.
rebuild
say "----- C __cstring tamper"
say "  printf '\\xff' | dd of=\$BIN bs=1 seek=$CSTRING_OFF conv=notrunc"
printf '\xff' | dd of="$BIN" bs=1 seek="$CSTRING_OFF" conv=notrunc 2>/dev/null
say "  codesign --verify rc=$(codesign --verify "$APP" >/dev/null 2>&1; echo $?)"
say "  binary sha256: $(shasum -a 256 "$BIN" | awk '{print $1}')"
observe C-cstring

# D — bytes appended past the signed code limit.
rebuild
say "----- D append past the signed code limit"
say "  printf 'TAMPER' >> \$BIN   (was $(stat -f %z "$BIN") bytes)"
printf 'TAMPER' >> "$BIN"
say "  now $(stat -f %z "$BIN") bytes"
say "  codesign --verify rc=$(codesign --verify "$APP" >/dev/null 2>&1; echo $?)"
observe D-appended

rebuild
say "----- E restored"
say "  codesign --verify rc=$(codesign --verify "$APP" >/dev/null 2>&1; echo $?)"
observe E-restored
say "### tamper probe complete"
