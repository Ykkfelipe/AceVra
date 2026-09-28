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
    await writeFile(filePath, packagedAssetFixture(relativePath));
  }
  return pluginRoot;
}

/**
 * Content for a synthetic packaged plugin. The verifier asserts the documented-bootstrap contract
 * (the skill and docs name `scripts/computer-use-client.mjs` at the plugin package root, and it is
 * the package `main`), so a fixture that writes the path as its own contents would only exercise the
 * missing-asset branch and fail the contract branch instead.
 */
function packagedAssetFixture(relativePath) {
  if (relativePath === ".zcode-plugin/plugin.json") {
    return JSON.stringify({ name: "computer-use", version: "0.6.3" });
  }
  if (relativePath === "package.json") {
    return JSON.stringify({
      name: "@zcode/zcode-cua-plugin",
      version: "0.6.3",
      main: "./scripts/computer-use-client.mjs",
    });
  }
  if (relativePath === "skills/computer-use/SKILL.md" || relativePath === "docs/computer-use.md") {
    return [
      "The compatibility bootstrap is `scripts/computer-use-client.mjs` at the plugin package root",
      "(the directory containing the `skills/` folder), and `package.json` declares it as `main`.",
    ].join(" ");
  }
  return relativePath;
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

test("packaged plugin verification rejects an ambiguous bootstrap path in the skill", async () => {
  const resourcesDir = await mkdtemp(join(tmpdir(), "zcode-cua-packaged-ambiguous-test-"));
  try {
    await createPackagedPlugin(resourcesDir);
    // The failure mode observed in packaged acceptance: the document names the bootstrap without
    // saying where it lives, so a model resolving it from the skill directory looks under
    // `skills/computer-use/scripts/`, finds nothing, and starts searching for an alternative.
    await writeFile(
      join(
        resourcesDir,
        "glm",
        "packages",
        "zcode-cua-plugin",
        "skills",
        "computer-use",
        "SKILL.md",
      ),
      "The package's `scripts/computer-use-client.mjs` is the compatibility bootstrap.",
    );
    assert.throws(() => verifyPackagedComputerUsePlugin(resourcesDir), /plugin package root/);
  } finally {
    await rm(resourcesDir, { recursive: true, force: true });
  }
});

test("packaged plugin verification refuses a skill that points inside the skill directory", async () => {
  const resourcesDir = await mkdtemp(join(tmpdir(), "zcode-cua-packaged-skill-relative-test-"));
  try {
    await createPackagedPlugin(resourcesDir);
    await writeFile(
      join(
        resourcesDir,
        "glm",
        "packages",
        "zcode-cua-plugin",
        "skills",
        "computer-use",
        "SKILL.md",
      ),
      "Import the bootstrap from skills/computer-use/scripts/computer-use-client.mjs.",
    );
    assert.throws(
      () => verifyPackagedComputerUsePlugin(resourcesDir),
      /skill-relative scripts path/,
    );
  } finally {
    await rm(resourcesDir, { recursive: true, force: true });
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
