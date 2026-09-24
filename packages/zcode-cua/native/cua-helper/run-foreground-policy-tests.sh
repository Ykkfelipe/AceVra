#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUTPUT="$(mktemp -t acevra-foreground-policy.XXXXXX)"
trap 'rm -f "$OUTPUT"' EXIT

xcrun swiftc -swift-version 5 \
  "$HERE/ForegroundPolicy.swift" \
  "$HERE/evidence/ForegroundPolicyTests.swift" \
  -o "$OUTPUT"
"$OUTPUT"
