#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUTPUT="$(mktemp -t acevra-pointer-glide.XXXXXX)"
trap 'rm -f "$OUTPUT"' EXIT

xcrun swiftc -swift-version 5 \
  "$HERE/PointerGlide.swift" \
  "$HERE/evidence/PointerGlideTests.swift" \
  -o "$OUTPUT"
"$OUTPUT"
