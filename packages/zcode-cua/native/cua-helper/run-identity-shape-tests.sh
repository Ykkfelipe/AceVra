#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUTPUT="$(mktemp -t acevra-identity-shape.XXXXXX)"
trap 'rm -f "$OUTPUT"' EXIT

xcrun swiftc -swift-version 5 \
  "$HERE/CodeIdentity.swift" \
  "$HERE/evidence/IdentityShapeTests.swift" \
  -o "$OUTPUT"
"$OUTPUT"
