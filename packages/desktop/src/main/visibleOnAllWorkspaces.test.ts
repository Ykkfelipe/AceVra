// Overlays must never change AceVra's process type (zcode-cua specs/computer-use.md "Screen
// takeover" item 6). 2026-10-03 实测：缺 skipTransformProcessType 时 Electron 以 app.dock.hide()
// 实现 visibleOnFullScreen，每次接管后 AceVra 变成 UIElement、主窗口消失且无法激活。
// Source scan: every call site in Main must opt out of the process-type transform.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const MAIN_DIR = new URL(".", import.meta.url).pathname;

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
    }),
  );
  return nested.flat();
}

test("every setVisibleOnAllWorkspaces call skips the process-type transform", async () => {
  const offenders: string[] = [];
  let calls = 0;
  for (const file of await sourceFiles(MAIN_DIR)) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/setVisibleOnAllWorkspaces\(([^)]*)\)/g)) {
      calls += 1;
      if (!/skipTransformProcessType:\s*true/.test(match[1] ?? "")) {
        offenders.push(`${file.slice(MAIN_DIR.length)}: ${match[0].replace(/\s+/g, " ")}`);
      }
    }
  }
  assert.ok(calls >= 2, `expected the overlay and drag panel call sites, found ${calls}`);
  assert.deepEqual(offenders, []);
});
