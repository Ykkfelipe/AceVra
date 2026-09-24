import type { CuaPermissionKind } from "@zcode/shared";

export const MACOS_ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
export const MACOS_SCREEN_RECORDING_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
export const MACOS_PRIVACY_SECURITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security";

export function settingsUrlForPermission(permission: CuaPermissionKind): string {
  return permission === "screen_recording"
    ? MACOS_SCREEN_RECORDING_SETTINGS_URL
    : MACOS_ACCESSIBILITY_SETTINGS_URL;
}

export async function openPermissionSettingsWithFallback(options: {
  permission: CuaPermissionKind;
  openSettingsUrl(url: string): Promise<void>;
  fallbackUrl?: string;
}): Promise<boolean> {
  try {
    await options.openSettingsUrl(settingsUrlForPermission(options.permission));
    return false;
  } catch (error) {
    try {
      await options.openSettingsUrl(options.fallbackUrl ?? MACOS_PRIVACY_SECURITY_SETTINGS_URL);
      return true;
    } catch {
      throw error;
    }
  }
}
