import assert from "node:assert/strict";
import test from "node:test";

import { projectAvailableCuaPermissionReport } from "../src/cua-permission-broker/cuaPermissionProjection.js";

test("permission projection preserves Helper availability and native states", () => {
  const result = projectAvailableCuaPermissionReport({
    grant_owner: "dev.acevra.cua-helper",
    owner: { display_name: "AceVra Computer Use" },
    accessibility: "denied",
    screen_recording: "granted",
    screen_recording_readout: {
      preflight: true,
      source: "CGPreflightScreenCaptureAccess",
    },
  });
  assert.deepEqual(result, {
    available: true,
    platform: "darwin",
    grantOwner: "dev.acevra.cua-helper",
    grantOwnerDisplayName: "AceVra Computer Use",
    accessibility: "denied",
    accessibilityProbeOk: false,
    screenRecording: "granted",
    screenRecordingReadout: {
      preflight: true,
      source: "CGPreflightScreenCaptureAccess",
    },
  });
});

test("unavailable Helper status is not converted into a TCC permission state", () => {
  const unavailable = { available: false, reason: "Helper unavailable" } as const;
  assert.equal(unavailable.available, false);
  assert.equal("accessibility" in unavailable, false);
  assert.equal("screenRecording" in unavailable, false);
});
