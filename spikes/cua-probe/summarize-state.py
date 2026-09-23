#!/usr/bin/env python3
"""One-line summary of a probe `state` JSON snapshot.

Reads a probe state object on stdin and prints the four environment invariants
this experiment must hold across a background action:
  frontmost application, hardware cursor position, top window owner, AX trust.
Keeping the projection in one place stops the shell pipelines from re-deriving
it with their own (drifting) quoting.
"""
import json
import sys

d = json.load(sys.stdin)
fm = d["frontmost"]
top = d["topWindows"][0] if d.get("topWindows") else {}
print(
    "t={ts} frontmost={bid}(pid {fpid}) cursor=({cx:.1f},{cy:.1f}) "
    "topWin={town}(pid {tpid}) axTrusted={ax}".format(
        ts=d["timestamp"],
        bid=fm.get("bundleId"),
        fpid=fm.get("pid"),
        cx=d["cursor"]["x"],
        cy=d["cursor"]["y"],
        town=top.get("owner"),
        tpid=top.get("pid"),
        ax=d["axTrusted"],
    )
)
