import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LOCAL_ENGINEERING_ALPHA_RELEASE_PROFILE, ZCODE_RELEASE_PROFILE } from "@zcode/shared";
import { setDataBaseDir } from "@zcode/services/node";
import {
  assertLocalAlphaProfileIsIdentitySafe,
  isLocalEngineeringAlphaProfile,
  resolveLocalEngineeringAlphaPaths,
} from "../../scripts/desktop-release-profile.mjs";

function isLocalAlphaBootstrapProfile(): boolean {
  return (
    isLocalEngineeringAlphaProfile(process.env) ||
    ZCODE_RELEASE_PROFILE === LOCAL_ENGINEERING_ALPHA_RELEASE_PROFILE
  );
}

function resolveBootstrapSettingsFile(homePath: string = homedir()): string {
  const configuredHome = process.env.ZCODE_DESKTOP_HOME_DIR?.trim() || homePath;
  return join(configuredHome, ".zcode", "v2", "setting.json");
}

function extractBootstrapDataBaseDir(rawValue: unknown): string | null {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const dataBaseDir = (rawValue as { dataBaseDir?: unknown }).dataBaseDir;
  if (typeof dataBaseDir !== "string") {
    return null;
  }

  const trimmed = dataBaseDir.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBootstrapDataBaseDirFromDisk(
  settingsFile: string = resolveBootstrapSettingsFile(),
): string | null {
  if (!existsSync(settingsFile)) {
    return null;
  }

  try {
    const raw = readFileSync(settingsFile, "utf-8");
    return extractBootstrapDataBaseDir(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Local engineering alpha is resolved before any settings file is consulted. The profile's
 * explicit-root conflict rule is enforced here, the canonical roots are published to the
 * process environment (so every direct-HOME reader and child host agrees), and the production
 * sentinel file path can never be reached because the profile home is already swapped.
 */
function applyLocalEngineeringAlphaBootstrap(): string {
  assertLocalAlphaProfileIsIdentitySafe(process.env);
  const paths = resolveLocalEngineeringAlphaPaths({ env: process.env });
  process.env.ZCODE_DESKTOP_RELEASE_PROFILE = LOCAL_ENGINEERING_ALPHA_RELEASE_PROFILE;
  process.env.ZCODE_DESKTOP_HOME_DIR = paths.profileHome;
  process.env.ZCODE_DATA_BASE_DIR = paths.dataBaseDir;
  process.env.ZCODE_HOME = paths.zcodeHome;
  // 启动早期就把 dataBaseDir 注入进来，避免 logger / crashReporter 先按默认 HOME 建目录。
  setDataBaseDir(paths.dataBaseDir);
  return paths.dataBaseDir;
}

export function applyEarlyDataBaseDirBootstrap(): string | null {
  if (isLocalAlphaBootstrapProfile()) {
    return applyLocalEngineeringAlphaBootstrap();
  }

  const dataBaseDir = readBootstrapDataBaseDirFromDisk();
  if (dataBaseDir) {
    // 启动早期就把 dataBaseDir 注入进来，避免 logger / crashReporter 先按默认 HOME 建目录，
    // 导致后续再切换到自定义目录时，日志和 crash dump 落在两套路径里。
    setDataBaseDir(dataBaseDir);
  }
  return dataBaseDir;
}
