import assert from "node:assert/strict";
import test from "node:test";

import { resolveExternalUrlOpener } from "../src/node.js";

test("Windows OAuth URLs stay one explorer.exe argument", () => {
  const url = "https://example.test/oauth/callback?state=a&redirect=b%26c";
  assert.deepEqual(resolveExternalUrlOpener("win32", url), {
    command: "explorer.exe",
    args: [url],
  });
});

test("macOS and Linux use their native URL openers", () => {
  assert.deepEqual(resolveExternalUrlOpener("darwin", "zcode://oauth/callback"), {
    command: "open",
    args: ["zcode://oauth/callback"],
  });
  assert.deepEqual(resolveExternalUrlOpener("linux", "zcode://oauth/callback"), {
    command: "xdg-open",
    args: ["zcode://oauth/callback"],
  });
});
