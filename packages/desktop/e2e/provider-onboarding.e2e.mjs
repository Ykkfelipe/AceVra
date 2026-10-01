#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { createIsolatedRoots, startInferenceFixture, SENTINEL_KEY } from "./onboarding-fixture.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await startInferenceFixture();
const results = [];
async function runScenario(scenario) {
  const roots = await createIsolatedRoots();
  const env = {
    ...process.env,
    HOME: roots.home,
    ZCODE_DESKTOP_HOME_DIR: roots.profile,
    ZCODE_DATA_BASE_DIR: roots.profile,
    ZCODE_HOME: join(roots.profile, ".zcode"),
    ZCODE_DESKTOP_USER_DATA_DIR: roots.userData,
    ZCODE_DESKTOP_SESSION_DATA_DIR: join(roots.userData, "s"),
    ZCODE_DESKTOP_APPLICATION_NAME: `AceVra Test ${roots.root.split("/").at(-1)}`,
    ZCODE_BASE_URL: fixture.origin,
    ZCODE_ENDPOINT_ORIGIN: fixture.origin,
  };
  for (const key of Object.keys(env)) {
    if (
      /SKIP_PROVIDER_LOGIN|FORK_DEV|FORK_PROVIDER_IMPORT|CREDENTIAL_SECRET|API_KEY|AUTH_TOKEN|E2E_CUA_ACTIVE/.test(
        key,
      )
    )
      delete env[key];
  }
  const launchOptions = {
    executablePath: resolve(
      desktop,
      "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [desktop, "--no-sandbox", "--disable-gpu"],
    cwd: desktop,
    env,
    timeout: 30000,
  };
  let app = await electron.launch(launchOptions);
  try {
    const page = await app.firstWindow();
    await page.getByTestId("acevra-first-run").waitFor({ timeout: 60000 });
    if (scenario === "deferred") {
      await page.getByTestId("acevra-configure-later").click();
    } else {
      await page.getByTestId("acevra-provider-compatible").click();
      await page.locator("#setup-endpoint").fill(`${fixture.origin}/v1`);
      await page.locator("#setup-key").fill(SENTINEL_KEY);
      await page.locator("#setup-model").fill("acevra-fixture");
      await page.getByRole("button", { name: "Connect", exact: true }).click();
    }
    await page.getByTestId("acevra-first-run").waitFor({ state: "hidden", timeout: 30000 });
    // Complete the existing three-page preferences flow through its normal UI.
    await page.getByText("What do you do?", { exact: true }).waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await page.getByText("Choose your UI mode", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await page.getByText("Personalize your work assistant", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    // Prefer the default conversation workspace created by the normal completion callback.
    await page.getByTestId("task-settings-button").first().waitFor({ timeout: 30000 });
    const settingPath = join(roots.profile, ".zcode/v2/setting.json");
    const settings = JSON.parse(await readFile(settingPath, "utf8"));
    assert.ok(!settings.providerFamilyDomain, "first-run must not manufacture provider family");
    const result = { scenario, roots, family: settings.providerFamilyDomain ?? null };
    if (scenario === "deferred") {
      const state = JSON.parse(
        await readFile(join(roots.profile, ".zcode/v2/acevra-setup.json"), "utf8"),
      );
      assert.equal(state.deferred, true);
      result.state = state;
      const input = page.getByTestId("v4-composer-input");
      await input.fill("Attempt inference while deferred.");
      await input.press("Enter");
      await page
        .getByText("Connect a provider and select a model in Settings to start a conversation.", {
          exact: true,
        })
        .waitFor({ timeout: 15000 });
      result.inference = "connection-required";
      await page.getByTestId("task-settings-button").first().click();
      await page.getByTestId("settings-section-nav-modelProvider").waitFor({ timeout: 10000 });
      result.settingsAccessible = true;
    } else {
      const input = page.locator('[data-testid="v4-composer-input"]');
      await input.waitFor({ timeout: 30000 });
      await input.fill("Reply with the fixture confirmation.");
      await input.press("Enter");
      await page
        .getByText("AceVra fixture inference complete.", { exact: false })
        .first()
        .waitFor({ timeout: 60000 });
      assert.ok(fixture.requests.some((item) => item.model === "acevra-fixture"));
      result.inference = "completed";
      result.requests = [...fixture.requests];
      const logsDir = join(roots.profile, ".zcode/v2/logs");
      const logs = (
        await Promise.all(
          (
            await readdir(logsDir)
          )
            .filter((file) => file.endsWith(".log"))
            .map((file) => readFile(join(logsDir, file), "utf8")),
        )
      ).join("\n");
      assert.match(logs, /ZCode agent process started/);
      assert.match(logs, /v4 conversation subscription started/);
      const started = JSON.parse(logs.match(/ZCode agent process started (\{[^\n]+\})/)[1]);
      result.runtime = { pid: started.pid, workspaceKey: started.workspaceKey };
      result.agentProcessCreated = true;
      result.sessionCreated = true;
      result.sessionId = logs.match(/"sessionId":"(sess_[^"]+)"/)?.[1];
      await app.close();
      app = await electron.launch(launchOptions);
      const reopened = await app.firstWindow();
      await reopened.getByTestId("task-settings-button").first().waitFor({ timeout: 30000 });
      assert.equal(await reopened.getByTestId("acevra-first-run").count(), 0);
      result.existingProfileStartup = "allowed";
    }
    results.push(result);
    console.log(JSON.stringify(result));
  } catch (error) {
    const page = await app.firstWindow();
    await writeFile(join(roots.root, "failure.txt"), await page.locator("body").innerText());
    await page.screenshot({ path: join(roots.root, "failure.png") });
    console.error(`Acceptance failed; isolated evidence: ${roots.root}`);
    throw error;
  } finally {
    await app.close();
  }
}
try {
  for (const scenario of process.argv[2] ? [process.argv[2]] : ["deferred", "compatible"])
    await runScenario(scenario);
} finally {
  await fixture.close();
}
