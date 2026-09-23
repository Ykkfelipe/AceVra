import assert from "node:assert/strict";
import test from "node:test";
import { SHOW_PROVIDER_PLAN_PURCHASES } from "../src/lib/forkProductPolicy.js";

test("the fork does not expose provider plan purchase actions", () => {
  assert.equal(SHOW_PROVIDER_PLAN_PURCHASES, false);
});
