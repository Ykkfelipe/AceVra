#!/bin/bash
# CUA-1.5 bundle-validity measurement harness (evidence, not a test gate).
#
# Measures — with the Security framework itself, via evidence/BundleValidityProbe.swift —
# exactly what SecStaticCodeCheckValidity covers for a helper-shaped .app bundle:
#
#   A. which on-disk path the RUNNING code of a bundle executable resolves to (the scope CUA-1
#      actually validated, and why an added bundle resource went undetected);
#   B. the tamper matrix over the .app bundle and over the executable image separately:
#      pristine / modified sealed resource (Info.plist) / added unsigned file in Resources /
#      appended executable bytes / edited __text byte / valid re-sign afterwards;
#   C. requirement-anchored bundle validation (the CUA-1.5 self-check shape).
#
# The tamper cases run on a THROWAWAY bundle assembled in a scratch directory (bundle id
# dev.zcode.cua-helper.probe, signed with the same dedicated development identity) — the dev
# helper install and its TCC grants are never touched. Results print as JSON lines and are
# archived under <CUA_HOME>/evidence/bundle-validity-<timestamp>/.
#
# Usage: run-bundle-validity-probe.sh [--keep]

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CUA_HOME="${ZCODE_CUA_HOME:-$HOME/.zcode-fork-cua-home}"
SIGNING_DIR="${CUA_SIGNING_DIR:-$CUA_HOME/signing}"
KEYCHAIN="$SIGNING_DIR/acevra-cua-dev.keychain-db"
IDENTITY="AceVra CUA Dev Signing"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/cua-bundle-probe.XXXXXX")"
EVIDENCE="$CUA_HOME/evidence/bundle-validity-$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$EVIDENCE"

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

cleanup() {
  if [ "$KEEP" = "1" ]; then
    echo "[probe] scratch kept: $SCRATCH" >&2
  else
    rm -rf "$SCRATCH"
  fi
}
trap cleanup EXIT

# The dev signing keychain auto-locks; the create script records its password for this unlock.
if [ -f "$KEYCHAIN" ]; then
  security unlock-keychain -p "$(cat "$SIGNING_DIR/keychain-password")" "$KEYCHAIN" >/dev/null 2>&1
fi

echo "[probe] evidence: $EVIDENCE" >&2

# --- build the probe tool -------------------------------------------------------------
PROBE_BIN="$SCRATCH/BundleValidityProbe"
xcrun swiftc -O -swift-version 5 -target arm64-apple-macos12.0 \
  -framework Security -o "$PROBE_BIN" \
  "$HERE/evidence/BundleValidityProbe.swift" >&2 || exit 1

# --- assemble a helper-shaped throwaway bundle ----------------------------------------
APP="$SCRATCH/Probe.app"
CONTENTS="$APP/Contents"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
cp "$PROBE_BIN" "$CONTENTS/MacOS/Probe"
cp "$HERE/Info.plist.template" "$CONTENTS/Info.plist"
sed -i '' \
  -e 's/__EXECUTABLE__/Probe/g' \
  -e 's/__BUNDLE_ID__/dev.zcode.cua-helper.probe/g' \
  -e 's/__DISPLAY_NAME__/Probe/g' \
  -e 's/__VERSION__/0.0.1/g' \
  -e 's/__BUILD__/1/g' "$CONTENTS/Info.plist"
printf 'sealed resource\n' > "$CONTENTS/Resources/sealed.txt"
codesign --force --timestamp=none --options runtime --sign "$IDENTITY" --keychain "$KEYCHAIN" \
  "$APP" >&2 || exit 1

EXECUTABLE="$CONTENTS/MacOS/Probe"
REQUIREMENT='identifier "dev.zcode.cua-helper.probe"'

# Each case runs the probe three times (bundle against the requirement, bundle with nested-code
# checking, bare executable image) and labels every JSON line with the case name. The probe
# prints a bare JSON object per run; the sed pair turns it into {"case":…,"report":{…}}.
record() { # label probe-args...
  local label="$1"; shift
  local out
  out="$("$PROBE_BIN" "$@" 2>&1)"
  printf '{"case":"%s","tool":"%s"}\n' "$label" "$*" >>"$EVIDENCE/raw.txt" 2>/dev/null || true
  echo "$out" | sed -e "1s/^/{\"case\":\"$label\",\"report\":/" -e "\$s/\$/}/"
}

# --- A. running-code path resolution ---------------------------------------------------
cp -R "$APP" "$SCRATCH/SelfProbe.app"
"$PROBE_BIN" --mode self >"$EVIDENCE/self-report.json" 2>&1
# For the bundle-resolution question the probe must run AS the bundle executable, so invoke the
# copy inside the signed bundle directly (LaunchServices is not needed for SecCodeCopySelf).
"$SCRATCH/SelfProbe.app/Contents/MacOS/Probe" --mode self >"$EVIDENCE/self-report-in-bundle.json"
echo "[probe] self-report (standalone): $(cat "$EVIDENCE/self-report.json")" >&2
echo "[probe] self-report (as bundle executable): $(cat "$EVIDENCE/self-report-in-bundle.json")" >&2

# --- B/C. tamper matrix ---------------------------------------------------------------
: >"$EVIDENCE/matrix.jsonl"

matrix_case() { # label mutation-command
  local label="$1"; local mutation="${2:-}"
  if [ -n "$mutation" ]; then
    eval "$mutation" >&2
  fi
  {
    record "$label.bundle+requirement" --validate "$APP" --requirement "$REQUIREMENT" --all-arch --strict
    record "$label.bundle+nested" --validate "$APP" --all-arch --strict --nested
    record "$label.executable" --validate "$EXECUTABLE" --all-arch --strict
  } >>"$EVIDENCE/matrix.jsonl"
  # restore to pristine for the next case
  rm -rf "$APP"
  cp -R "$APP.pristine" "$APP"
}

cp -R "$APP" "$APP.pristine"

matrix_case "B0-pristine" ""
matrix_case "B1-modified-sealed-resource" \
  "sed -i '' 's/<string>1<\/string>/<string>2<\/string>/' \"$CONTENTS/Info.plist\""
matrix_case "B2-added-unsigned-file-in-resources" \
  "printf 'x' > \"$CONTENTS/Resources/extra-unsigned.txt\""
matrix_case "B2b-added-file-at-bundle-root" \
  "printf 'x' > \"$APP/extra-at-root.txt\""
matrix_case "B2c-added-file-in-contents-root" \
  "printf 'x' > \"$CONTENTS/extra-in-contents.txt\""
matrix_case "B3-appended-executable-bytes" \
  "printf 'TAMPER' >> \"$EXECUTABLE\""
# B4: flip one byte in the MIDDLE of __text (read-modify-XOR, so the byte is guaranteed to
# change — the same discipline run-tamper-probe.sh applies via tamper-offsets.py). otool prints
# the section size in hex, so it is parsed with int(…, 16).
TEXT_INFO="$(otool -l "$EXECUTABLE" | awk '/sectname __text/{f=1} f && / size /{s=$2} f && / offset /{print $2, s; exit}')"
TEXT_OFF="$(echo "$TEXT_INFO" | cut -d' ' -f1)"
TEXT_SIZE_HEX="$(echo "$TEXT_INFO" | cut -d' ' -f2)"
matrix_case "B4-edited-text-byte" \
  "python3 -c \"
import sys
p = sys.argv[1]; off = int(sys.argv[2]) + int(sys.argv[3], 16) // 2
with open(p, 'r+b') as f:
    f.seek(off); b = f.read(1)
    f.seek(off); f.write(bytes([b[0] ^ 0xFF]))
\" \"$EXECUTABLE\" \"$TEXT_OFF\" \"$TEXT_SIZE_HEX\""
# B5: a valid re-seal under the approved development identity (the "rebuild" case) succeeds.
matrix_case "B5-resealed-pristine" \
  "codesign --force --timestamp=none --options runtime --sign \"$IDENTITY\" --keychain \"$KEYCHAIN\" \"$APP\" >&2"

echo "[probe] matrix written: $EVIDENCE/matrix.jsonl" >&2
cat "$EVIDENCE/matrix.jsonl"
