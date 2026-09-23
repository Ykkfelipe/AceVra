#!/usr/bin/env python3
"""Print the first __text and __cstring file offsets/sizes as shell assignments.

`otool -l` reports both a virtual `addr` and a file `offset` for each section; only
`offset` is a file offset. `__text` also appears a second time inside `__DATA_CONST`, so
the FIRST occurrence of each name is the one wanted. Getting this wrong is what produced
the bogus offsets in the first tamper attempt.

Usage: tamper-offsets.py <mach-o binary>
"""
import subprocess
import sys

out = subprocess.check_output(["otool", "-l", sys.argv[1]], text=True)

wanted = {"__text": None, "__cstring": None}
sect = None
off = None
size = None
for raw in out.splitlines():
    line = raw.strip()
    if line.startswith("sectname "):
        sect = line.split()[1]
    elif line.startswith("size ") and sect:
        size = int(line.split()[1], 16)
    elif line.startswith("offset ") and sect:
        off = int(line.split()[1])
    elif line.startswith("align ") and sect:
        if sect in wanted and wanted[sect] is None:
            wanted[sect] = (off, size)
        sect = off = size = None

text = wanted["__text"]
cstring = wanted["__cstring"]
if text is None or cstring is None:
    print("could not locate __text/__cstring", file=sys.stderr)
    sys.exit(1)

print(f"TEXT_OFF={text[0]}")
print(f"TEXT_SIZE={text[1]}")
print(f"CSTRING_OFF={cstring[0]}")
