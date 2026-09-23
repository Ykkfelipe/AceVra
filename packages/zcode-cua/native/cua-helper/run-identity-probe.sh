#!/usr/bin/env bash
# Identity probe: does the production path actually verify the Helper's code identity, or does it
# only prove that *something* is listening on a socket?
#
# Why this exists: a socket path is not an identity. Anything that can write into the runtime data
# root can bind `helper.sock` and answer, and the CUA-0.5 measurements already showed that a TCC
# grant survives edits to the signed image (one byte in __text, one byte in __cstring, appended
# bytes) while `codesign --verify` fails. So "it answered" and "it holds the grant" are both
# worthless as integrity claims. This probe measures the check that is supposed to replace them:
# `SecCodeCheckValidity` / `SecStaticCodeCheckValidity` inside the Helper plus the expected-identity
# list the TypeScript client applies to every response.
#
# Cases:
#   A control           — untouched signed bundle: verified, and accepted by the real client
#   B wrong identity    — a different expected identifier: refused, naming the mismatch
#   C __text tamper     — one byte inside executable code: refused, and codesign --verify fails
#   D appended bytes    — bytes past the signed code limit: refused
#   E tampered, serving — the tampered bundle still binds the socket, but every request is refused
#   F peer policy       — a configured caller identity that the caller does not satisfy is refused
#   G restored          — rebuilt: verified and accepted again
#
# Usage: run-identity-probe.sh <out_dir>

set -uo pipefail

OUT_DIR="${1:?out_dir}"
mkdir -p "$OUT_DIR"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
export ZCODE_CUA_HOME="${ZCODE_CUA_HOME:-$HOME/.zcode-fork-cua-home}"
export ZCODE_HOME="${ZCODE_HOME:-$ZCODE_CUA_HOME/.zcode}"
APP="$ZCODE_HOME/computer-use/dev/AceVra Computer Use Dev.app"
BIN="$APP/Contents/MacOS/AceVraComputerUseDev"
EXPECTED_ID="dev.acevra.cua-helper.development"
LOG="$OUT_DIR/identity.log"

: > "$LOG"
say() { echo "$*" | tee -a "$LOG"; }

rebuild() {
  (cd "$REPO_ROOT" && node packages/zcode-cua/native/cua-helper/build-dev-helper.mjs >/dev/null 2>&1)
}

# Run the probe (single report, then exit) through LaunchServices, the shipping launch path.
probe() {
  local label="$1"
  shift
  local report="$OUT_DIR/$label.report.json"
  rm -f "$report"
  /usr/bin/open -n "$APP" --args --report "$report" "$@" >/dev/null 2>&1
  for _ in $(seq 1 40); do [[ -s "$report" ]] && break; sleep 0.25; done
  if [[ ! -s "$report" ]]; then
    say "  RESULT $label: NO REPORT -> the bundle did not run"
    return
  fi
  python3 - "$report" "$label" <<'PY' | tee -a "$LOG"
import json, sys
report, label = sys.argv[1], sys.argv[2]
data = json.load(open(report))
v = data.get("verifiedIdentity", {})
codesign_ok = data.get("identity", {}).get("cdHash", "")
print(f"  RESULT {label}: verified={v.get('verified')} identifier={v.get('identifier')!r} "
      f"ad_hoc={v.get('ad_hoc')} expectation={v.get('expectation_source')!r} "
      f"reason={v.get('reason')!r}")
PY
}

# The production client, not a raw socket: this is the same call createComputerUseRuntime makes.
client_call() {
  local socket="$1" method="$2"
  (cd "$REPO_ROOT" && node -e '
    import("./packages/zcode-cua/broker.js").then(async (broker) => {
      try {
        const result = await broker.callBrokerMethod({
          socketPath: process.argv[1], method: process.argv[2], timeoutMs: 5000,
        });
        console.log(`    client OK ${process.argv[2]}: grant_owner=${result.grant_owner ?? "-"} ` +
          `identity=${result.helper_identity?.identifier ?? "-"} verified=${result.helper_identity?.verified}`);
      } catch (error) {
        console.log(`    client REFUSED ${process.argv[2]}: code=${error.code}`);
      }
    });
  ' "$socket" "$method")
}

serve_and_probe() {
  local label="$1" sock="/tmp/cua-identity-$$-$RANDOM.sock"
  shift
  rm -f "$sock"
  /usr/bin/open -n "$APP" --args --serve --socket "$sock" --idle-ms 30000 "$@" >/dev/null 2>&1
  for _ in $(seq 1 60); do [[ -S "$sock" ]] && break; sleep 0.25; done
  if [[ ! -S "$sock" ]]; then
    say "  RESULT $label: no socket"
    return
  fi
  say "----- $label (live socket)"
  client_call "$sock" permission_status 2>&1 | tee -a "$LOG"
  pkill -f "$BIN --serve" 2>/dev/null
}

say "### identity probe at $(date -u +%FT%TZ)"
say "### bundle: $APP"
say "### contract expectation: $EXPECTED_ID"
say "### helper sha256: $(shasum -a 256 "$BIN" | awk '{print $1}')"

# A — control, no explicit expectation: the image's own seal must validate.
rebuild
say "----- A control (no explicit expectation)"
say "  codesign --verify --strict --all-architectures rc=$(codesign --verify --strict --all-architectures "$APP" >/dev/null 2>&1; echo $?)"
probe A-control

# B — a different expected identity must be refused.
rebuild
say "----- B wrong expected identity"
probe B-wrong-identity --expected-identifier dev.acevra.cua-helper.other

# C — one byte inside executable code.
rebuild
eval "$(python3 "$HERE/tamper-offsets.py" "$BIN")"
TARGET=$((TEXT_OFF + TEXT_SIZE / 2))
printf '\xff' | dd of="$BIN" bs=1 seek="$TARGET" conv=notrunc 2>/dev/null
say "----- C __text tamper at offset $TARGET"
say "  codesign --verify rc=$(codesign --verify "$APP" >/dev/null 2>&1; echo $?)"
say "  binary sha256: $(shasum -a 256 "$BIN" | awk '{print $1}')"
probe C-text-tamper --expected-identifier "$EXPECTED_ID"

# D — bytes appended past the signed code limit.
rebuild
say "----- D appended past the signed code limit"
printf 'TAMPER' >> "$BIN"
say "  codesign --verify rc=$(codesign --verify "$APP" >/dev/null 2>&1; echo $?)"
probe D-appended --expected-identifier "$EXPECTED_ID"

# E — a tampered bundle still binds the socket; every request must be refused.
rebuild
printf '\xff' | dd of="$BIN" bs=1 seek="$TARGET" conv=notrunc 2>/dev/null
serve_and_probe E-tampered-serving --expected-identifier "$EXPECTED_ID"

# F — a configured caller identity the caller does not satisfy.
rebuild
serve_and_probe F-peer-policy --expected-identifier "$EXPECTED_ID" --require-peer-identifier com.example.not-the-caller

# G — restored.
rebuild
say "----- G restored"
say "  codesign --verify rc=$(codesign --verify "$APP" >/dev/null 2>&1; echo $?)"
probe G-restored --expected-identifier "$EXPECTED_ID"
say "### identity probe complete"
