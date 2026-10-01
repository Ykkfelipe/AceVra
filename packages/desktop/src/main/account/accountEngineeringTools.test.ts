import assert from "node:assert/strict";
import test from "node:test";
import { resolveEngineeringTools } from "./accountEngineeringTools.js";

test("engineering runner is opt-in and never available in packaged builds", () => {
  const on = { ACEVRA_ENGINEERING_TOOLS: "1" };
  assert.equal(resolveEngineeringTools(on, { isPackaged: false }), true);
  assert.equal(resolveEngineeringTools(on, { isPackaged: true }), false);
  assert.equal(resolveEngineeringTools({}, { isPackaged: false }), false);
  assert.equal(
    resolveEngineeringTools({ ACEVRA_ENGINEERING_TOOLS: "true" }, { isPackaged: false }),
    false,
  );
});
