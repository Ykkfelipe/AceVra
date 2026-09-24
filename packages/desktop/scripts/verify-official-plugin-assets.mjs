import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const OFFICIAL_COMPUTER_USE_PLUGIN_STAGED_PATH = "packages/zcode-cua-plugin";
export const OFFICIAL_COMPUTER_USE_PLUGIN_REQUIRED_ASSETS = [
  ".zcode-plugin/plugin.json",
  "package.json",
  "docs/computer-use.md",
  "scripts/computer-use-client.mjs",
  "skills/computer-use/SKILL.md",
];

export function verifyPackagedComputerUsePlugin(resourcesDir) {
  const pluginRoot = resolve(resourcesDir, "glm", OFFICIAL_COMPUTER_USE_PLUGIN_STAGED_PATH);
  const missing = OFFICIAL_COMPUTER_USE_PLUGIN_REQUIRED_ASSETS.filter(
    (relativePath) => !existsSync(join(pluginRoot, ...relativePath.split("/"))),
  );
  if (missing.length > 0) {
    throw new Error(
      `[official-plugin] packaged Computer Use plugin is missing: ${missing.join(", ")} (root=${pluginRoot})`,
    );
  }
  const manifest = JSON.parse(
    readFileSync(join(pluginRoot, ".zcode-plugin", "plugin.json"), "utf8"),
  );
  if (manifest.name !== "computer-use") {
    throw new Error(
      `[official-plugin] packaged Computer Use manifest has unexpected name: ${String(manifest.name)}`,
    );
  }
  return pluginRoot;
}

export function verifyPackagedComputerUsePluginFromBuilderContext(context) {
  const resourcesDir =
    context.electronPlatformName === "darwin"
      ? resolve(
          context.appOutDir,
          context.packager.info.framework.distMacOsAppName,
          "Contents",
          "Resources",
        )
      : resolve(context.appOutDir, "resources");
  return verifyPackagedComputerUsePlugin(resourcesDir);
}
