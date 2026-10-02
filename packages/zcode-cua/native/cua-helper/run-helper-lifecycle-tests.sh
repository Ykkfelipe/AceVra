#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUTPUT="$(mktemp -t acevra-helper-lifecycle.XXXXXX)"
trap 'rm -f "$OUTPUT"' EXIT

xcrun swiftc -swift-version 5 \
  "$HERE/HelperLifecycle.swift" \
  "$HERE/evidence/HelperLifecycleTests.swift" \
  -o "$OUTPUT"
"$OUTPUT"
