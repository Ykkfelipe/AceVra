#!/usr/bin/env python3
"""Re-derive every number quoted in docs/COMPUTER_USE_ARCHITECTURE_SPIKE.md §4.11 from
the raw archived artefacts, so a reader can check the document against the evidence
instead of trusting either. Exits non-zero if any claim fails.

Usage: verify-claims.py <evidence_run_dir>
"""
import glob
import json
import os
import sys

run = sys.argv[1]


def load(name):
    with open(os.path.join(run, name)) as fh:
        return json.load(fh)


def lines(name):
    with open(os.path.join(run, name)) as fh:
        return [l for l in fh if l.strip()]


ok = bad = 0


def check(expected, measured, label=""):
    global ok, bad
    good = expected == measured
    ok, bad = ok + good, bad + (not good)
    print(f"  [{'PASS' if good else 'FAIL'}] {label:<38} expected={expected!r} measured={measured!r}")


print("routes and refusals (driver's own reporting)")
check("accessibility", load("C-AX2.action.json").get("route"), "C-AX2 background AX press")
check("synthetic_events", load("C-DBL1.action.json").get("route"), "C-DBL1 background dbl-click")
check("synthetic_events", load("Q-DBL2.action.json").get("route"), "Q-DBL2 canvas dbl-click")
check("accessibility", load("Q-PXC1.action.json").get("route"), "Q-PXC1 pixel single click")
check("accessibility", load("P-AX1.action.json").get("route"), "P-AX1 Qt AX press")
check("accessibility", load("P-PX1.action.json").get("route"), "P-PX1 Qt pixel single click")
check("synthetic_events", load("P-DBL1.action.json").get("route"), "P-DBL1 Qt dbl-click")
check("background_unavailable", load("P-DRG1.action.json").get("code"), "P-DRG1 drag refusal")
check("synthetic_events", load("Q2-BGZOOM-1.action.json").get("route"), "Q2-BGZOOM-1 title-bar dbl")
check("minimized_or_hidden_window", load("Q2-BGZOOM-2.action.json").get("code"), "Q2-BGZOOM-2 refusal")
check("global_input", load("C-FG1.action.json").get("route"), "C-FG1 foreground control")
check("global_input", load("Q-FG1.action.json").get("route"), "Q-FG1 foreground control")

print("\ninvariants on the tap-clean background trials")
for lab in ("C-AX2", "C-DBL1", "Q-DBL2", "Q-PXC1", "P-AX1", "P-DBL1", "P-PX1", "Q2-BGZOOM-1"):
    b, a = load(f"{lab}.before.json"), load(f"{lab}.after.json")
    held = b["frontmost"]["pid"] == a["frontmost"]["pid"] and b["cursor"] == a["cursor"]
    check(True, held, f"{lab} frontmost+cursor held")
check(149, load("Q2-BGZOOM-1.watch.json").get("physicalEvents"), "Q2-BGZOOM-1 contamination")
check(0, load("C-DBL1.watch.json").get("physicalEvents"), "C-DBL1 clean bracket")

print("\nQt checkbox readback (probe AX, independent of the driver)")
for lab, exp in (("P-AX1", "0->1"), ("P-PX1", "1->0"), ("P-DBL1", "0->0")):
    v = [json.loads(lines(f"{lab}.verify.{p}.txt")[0])["value"] for p in ("before", "after")]
    check(exp, f"{v[0]}->{v[1]}", f"{lab} AXValue")


def size(lab, phase):
    d = json.loads(lines(f"{lab}.verify.{phase}.txt")[1])   # 2nd JSON line is AXSize
    return f'{d["size"]["w"]}x{d["size"]["h"]}'


print("\nQt window frames (multi-valued observable on a non-AX surface)")
check("800x632->1470x874", f"{size('Q2-FGZOOM','before')}->{size('Q2-FGZOOM','after')}", "Q2-FGZOOM control")
check("800x632->1470x874", f"{size('Q2-BGZOOM-1','before')}->{size('Q2-BGZOOM-1','after')}", "Q2-BGZOOM-1 background")

print("\ntext delivery")
check(11, load("C-TXT1.action.json").get("delivery", {}).get("delivered_count"), "C-TXT1 chars")
check(0, load("Q-TXT1.action.json").get("delivered_chars"), "Q-TXT1 chars")
check("partial", load("Q-TXT1.action.json").get("effect"), "Q-TXT1 effect")

print("\ncontaminated / clean tallies")
labels = sorted({os.path.basename(p)[: -len(".action.json")]
                 for p in glob.glob(os.path.join(run, "*.action.json"))})
phys = [load(f"{l}.watch.json").get("physicalEvents") for l in labels]
check(32, len(labels), "trials")
check(20, sum(1 for p in phys if (p or 0) > 0), "contaminated")
check(12, sum(1 for p in phys if p == 0), "tap-clean")

print(f"\nchecked={ok + bad}  PASS={ok}  FAIL={bad}")
sys.exit(1 if bad else 0)
