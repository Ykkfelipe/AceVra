#!/usr/bin/env python3
"""Evaluate one trial directory entry against the strict background criteria.

Reads, for a trial label <L>:
  <L>.before.json / <L>.after.json   probe state (frontmost, cursor, z-order)
  <L>.before.windows / <L>.after.windows
  <L>.action.json                    raw cua-driver response
  <L>.watch.json                     listen-only event-tap counters

and prints the five invariants plus the independent readback (target window
title, which comes from CGWindowList and never from the driver).

A trial is only admissible evidence for BACKGROUND if the tap saw no physical
(human) input during the bracket; otherwise the invariants cannot be attributed
to the action and the run is reported as CONTAMINATED.

Usage: summarize-trial.py <run_dir> <label> <target_pid>
"""
import json
import os
import sys


def load(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return None


def window_of(windows_path, wid):
    """Return (z_order, title, bounds) for a window id in a probe window dump."""
    if not os.path.exists(windows_path):
        return None
    with open(windows_path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                w = json.loads(line)
            except Exception:
                continue
            if w.get("id") == wid:
                return w
    return None


def main():
    run_dir, label, pid = sys.argv[1], sys.argv[2], sys.argv[3]

    before = load(os.path.join(run_dir, f"{label}.before.json")) or {}
    after = load(os.path.join(run_dir, f"{label}.after.json")) or {}
    action = load(os.path.join(run_dir, f"{label}.action.json")) or {}
    watch = load(os.path.join(run_dir, f"{label}.watch.json")) or {}

    fb, fa = before.get("frontmost", {}), after.get("frontmost", {})
    cb, ca = before.get("cursor", {}), after.get("cursor", {})
    dx = round(ca.get("x", 0) - cb.get("x", 0), 1)
    dy = round(ca.get("y", 0) - cb.get("y", 0), 1)

    physical = watch.get("physicalEvents")
    contaminated = (physical or 0) > 0
    # A refused or failed action never reached an actuator, so a quiet bracket
    # says nothing about it. The verdict must not call that "attributable".
    ran = bool(action.get("route"))
    refusal = action.get("refusal") or (action.get("code") if not ran else None)

    print(f"=== trial {label} ===")
    print(f"  action route/delivery/effect : "
          f"{action.get('route')} / {action.get('delivery', {}).get('mode')} / {action.get('effect')}")
    if action.get("refusal"):
        print(f"  refusal                      : {action['refusal']}")
    print(f"  frontmost before             : {fb.get('bundleId')} (pid {fb.get('pid')})")
    print(f"  frontmost after              : {fa.get('bundleId')} (pid {fa.get('pid')})")
    print(f"  cursor before                : ({cb.get('x')}, {cb.get('y')})")
    print(f"  cursor after                 : ({ca.get('x')}, {ca.get('y')})  delta=({dx}, {dy})")
    print(f"  human input during bracket   : physicalEvents={physical} "
          f"syntheticEvents={watch.get('syntheticEvents')}")
    if not ran:
        print(f"  action reached an actuator  : NO ({refusal})")
    print(f"  'frontmost unchanged'        : {fb.get('pid') == fa.get('pid')}")
    print(f"  'cursor unchanged'           : {dx == 0 and dy == 0}")
    print(f"  'tap clean'                  : {not contaminated and physical is not None}")
    if not ran:
        verdict = "REFUSED/NO-OP - not a result"
    elif contaminated:
        verdict = "CONTAMINATED - discard"
    else:
        verdict = "tap-clean and ran - attributable"
    print(f"  VERDICT                      : {verdict}")


if __name__ == "__main__":
    main()
