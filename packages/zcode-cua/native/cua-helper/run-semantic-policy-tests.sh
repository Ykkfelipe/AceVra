#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUTPUT="$(mktemp -t acevra-semantic-policy.XXXXXX)"
trap 'rm -f "$OUTPUT"' EXIT

xcrun swiftc -swift-version 5 \
  "$HERE/SemanticActionPolicy.swift" \
  "$HERE/evidence/SemanticActionPolicyTests.swift" \
  -o "$OUTPUT"
"$OUTPUT"
