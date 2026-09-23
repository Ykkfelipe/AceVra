#!/usr/bin/env python3
"""Re-derive every number quoted in the CUA-0.5 spec and evidence README from the raw
artifacts, so the prose can be checked against the data instead of trusted. Exits non-zero
on any mismatch.

The absence of a checker like this is what let an incorrect sample count survive into the
first draft, so it is part of the deliverable rather than a convenience.

Usage: verify-cua05-claims.py <evidence_run_dir>
"""
import json
import os
import re
import sys

run = sys.argv[1]
final = os.path.join(run, "final")
ok = bad = 0


def check(expected, measured, label):
    global ok, bad
    good = expected == measured
    ok, bad = ok + good, bad + (not good)
    print(f"  [{'PASS' if good else 'FAIL'}] {label:<52} expected={expected!r} measured={measured!r}")


def report(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except OSError as exc:
        # Report it as a normal check failure: a missing artifact must not abort the
        # run and hide every claim after it.
        print(f"  [FAIL] missing artifact: {os.path.basename(path)} ({exc.strerror})")
        return {"identity": {}, "permissions": {}, "launch": {}}


def perms(label, base=final):
    d = report(os.path.join(base, f"{label}.report.json"))
    p = d["permissions"]
    return d["identity"], d


print("persistence matrix (final pass, frozen source)")
rows = {}
for label in ("baseline", "A-helper-restart", "C-rebuild-same-identity",
              "D-reinstall-same-path", "E-version-change",
              "S-requirement-mismatch", "S-restored"):
    ident, d = perms(label)
    rows[label] = (ident.get("cdHash"), ident.get("designatedRequirement"),
                   d["permissions"]["accessibility"], d["permissions"]["screenCapturePreflight"])

req_primary = 'identifier "dev.zcode.cua-helper.dev" and certificate root = H"f89ef7752a4e905bb19c2530e837809c0f2055f2"'
for label in ("baseline", "A-helper-restart", "C-rebuild-same-identity",
              "D-reinstall-same-path", "E-version-change"):
    cd, req, ax, sr = rows[label]
    check(req_primary, req, f"{label}: requirement unchanged")
    check(True, ax is True and sr is True, f"{label}: both grants held")
cds = {rows[l][0] for l in ("baseline", "C-rebuild-same-identity", "D-reinstall-same-path", "E-version-change")}
check(4, len(cds), "cdhash distinct across baseline/C/D/E (changed while grant held)")

cd, req, ax, sr = rows["S-requirement-mismatch"]
check("4dcf904dcee2baf81c5d4b484d826d4815b0c443" in req, True, "S: requirement changed (different cert root)")
check(True, ax is False and sr is False, "S: both grants lost")
cd, req, ax, sr = rows["S-restored"]
check(req_primary, req, "S-restored: requirement back to the original")
check(True, ax is True and sr is True, "S-restored: both grants usable again")

with open(os.path.join(final, "matrix.log")) as fh:
    matrix = fh.read()
src_hashes = set(re.findall(r"source sha256: ([0-9a-f]{64})", matrix))
check(1, len(src_hashes), "one helper source revision across every matrix row")
check(7, len(re.findall(r"----- ", matrix)), "matrix case count")

print("\ntamper probe")
with open(os.path.join(final, "tamper.log")) as fh:
    tamper = fh.read()
check(5, len(re.findall(r"RESULT ", tamper)), "tamper case count")
check(3, len([m for m in re.findall(r"codesign --verify rc=(\d)", tamper) if m == "1"]),
      "three cases with a broken signature")
for label, expected_trust in (("A-control", True), ("B-text", True), ("C-cstring", True),
                              ("D-appended", True), ("E-restored", True)):
    _, d = perms(label)
    check(expected_trust, d["permissions"]["accessibility"] is True, f"{label}: accessibility")
check(5, len({perms(l)[0]["pid"] for l in ("A-control", "B-text", "C-cstring", "D-appended", "E-restored")}),
      "five distinct pids (each case really re-launched)")

print("\nlaunch paths and the launcher-pid control (final pass)")
ident, d = perms("R1-exec")
check(False, ident["ppid"] == 1, "R1-exec: not launchd-parented (exec path)")
with open(os.path.join(final, "R1-exec.log")) as fh:
    r1log = fh.read()
check(True, "bundleId=dev.zcode.app" in r1log, "R1-exec: ancestry names the app identity dev.zcode.app")
ident, d = perms("R2-open")
check(1, ident["ppid"], "R2-open: launchd-parented (LaunchServices path)")
for mode in ("with", "without"):
    ident, d = perms(f"R3-ctl3-{mode}")
    check(True, d["permissions"]["accessibility"] is False, f"ctl3 {mode} --launcher-pid: accessibility denied")
    check(True, d["permissions"]["screenCapturePreflight"] is False, f"ctl3 {mode}: screen recording denied")
idw, dw = perms("R3-ctl3-with")
ido, do = perms("R3-ctl3-without")
check(idw["bundleId"], ido["bundleId"], "ctl3: same bundle id with and without the flag")

print("\npre-grant contrast (earlier exploratory pass)")
ident, d = perms("L1-exec", run)
check(True, d["permissions"]["accessibility"] is True, "L1-exec (pre-grant): accessibility true by inheritance")
ident, d = perms("L2-open", run)
check(True, d["permissions"]["accessibility"] is False, "L2-open (pre-grant): accessibility false, own identity")
check(1, ident["ppid"], "L2-open (pre-grant): parentPid 1")

print("\nwatch series")
lines = [l for l in open(os.path.join(run, "H-watch.jsonl")) if l.strip()]
samples = [json.loads(l) for l in lines]
check(128, len(samples), "sample count")
check(1, len({s["pid"] for s in samples}), "all samples from one pid")
check(True, any(s.get("captureOk") and not s.get("srPreflight") for s in samples),
      "capture worked while SR preflight still read false (same pid)")
check(True, any(s.get("ax") for s in samples), "the same process later observed AX trust")
_, fresh = perms("I-fresh-after-grant", run)
check(True, fresh["permissions"]["screenCapturePreflight"] is True,
      "a fresh process reads SR preflight true")

print(f"\nchecked={ok + bad}  PASS={ok}  FAIL={bad}")
sys.exit(1 if bad else 0)
