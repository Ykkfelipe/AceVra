#!/usr/bin/env bash
# Create the stable development code-signing identity for the CUA helper.
#
# WHY a dedicated self-signed identity rather than ad-hoc signing:
# this machine reports 0 valid code-signing identities (`security find-identity -v -p
# codesigning`), and an ad-hoc signature's designated requirement is its cdhash, which
# changes on EVERY rebuild. macOS TCC stores a grant against a code requirement, so an
# ad-hoc helper loses its Accessibility/Screen Recording grant on each rebuild and the
# user is asked to re-authorize forever. A self-signed certificate gives a requirement
# that is stable across rebuilds: `identifier "<bundle-id>" and certificate root = H"<cert sha1>"`
# (the anchor is the self-signed certificate itself, so it is `root`, not `leaf`).
#
# WHAT THIS CREATES (exactly, and nothing else):
#   * a new RSA-2048 key + self-signed X.509 certificate, CN "ZCode CUA Dev Signing",
#     extendedKeyUsage = codeSigning, 10 year validity
#   * a DEDICATED keychain file at $CUA_SIGNING_DIR/zcode-cua-dev.keychain-db
#   * the keychain password in $CUA_SIGNING_DIR/keychain-password (mode 0600)
# It does NOT touch the login keychain, does NOT add any system/user trust setting, and
# does NOT modify any other signing identity. Everything lives inside the isolated
# custom-fork CUA namespace and is removed by deleting that directory.
#
# Re-running is idempotent: an existing keychain with the identity is reused.
#
# Usage: create-dev-signing-identity.sh [--force]

set -euo pipefail

SIGNING_DIR="${CUA_SIGNING_DIR:-$HOME/.zcode-fork-cua-home/signing}"
KEYCHAIN="$SIGNING_DIR/zcode-cua-dev.keychain-db"
PASSWORD_FILE="$SIGNING_DIR/keychain-password"
IDENTITY_CN="ZCode CUA Dev Signing"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

mkdir -p "$SIGNING_DIR"
chmod 700 "$SIGNING_DIR"

if [[ -f "$KEYCHAIN" && $FORCE -eq 0 ]] && security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "$IDENTITY_CN"; then
  # Unlock on the reuse path too: the keychain auto-locks after 6h or on sleep, and
  # codesign cannot unlock it non-interactively, so a build after a reboot would fail.
  if [[ -f "$PASSWORD_FILE" ]]; then
    security unlock-keychain -p "$(cat "$PASSWORD_FILE")" "$KEYCHAIN" || true
  fi
  echo "identity already present in $KEYCHAIN; nothing to do"
  security find-identity -v -p codesigning "$KEYCHAIN" | sed 's/^/  /' || true
  exit 0
fi

if [[ ! -f "$PASSWORD_FILE" ]]; then
  # 32 hex chars from the system CSPRNG; this only protects an isolated dev keychain.
  openssl rand -hex 16 > "$PASSWORD_FILE"
  chmod 600 "$PASSWORD_FILE"
fi
PW="$(cat "$PASSWORD_FILE")"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -days 3650 \
  -subj "/CN=$IDENTITY_CN/O=ZCode Custom Fork/C=US" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1

openssl pkcs12 -export -legacy -out "$TMP/id.p12" \
  -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -name "$IDENTITY_CN" -passout "pass:$PW" >/dev/null 2>&1 ||
openssl pkcs12 -export -out "$TMP/id.p12" \
  -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -name "$IDENTITY_CN" -passout "pass:$PW" >/dev/null 2>&1

if [[ $FORCE -eq 1 && -f "$KEYCHAIN" ]]; then
  security delete-keychain "$KEYCHAIN" || true
fi
security create-keychain -p "$PW" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"   # no auto-lock during a work session
security unlock-keychain -p "$PW" "$KEYCHAIN"
# -T /usr/bin/codesign: only codesign may use the key without an interactive prompt.
security import "$TMP/id.p12" -k "$KEYCHAIN" -P "$PW" -T /usr/bin/codesign >/dev/null
# Required on current macOS so codesign can use the key non-interactively.
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$PW" "$KEYCHAIN" >/dev/null

echo "created: $KEYCHAIN"
security find-identity -v -p codesigning "$KEYCHAIN" | sed 's/^/  /'
