export const LOCAL_ENGINEERING_ALPHA_PROFILE: "local-engineering-alpha";
export const RELEASE_PROFILE_ENV: "ZCODE_DESKTOP_RELEASE_PROFILE";
export const PREVIEW_IDENTITY_ENV: "ZCODE_PREVIEW_IDENTITY";
export const ALPHA_RUNTIME_FAILURE_CODE: "local_alpha_profile_conflict";

export interface LocalEngineeringAlphaPaths {
  profile: "local-engineering-alpha";
  source: "explicit-both" | "data-base-dir" | "desktop-home-dir" | "alpha-default";
  profileHome: string;
  dataBaseDir: string;
  zcodeHome: string;
  appConfigDir: string;
  cuaRoot: string;
  userData: string;
  sessionData: string;
}

export function isLocalEngineeringAlphaProfile(env?: Record<string, string | undefined>): boolean;
export function readPreviewIdentityRequested(env?: Record<string, string | undefined>): boolean;
export function assertLocalAlphaProfileIsIdentitySafe(
  env?: Record<string, string | undefined>,
): void;
export function canonicalizeProfileRoot(pathValue: string, options?: { platform?: string }): string;
export function resolveLocalAlphaDataBaseRoot(options?: {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  platform?: string;
}): {
  root: string;
  source: "explicit-both" | "data-base-dir" | "desktop-home-dir" | "alpha-default";
};
export function resolveLocalEngineeringAlphaPaths(options?: {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  platform?: string;
}): LocalEngineeringAlphaPaths;
export function applyLocalEngineeringAlphaEnv(
  env?: Record<string, string | undefined>,
  options?: { homeDir?: string; platform?: string },
): Record<string, string | undefined>;
