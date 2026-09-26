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
#   * a new RSA-2048 key + self-signed X.509 certificate, CN "AceVra CUA Dev Signing",
#     extendedKeyUsage = codeSigning, 10 year validity
#   * a DEDICATED keychain file at $CUA_SIGNING_DIR/acevra-cua-dev.keychain-db
#   * the keychain password in $CUA_SIGNING_DIR/keychain-password (mode 0600)
# It does NOT touch the login keychain or the admin/system trust store. It adds a user-domain
# codeSign trust setting for this self-signed certificate so macOS recognizes the pair as a
# usable identity. Everything else lives inside the isolated AceVra integration CUA namespace.
#
# Re-running is idempotent: an existing keychain with the identity is reused.
#
# Usage: create-dev-signing-identity.sh [--force]

set -euo pipefail

SIGNING_DIR="${CUA_SIGNING_DIR:-$HOME/.acevra-integration-cua-home/signing}"
KEYCHAIN="$SIGNING_DIR/acevra-cua-dev.keychain-db"
PASSWORD_FILE="$SIGNING_DIR/keychain-password"
IDENTITY_CN="AceVra CUA Dev Signing"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

assert_expected_identity() {
  local output count
  output="$(security find-identity -v -p codesigning "$KEYCHAIN")"
  printf '%s\n' "$output" | sed 's/^/  /'
  count="$(printf '%s\n' "$output" | sed -nE 's/^[[:space:]]*([0-9]+) valid identities found$/\1/p' | tail -n 1)"
  # 修复依据：该命令在零个身份时仍返回成功状态，必须检查身份数量和预期名称。
  if [[ "$count" != "1" ]] || ! printf '%s\n' "$output" | grep -Fq "$IDENTITY_CN"; then
    echo "error: expected exactly one valid '$IDENTITY_CN' identity in $KEYCHAIN; found ${count:-unknown}" >&2
    return 1
  fi
}

mkdir -p "$SIGNING_DIR"
chmod 700 "$SIGNING_DIR"

if [[ -f "$KEYCHAIN" && $FORCE -eq 0 ]]; then
  if [[ ! -f "$PASSWORD_FILE" ]]; then
    echo "error: signing keychain exists but its managed password file is missing: $PASSWORD_FILE" >&2
    exit 1
  fi
  # 修复依据：锁定的 keychain 和丢失的用户 codeSign 信任都会让既有身份不可用；先恢复这两项，避免误走新建身份路径。
  PW="$(cat "$PASSWORD_FILE")"
  security unlock-keychain -p "$PW" "$KEYCHAIN"
  unset PW
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  security find-certificate -c "$IDENTITY_CN" -p "$KEYCHAIN" > "$TMP/existing-cert.pem"
  # 不使用 -d：只在当前用户域恢复 codeSign 信任，不修改 Admin/System trust。
  security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$TMP/existing-cert.pem" >/dev/null
  assert_expected_identity
  echo "identity already present in $KEYCHAIN; nothing to do"
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
  -subj "/CN=$IDENTITY_CN/O=AceVra Integration/C=US" \
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
# A self-signed certificate is not considered a valid code-signing identity until it is
# trusted for the codeSign policy. This writes only the current user's trust setting.
# 修复依据：实测证书与私钥已配对，但缺少此用户级策略信任时 find-identity 返回零。
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem" >/dev/null

echo "created: $KEYCHAIN"
assert_expected_identity
