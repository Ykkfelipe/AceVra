// AceVra local engineering alpha release profile.
//
// One pure resolver owns the alpha filesystem contract and the override precedence, so the
// build, the runtime bootstrap and the validators cannot drift into separate answers.
// Authority: packages/desktop/specs/release-0.1.0-alpha.1.md.
//
// Rules:
//  * `local-engineering-alpha` is a profile, never a product identity rename.
//  * `ZCODE_DESKTOP_HOME_DIR` or `ZCODE_DATA_BASE_DIR` may override the profile root alone.
//  * Supplying both is accepted only when they canonicalize to the same root; otherwise the
//    resolver fails closed instead of silently choosing a winner.
//  * `ZCODE_PREVIEW_IDENTITY=1` with the alpha profile fails: the identity resolver gives the
//    flag precedence over production identity, which would relabel the candidate as Preview.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const LOCAL_ENGINEERING_ALPHA_PROFILE = "local-engineering-alpha";
export const RELEASE_PROFILE_ENV = "ZCODE_DESKTOP_RELEASE_PROFILE";
export const PREVIEW_IDENTITY_ENV = "ZCODE_PREVIEW_IDENTITY";
export const ALPHA_RUNTIME_FAILURE_CODE = "local_alpha_profile_conflict";

const ALPHA_APP_NAME = "AceVra Local Engineering Alpha";
const ALPHA_HOME_NAME = ".zcode-local-engineering-alpha";

export function isLocalEngineeringAlphaProfile(env = process.env) {
  return env?.[RELEASE_PROFILE_ENV]?.trim().toLowerCase() === LOCAL_ENGINEERING_ALPHA_PROFILE;
}

/** Reads the preview switch with the same `1`/`0`/empty semantics as the identity resolver. */
export function readPreviewIdentityRequested(env = process.env) {
  const value = env?.[PREVIEW_IDENTITY_ENV]?.trim() ?? "";
  if (value === "1") return true;
  if (value === "" || value === "0") return false;
  throw new Error(
    `invalid ${PREVIEW_IDENTITY_ENV}=${env?.[PREVIEW_IDENTITY_ENV]}; expected 1 or 0`,
  );
}

export function assertLocalAlphaProfileIsIdentitySafe(env = process.env) {
  if (!isLocalEngineeringAlphaProfile(env)) return;
  if (readPreviewIdentityRequested(env)) {
    throw new Error(
      `[release-profile] ${RELEASE_PROFILE_ENV}=${LOCAL_ENGINEERING_ALPHA_PROFILE} conflicts with ` +
        `${PREVIEW_IDENTITY_ENV}=1: the alpha keeps production identity and must not become Preview`,
    );
  }
}

/**
 * Canonical comparison form for the two explicit roots. `realpath` is used when the path exists
 * (resolving symlinks the way the process will), otherwise a normalized absolute path is used.
 * macOS comparisons are case-insensitive to match the default filesystem.
 */
export function canonicalizeProfileRoot(pathValue, options = {}) {
  const platform = options.platform ?? process.platform;
  let normalized;
  try {
    normalized = realpathSync.native(pathValue);
  } catch {
    normalized = resolve(pathValue);
  }
  const trimmed = normalized.replace(/[\\/]+$/, "") || normalized;
  return platform === "darwin" || platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

export function resolveLocalAlphaDataBaseRoot(options = {}) {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const defaultRoot = join(homeDir, ALPHA_HOME_NAME);
  const desktopHome = env.ZCODE_DESKTOP_HOME_DIR?.trim() || "";
  const dataBaseDir = env.ZCODE_DATA_BASE_DIR?.trim() || "";

  if (desktopHome && dataBaseDir) {
    if (
      canonicalizeProfileRoot(desktopHome, { platform }) !==
      canonicalizeProfileRoot(dataBaseDir, { platform })
    ) {
      throw new Error(
        `[release-profile] profile/path conflict: ZCODE_DESKTOP_HOME_DIR=${desktopHome} and ` +
          `ZCODE_DATA_BASE_DIR=${dataBaseDir} resolve to different roots`,
      );
    }
    return { root: resolve(dataBaseDir), source: "explicit-both" };
  }
  if (dataBaseDir) return { root: resolve(dataBaseDir), source: "data-base-dir" };
  if (desktopHome) return { root: resolve(desktopHome), source: "desktop-home-dir" };
  return { root: resolve(defaultRoot), source: "alpha-default" };
}

/** Exact alpha filesystem contract. Explicit overrides collapse onto one canonical root. */
export function resolveLocalEngineeringAlphaPaths(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const { root: profileHome, source } = resolveLocalAlphaDataBaseRoot({ env, homeDir, platform });
  const appDataBase =
    platform === "darwin"
      ? join(homeDir, "Library", "Application Support")
      : join(homeDir, ".local", "share");
  const userData = join(appDataBase, ALPHA_APP_NAME);

  return {
    profile: LOCAL_ENGINEERING_ALPHA_PROFILE,
    source,
    profileHome,
    dataBaseDir: profileHome,
    zcodeHome: join(profileHome, ".zcode"),
    appConfigDir: join(profileHome, ".zcode", "v2"),
    cuaRoot: join(profileHome, ".zcode", "computer-use"),
    userData,
    sessionData: join(userData, "session"),
  };
}

/**
 * Build/launch environment patch for the alpha. Explicit user overrides stay authoritative:
 * when one override was supplied alone the patch keeps that exact value for both roots.
 */
export function applyLocalEngineeringAlphaEnv(env = process.env, options = {}) {
  assertLocalAlphaProfileIsIdentitySafe(env);
  const paths = resolveLocalEngineeringAlphaPaths({ env, ...options });
  return {
    ...env,
    [RELEASE_PROFILE_ENV]: LOCAL_ENGINEERING_ALPHA_PROFILE,
    ZCODE_DESKTOP_HOME_DIR: env.ZCODE_DESKTOP_HOME_DIR?.trim() || paths.profileHome,
    ZCODE_DATA_BASE_DIR: env.ZCODE_DATA_BASE_DIR?.trim() || paths.profileHome,
    ZCODE_HOME: env.ZCODE_HOME?.trim() || paths.zcodeHome,
    ZCODE_CUA_HOME: env.ZCODE_CUA_HOME?.trim() || paths.profileHome,
  };
}
