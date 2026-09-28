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
  verifyPackagedComputerUseBootstrapContract(pluginRoot);
  return pluginRoot;
}

/**
 * The bootstrap the Computer Use skill documents must resolve inside the packaged official plugin,
 * and it must be the package's own `main`.
 *
 * Why this is asserted from the *packaged* tree rather than trusting the source: the model reads the
 * skill from a materialized seed whose base directory is the skill folder, so a document that names
 * `scripts/computer-use-client.mjs` without saying "plugin package root" invites the model to resolve
 * it under `skills/computer-use/`, fail, and then search for an alternative. Tying the documented
 * path, the packaged file and the package `main` together makes that ambiguity a packaging error
 * instead of a live discovery task, and a user plugin elsewhere cannot satisfy it because only this
 * root is verified.
 */
export function verifyPackagedComputerUseBootstrapContract(pluginRoot) {
  const bootstrapRelativePath = "scripts/computer-use-client.mjs";
  const skill = readFileSync(join(pluginRoot, "skills", "computer-use", "SKILL.md"), "utf8");
  const docs = readFileSync(join(pluginRoot, "docs", "computer-use.md"), "utf8");
  for (const [label, text] of [
    ["skill", skill],
    ["docs", docs],
  ]) {
    if (!text.includes(bootstrapRelativePath)) {
      throw new Error(
        `[official-plugin] packaged Computer Use ${label} does not name the bootstrap (${bootstrapRelativePath})`,
      );
    }
    if (text.includes("skills/computer-use/scripts/")) {
      throw new Error(
        `[official-plugin] packaged Computer Use ${label} points at a skill-relative scripts path; ` +
          "the bootstrap lives at the plugin package root",
      );
    }
    if (!text.includes("plugin package root")) {
      throw new Error(
        `[official-plugin] packaged Computer Use ${label} must state that the bootstrap is at the ` +
          "plugin package root, not relative to the skill directory",
      );
    }
  }
  const packageJson = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));
  if (packageJson.main !== `./${bootstrapRelativePath}`) {
    throw new Error(
      `[official-plugin] packaged Computer Use package main is not the documented bootstrap: ` +
        `${String(packageJson.main)}`,
    );
  }
  return join(pluginRoot, ...bootstrapRelativePath.split("/"));
}

export function verifyPackagedComputerUsePluginFromBuilderContext(context) {
  const resourcesDir =
    context.electronPlatformName === "darwin"
      ? resolve(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources",
        )
      : resolve(context.appOutDir, "resources");
  return verifyPackagedComputerUsePlugin(resourcesDir);
}
