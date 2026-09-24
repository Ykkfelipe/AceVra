import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { officialSeaPlugins } from "../../../apps/zcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs";
import {
  OFFICIAL_COMPUTER_USE_PLUGIN_REQUIRED_ASSETS,
  verifyPackagedComputerUsePlugin,
} from "./verify-official-plugin-assets.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");

async function createPackagedPlugin(resourcesDir, missing = []) {
  const pluginRoot = join(resourcesDir, "glm", "packages", "zcode-cua-plugin");
  for (const relativePath of OFFICIAL_COMPUTER_USE_PLUGIN_REQUIRED_ASSETS) {
    if (missing.includes(relativePath)) continue;
    const filePath = join(pluginRoot, ...relativePath.split("/"));
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(
      filePath,
      relativePath === ".zcode-plugin/plugin.json"
        ? JSON.stringify({ name: "computer-use", version: "0.6.3" })
        : relativePath,
    );
  }
  return pluginRoot;
}

test("desktop and SEA packaging include the real Computer Use package", async () => {
  const desktopPrepare = await import("node:fs/promises").then(({ readFile }) =>
    readFile(resolve(repoRoot, "packages/desktop/scripts/prepare-agent-node-bundle.mjs"), "utf8"),
  );
  assert.match(desktopPrepare, /packageName: "@zcode\/zcode-cua-plugin"/);
  assert.match(desktopPrepare, /stagedPath: "packages\/zcode-cua-plugin"/);

  const seaPlugin = officialSeaPlugins.find((plugin) => plugin.name === "computer-use");
  assert.ok(seaPlugin);
  assert.equal(seaPlugin.packageName, "@zcode/zcode-cua-plugin");
  assert.equal(seaPlugin.rootPath, join("packages", "zcode-cua-plugin"));
  for (const requiredPath of OFFICIAL_COMPUTER_USE_PLUGIN_REQUIRED_ASSETS.slice(1)) {
    assert.ok(seaPlugin.requiredRuntimePaths.includes(requiredPath), requiredPath);
  }
});

test("packaged plugin verification catches a missing Computer Use asset", async () => {
  const resourcesDir = await mkdtemp(join(tmpdir(), "zcode-cua-packaged-test-"));
  try {
    await createPackagedPlugin(resourcesDir);
    assert.ok(existsSync(verifyPackagedComputerUsePlugin(resourcesDir)));

    const incompleteResourcesDir = await mkdtemp(
      join(tmpdir(), "zcode-cua-packaged-missing-test-"),
    );
    try {
      await createPackagedPlugin(incompleteResourcesDir, ["skills/computer-use/SKILL.md"]);
      assert.throws(
        () => verifyPackagedComputerUsePlugin(incompleteResourcesDir),
        /missing: skills\/computer-use\/SKILL\.md/,
      );
    } finally {
      await rm(incompleteResourcesDir, { recursive: true, force: true });
    }
  } finally {
    await rm(resourcesDir, { recursive: true, force: true });
  }
});
