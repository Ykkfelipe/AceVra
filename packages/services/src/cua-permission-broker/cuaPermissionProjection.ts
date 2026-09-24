import type { CuaPermissionState, CuaPermissionStatus } from "./cuaPermissionService.js";

export interface CuaPermissionReport {
  grant_owner: string;
  owner?: { display_name?: string | null } | null;
  accessibility: CuaPermissionState;
  accessibility_probe_ok?: boolean;
  screen_recording: CuaPermissionState;
  screen_recording_readout?: {
    preflight: boolean | null;
    source: string;
    cached?: boolean;
    note?: string;
  } | null;
}

export function projectAvailableCuaPermissionReport(
  report: CuaPermissionReport,
): CuaPermissionStatus & { available: true; grantOwner: string } {
  return {
    available: true,
    platform: "darwin",
    grantOwner: report.grant_owner,
    grantOwnerDisplayName: report.owner?.display_name ?? report.grant_owner,
    accessibility: report.accessibility,
    accessibilityProbeOk: report.accessibility_probe_ok === true,
    screenRecording: report.screen_recording,
    ...(report.screen_recording_readout
      ? { screenRecordingReadout: report.screen_recording_readout }
      : {}),
  };
}
