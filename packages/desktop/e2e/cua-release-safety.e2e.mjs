#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const runId = process.env.ZCODE_DESKTOP_E2E_RUN_ID?.trim();
if (!runId || process.env.ZCODE_DESKTOP_E2E !== "1") {
  throw new Error("CUA alpha E2E requires the real E2E run id and build flag");
}

const { _electron: electron } = await import("playwright-core");
const packagedAppPath = process.env.ZCODE_DESKTOP_E2E_APP_PATH?.trim();
const executablePath = packagedAppPath
  ? resolve(packagedAppPath, "Contents/MacOS/AceVra")
  : resolve("../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
if (packagedAppPath) {
  const pluginRoot = resolve(packagedAppPath, "Contents/Resources/glm/packages/zcode-cua-plugin");
  for (const relativePath of [
    ".zcode-plugin/plugin.json",
    "docs/computer-use.md",
    "scripts/computer-use-client.mjs",
    "skills/computer-use/SKILL.md",
  ]) {
    if (!existsSync(resolve(pluginRoot, relativePath))) {
      throw new Error(`packaged Computer Use plugin asset is missing: ${relativePath}`);
    }
  }
}

async function runScenario({ active }) {
  console.log(`[e2e:cua-alpha] ${runId}: starting ${active ? "active" : "default-off"} scenario`);
  const homeRoot = mkdtempSync(join(tmpdir(), "acevra-cua-alpha-home-"));
  const profileRoot = mkdtempSync(join(tmpdir(), "acevra-cua-alpha-profile-"));
  const dataRoot = profileRoot;
  const app = await electron.launch({
    executablePath,
    args: packagedAppPath
      ? [packagedAppPath, "--no-sandbox", "--disable-gpu"]
      : ["--no-sandbox", "--disable-gpu", resolve(".")],
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homeRoot,
      ZCODE_DESKTOP_HOME_DIR: profileRoot,
      ZCODE_DATA_BASE_DIR: profileRoot,
      ZCODE_HOME: join(profileRoot, ".zcode"),
      ZCODE_DESKTOP_E2E: "1",
      ZCODE_DESKTOP_E2E_RUN_ID: runId,
      ZCODE_E2E_RUN_ID: runId,
      ZCODE_DESKTOP_E2E_PERMISSION_OPEN: "1",
      ...(active ? { ZCODE_DESKTOP_E2E_CUA_ACTIVE: "1" } : {}),
    },
  });
  try {
    const page = await app.firstWindow();
    await page.locator('html[data-desktop-business-ready="true"]').waitFor({ state: "attached" });
    const title = await page.title();
    assert.match(title, /^(AceVra|Electron)$/);
    const occupationPrompt = page.getByText("What do you do?", { exact: true });
    try {
      await occupationPrompt.waitFor({ state: "visible", timeout: 10_000 });
      await page.keyboard.press("Escape");
      await occupationPrompt.waitFor({ state: "hidden" });
    } catch {
      // A packaged app may already be past first-run onboarding.
    }
    const settingsButton = page.getByTestId("task-settings-button").first();
    await settingsButton.waitFor({ state: "visible" });
    await settingsButton.click();
    const section = page.getByTestId("settings-section-nav-computerUse");
    await section.waitFor({ state: "visible" });
    await section.click();
    const safetyCopy = page.getByText("AceVra local engineering alpha", { exact: true });
    await safetyCopy.waitFor({ state: "visible" });
    const stop = page.getByTestId("cua-stop-computer-control");
    if (!active) {
      assert.equal(await stop.count(), 0);
      const enableToggle = page.getByLabel("Enable Computer Use");
      await enableToggle.click();
      for (let attempt = 0; attempt < 30 && !(await enableToggle.isChecked()); attempt += 1) {
        await page.waitForTimeout(100);
      }
      assert.equal(await enableToggle.isChecked(), true);
      assert.equal(await page.getByText(/Plugin not found/).count(), 0);
      assert.equal(
        await import("node:fs/promises").then(({ access }) =>
          access(join(profileRoot, ".zcode", "cli", "config.json")).then(
            () => true,
            () => false,
          ),
        ),
        true,
        "isolated alpha plugin config should be written under ZCODE_HOME",
      );
      const composerToggle = page.getByLabel("Show Computer Use button in the composer");
      await composerToggle.click();
      for (let attempt = 0; attempt < 30 && !(await composerToggle.isChecked()); attempt += 1) {
        await page.waitForTimeout(100);
      }
      assert.equal(await composerToggle.isChecked(), true);
      for (const name of ["Open Accessibility Settings", "Open Screen Recording"]) {
        const button = page.getByRole("button", { name });
        await button.waitFor({ state: "visible" });
        for (let attempt = 0; attempt < 30 && !(await button.isEnabled()); attempt += 1) {
          await page.waitForTimeout(100);
        }
        assert.equal(await button.isEnabled(), true, `${name} should cross the packaged bridge`);
        await button.click();
      }
      assert.equal(await page.getByText(/Plugin not found/).count(), 0);
      console.log(
        `[e2e:cua-alpha] ${runId}: default-off plugin enablement and permission links passed`,
      );
      return;
    }
    await stop.waitFor({ state: "visible" });
    await stop.click();
    await page.getByTestId("cua-stop-computer-control").waitFor({ state: "detached" });
    console.log(`[e2e:cua-alpha] ${runId}: ${active ? "active" : "default-off"} scenario passed`);
  } finally {
    await app.close();
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(homeRoot, { recursive: true, force: true });
  }
}

await runScenario({ active: true });
await runScenario({ active: false });
console.log(
  `[e2e:cua-alpha] ${runId}: business-ready navigation, default-off, active Stop, and released projection passed`,
);
