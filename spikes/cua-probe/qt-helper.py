#!/usr/bin/env python3
"""Small helpers for the Qt trials (kept in a file to avoid nested shell quoting).

  qt-helper.py point   < driver get_window_state JSON   -> "<shot_x> <shot_y>"
  qt-helper.py size    < probe ax-get AXSize JSON       -> "WxH"
  qt-helper.py action  < trial .action.json             -> "route=<r> mode=<m> ok=<bool>"
"""
import json
import sys

mode = sys.argv[1]
d = json.load(sys.stdin)

if mode == "point":
    wb = d["window_bounds"]
    s = float(d.get("screenshot_scale") or 1.0)
    # Title-bar centre: half the window width, 14 points below the window top.
    print(int(wb["width"] / 2 * s), int(14 * s))
elif mode == "size":
    sz = d["size"]
    print(f'{sz["w"]}x{sz["h"]}')
elif mode == "action":
    route = d.get("route", d.get("code", "?"))
    print(f'route={route} mode={d.get("delivery", {}).get("mode")} ok={"route" in d}')
