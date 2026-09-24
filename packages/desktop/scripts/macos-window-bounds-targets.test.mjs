import assert from "node:assert/strict";
import test from "node:test";

import { resolveWindowBoundsTargets } from "./macos-window-bounds-targets.mjs";

test("alpha window bounds build is arm64-only", () => {
  assert.deepEqual(
    resolveWindowBoundsTargets({ ZCODE_DESKTOP_RELEASE_PROFILE: "local-engineering-alpha" }),
    ["arm64-apple-macos11"],
  );
});

test("non-alpha window bounds build retains universal targets", () => {
  assert.deepEqual(resolveWindowBoundsTargets({}), ["arm64-apple-macos11", "x86_64-apple-macos11"]);
});
