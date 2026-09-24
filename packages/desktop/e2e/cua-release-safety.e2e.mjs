#!/usr/bin/env node
import assert from "node:assert/strict";
import { resolve } from "node:path";

const runId = process.env.ZCODE_DESKTOP_E2E_RUN_ID?.trim();
if (!runId || process.env.ZCODE_DESKTOP_E2E !== "1") {
  throw new Error("CUA alpha E2E requires the real E2E run id and build flag");
}

const { _electron: electron } = await import("playwright-core");
const app = await electron.launch({
  executablePath: resolve("../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
  args: ["--no-sandbox", "--disable-gpu", resolve(".")],
  cwd: process.cwd(),
  env: { ...process.env, ZCODE_DESKTOP_E2E: "1", ZCODE_DESKTOP_E2E_RUN_ID: runId },
});
try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const title = await page.title();
  assert.match(title, /^(AceVra|Electron)$/);
  const body = await page.locator("body").innerText();
  assert.match(body, /local engineering alpha/i);
  assert.doesNotMatch(body, /Stop computer control/i);
  console.log(`[e2e:cua-alpha] ${runId}: safety copy and default-off assertion passed`);
} finally {
  await app.close();
}
