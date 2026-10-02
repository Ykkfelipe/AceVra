import { homedir } from "node:os";
import { join } from "node:path";
import { shouldSanitizeZCodeRuntimeEnvKey } from "../packages/shared/src/runtimeEnv.ts";

const PROCESS_IDENTITY_KEYS = new Set([
  "NODE_ENV",
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_RENDERER_URL",
  "ZCODE_CUA_LAUNCHER_PID",
  "ZCODE_CUA_BUNDLED_HELPER_APP_PATH",
  "ZCODE_CUA_PEER_IDENTITY_PROBE",
  "ZCODE_CUA_PACKAGED_RESOURCES_DIR",
  "ZCODE_CUA_NODE_REPL_HOST",
  "ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE",
  "ZCODE_PLUGIN_ROOT",
  "ZCODE_CUA_PLUGIN_ROOT",
  "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
  "ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE",
  "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
  "ZCODE_TOOL_ENV_PASSTHROUGH_JSON",
  "ZCODE_BUILD_COMMIT_ID",
  "ZCODE_BUILD_TIME",
  "ZCODE_APP_VERSION",
]);
const FOREIGN_CONFIGURATION_KEYS = new Set([
  "ZCODE_BASE_URL",
  "ZCODE_ENDPOINT_ORIGIN",
  "VITE_ZCODE_BASE_URL",
  "VITE_ZCODE_ENDPOINT_ORIGIN",
  "ZCODE_DATA_BASE_DIR",
  "ZCODE_HOME",
  "ZCODE_DESKTOP_HOME_DIR",
  "ZCODE_DESKTOP_APPLICATION_NAME",
  "ZCODE_DESKTOP_PROTOCOL_SCHEME",
  "ZCODE_DESKTOP_USER_DATA_DIR",
  "ZCODE_DESKTOP_SESSION_DATA_DIR",
  "ZCODE_CUA_HELPER_INSTALL_VARIANT",
  "ZCODE_CUA_HOME",
  "ZCODE_AGENT_SERVER_COMMAND",
  "ZCODE_AGENT_SERVER_ARGS_JSON",
  "ZCODE_AGENT_SERVER_CWD",
  "ZCODE_PRODUCT_FLAVOR",
  "ZCODE_PREVIEW_IDENTITY",
  "ZCODE_RELEASE_PROFILE",
]);

const LOCAL_PATH_OVERRIDES = new Set([
  "ZCODE_CUA_BUNDLED_HELPER_APP_PATH",
  "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
  "ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE",
  "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
]);

function processIdentity(key) {
  return (
    PROCESS_IDENTITY_KEYS.has(key) ||
    ((key.startsWith("ZCODE_CUA_") || key.startsWith("ZCODE_TELEMETRY_")) &&
      shouldSanitizeZCodeRuntimeEnvKey(key))
  );
}

export function createDesktopDevRuntimeEnvironment(
  inherited,
  local = {},
  requestedEnv = "production",
  home = homedir(),
) {
  // 修复依据：从已安装 ZCode 启动的 shell 带有上一运行时的路径/身份；新 Dev 不能复用它们。
  // 清洁 shell 的显式测试配置继续保留，仓库 .env.local 是可审查的配置来源。
  const foreignParent =
    Boolean(
      inherited.ZCODE_CUA_LAUNCHER_PID?.trim() ||
      inherited.ZCODE_BUILD_COMMIT_ID?.trim() ||
      inherited.ZCODE_CUA_PERMISSION_BROKER_SOCKET?.trim() ||
      inherited.ZCODE_CUA_PACKAGED_RESOURCES_DIR?.trim(),
    ) ||
    Object.entries(inherited).some(
      ([key, value]) =>
        /(?:HELPER_APP_PATH|PROVIDER.*CONFIG_FILE|PLUGIN_ROOT)$/.test(key) &&
        /[\\/]Applications[\\/].*\.app[\\/]|[\\/]ZCode(?: Preview)?[\\/]resources[\\/]/i.test(
          value ?? "",
        ),
    );
  const env = Object.fromEntries(
    Object.entries(inherited).filter(
      ([key, value]) =>
        value !== undefined &&
        (!processIdentity(key) || (!foreignParent && LOCAL_PATH_OVERRIDES.has(key))) &&
        !(foreignParent && FOREIGN_CONFIGURATION_KEYS.has(key)),
    ),
  );
  for (const [key, value] of Object.entries(local)) {
    if (
      value !== undefined &&
      env[key] === undefined &&
      (!processIdentity(key) || LOCAL_PATH_OVERRIDES.has(key))
    ) {
      env[key] = value;
    }
  }
  if (
    ["1", "true", "on"].includes(env.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL?.trim().toLowerCase()) &&
    !env.ZCODE_CUA_BUNDLED_HELPER_APP_PATH?.trim()
  ) {
    // 开发构建器的固定产物根；避免每个数据 profile 都要手工复制/链接一份 Helper。
    env.ZCODE_CUA_BUNDLED_HELPER_APP_PATH = join(
      env.ZCODE_CUA_HOME?.trim() || join(home, ".zcode-fork-cua-home"),
      ".zcode",
      "computer-use",
      "dev",
      "AceVra Computer Use Dev.app",
    );
  }
  return { ...env, ZCODE_ENV: requestedEnv, ZCODE_RUNTIME_ENV: "development" };
}
