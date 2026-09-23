#!/usr/bin/env python3
"""One-line projection of a helper report, for transcripts.

Usage: show-report.py <report.json> [label]
"""
import json
import sys

path = sys.argv[1]
label = sys.argv[2] if len(sys.argv) > 2 else path.rsplit("/", 1)[-1]
try:
    with open(path) as fh:
        raw = fh.read()
except OSError as exc:
    print(f"  {label}: NO REPORT ({exc})")
    raise SystemExit(0)

if raw.count("\n") > 1 and "\"schemaVersion\"" not in raw:
    # A watch run writes JSONL to --report. Reporting its first line as "the report" would
    # silently present a time series as a single observation.
    lines = [l for l in raw.splitlines() if l.strip()]
    print(f"  {label}: this is a watch series ({len(lines)} samples), not a single report")
    print(f"    first={lines[0][:120]}")
    print(f"    last ={lines[-1][:120]}")
    raise SystemExit(0)

try:
    d = json.loads(raw)
except Exception as exc:  # noqa: BLE001 - a malformed report is a result too
    print(f"  {label}: UNPARSEABLE REPORT ({exc})")
    raise SystemExit(0)

perms = d.get("permissions", {})
ident = d.get("identity", {})
launch = d.get("launch", {})
print(f"  {label}: bundle={ident.get('bundleId')} cdhash={(ident.get('cdHash') or '')[:12]}")
print(
    "    ax={ax} srPreflight={sr} launcherPidArg={lp} parentPid={pp} ppid={ospp}".format(
        ax=perms.get("accessibility"),
        sr=perms.get("screenCapturePreflight"),
        lp=launch.get("launcherPidArg"),
        pp=launch.get("parentPid"),
        ospp=ident.get("ppid"),
    )
)
for key in ("accessibilityPromptRequested", "screenRecordingPromptRequested"):
    if key in perms:
        print(f"    {key}={perms[key]}")
for key in ("axRead", "capture"):
    if key in d:
        print(f"    {key}={json.dumps(d[key], sort_keys=True)}")
