import assert from "node:assert/strict";
import test from "node:test";
import {
  isCodingPlanActionDisabled,
  resolveCodingPlanEntryPresentation,
} from "../src/settings/model-provider-section/codingPlanEntryPresentation.js";

test("plan-dependent account actions stay disabled until plan metadata is ready", () => {
  assert.equal(isCodingPlanActionDisabled("loading"), true);
  assert.equal(isCodingPlanActionDisabled("error"), true);
  assert.equal(isCodingPlanActionDisabled("ready"), false);
});

test("optional plan catalog failure preserves account UI but disables its plan-dependent action", () => {
  const presentation = resolveCodingPlanEntryPresentation("error", { quietError: true });
  assert.deepEqual(presentation, {
    status: "error",
    quietFailure: true,
    disabled: true,
    activation: "retry",
    showChildren: true,
  });
});

test("loading plan catalog disables the entry without replacing it with an error", () => {
  const presentation = resolveCodingPlanEntryPresentation("loading", { quietError: true });
  assert.equal(presentation.disabled, true);
  assert.equal(presentation.activation, "none");
  assert.equal(presentation.showChildren, false);
});

test("the explicit cancel action remains available after upgrade details open", () => {
  const presentation = resolveCodingPlanEntryPresentation("error", {
    bypassGate: true,
    quietError: true,
  });
  assert.equal(presentation.disabled, false);
  assert.equal(presentation.activation, "run");
});
