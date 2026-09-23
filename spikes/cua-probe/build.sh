#!/usr/bin/env bash
# Build the disposable ZCode CUA Probe.app.
#
# Why a .app bundle rather than a bare CLI: macOS TCC attributes Accessibility
# and Screen Recording grants to a *responsible process identity*. A bare
# executable launched from a terminal inherits the terminal's (or the parent
# agent app's) grants, which measures the wrong thing. A bundle with a stable
# CFBundleIdentifier has its own identity and can be granted on its own.
#
# Signing note (important): this machine has no code-signing identity
# (`security find-identity -v -p codesigning` reports 0 valid identities), so the
# bundle is ad-hoc signed. An ad-hoc signature's designated requirement is its
# cdhash, which changes on EVERY rebuild — so rebuilding after granting
# permission invalidates the grant and forces a re-grant. Build once, sign once,
# grant once, then vary only command-line arguments.
#
# Deployment-target note (also important): this machine has SDK 26.2 with an OS
# reporting 27.0, and swiftc's default target is arm64-apple-macosx28.0. Without
# an explicit -target the linked binary records minos 28.0, which LaunchServices
# rejects with kLSIncompatibleSystemVersionErr (-10825) so the bundle cannot be
# opened at all. The explicit target below is therefore required, not cosmetic.
#
# Usage: ./build.sh [--sign-identity "Developer ID Application: ..."]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${SCRIPT_DIR}/build/ZCode CUA Probe.app"
IDENTITY="-"   # ad-hoc
SIGN_MODE="ad-hoc"

while [[ $# -gt 0 ]]; do
	case "$1" in
	--sign-identity)
		IDENTITY="$2"
		SIGN_MODE="identity:$2"
		shift 2
		;;
	*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done

rm -rf "${APP_DIR}"
mkdir -p "${APP_DIR}/Contents/MacOS"

swiftc \
	-swift-version 5 \
	-O \
	-target arm64-apple-macos14.0 \
	-framework AppKit \
	-framework ApplicationServices \
	-framework CoreGraphics \
	-framework ScreenCaptureKit \
	-framework UniformTypeIdentifiers \
	-o "${APP_DIR}/Contents/MacOS/ZCodeCuaProbe" \
	"${SCRIPT_DIR}/main.swift"

cp "${SCRIPT_DIR}/Info.plist" "${APP_DIR}/Contents/Info.plist"

codesign --force --timestamp=none --sign "${IDENTITY}" \
	--identifier "dev.zcode.cua.probe" "${APP_DIR}"

echo "built: ${APP_DIR}"
echo "sign:  ${SIGN_MODE}"
codesign -dv "${APP_DIR}" 2>&1 | sed -n '1,12p' || true
