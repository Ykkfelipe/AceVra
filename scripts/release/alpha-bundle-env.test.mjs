import assert from "node:assert/strict";
import test from "node:test";

import { resolveAlphaBundleEnv } from "./alpha-bundle-env.mjs";

test("alpha bundle environment resolves an absolute no-clobber build root", () => {
  const env = resolveAlphaBundleEnv({ HOME: "/tmp/home" }, "/repo");
  assert.equal(env.ZCODE_DESKTOP_RELEASE_PROFILE, "local-engineering-alpha");
  assert.equal(env.ZCODE_DESKTOP_DIST_DIR, "/repo/release/0.1.0-alpha.1/build");
  assert.equal(env.HOME, "/tmp/home");
});
