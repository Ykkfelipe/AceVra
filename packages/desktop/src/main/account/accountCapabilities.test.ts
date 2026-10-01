import assert from "node:assert/strict";
import test from "node:test";
import { deriveDesktopCapabilities } from "./accountCapabilities.js";

test("desktop capabilities follow real availability", () => {
  assert.deepEqual(deriveDesktopCapabilities({ gitAvailable: true, computerUseSupported: true }), [
    "files",
    "shell",
    "git",
    "computerUse",
  ]);
  assert.deepEqual(
    deriveDesktopCapabilities({ gitAvailable: false, computerUseSupported: false }),
    ["files", "shell"],
  );
  assert.deepEqual(deriveDesktopCapabilities({ gitAvailable: true, computerUseSupported: false }), [
    "files",
    "shell",
    "git",
  ]);
});
