#!/usr/bin/env node
/* eslint-disable max-lines -- 验收脚本按场景线性叙述（A–F），拆文件会割裂共享的 backend/fixture 装配。 */
// M2A acceptance. Run through scripts/run-account-e2e.mjs (needs tsx for the backend).
// Real Electron app, isolated profile per scenario, real AceVra backend code (Hono +
// Clerk token verification + PostgreSQL semantics via PGlite) and a deterministic test
// session token instead of an interactive Clerk login.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { _electron as electron } from "playwright-core";
import { createIsolatedRoots, startInferenceFixture, SENTINEL_KEY } from "./onboarding-fixture.mjs";
import { createTestApp, signSessionToken } from "../../account-api/test/helpers.ts";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await startInferenceFixture();

const USERS = {
  user_admitted: {
    displayName: "Ada Admitted",
    avatarUrl: null,
    verifiedEmails: ["ada@example.test"],
  },
  user_other: {
    displayName: "Olive Other",
    avatarUrl: null,
    verifiedEmails: ["olive@example.test"],
  },
  user_stranger: {
    displayName: "Sam Stranger",
    avatarUrl: null,
    verifiedEmails: ["sam@example.test"],
  },
};
const backend = await createTestApp({ users: USERS, nodeGraceMs: 2000, realClock: true });
await backend.ledger.approve({ clerkUserId: "user_admitted" });
const listener = await backend.listen();
const backendOrigin = () => listener.url;
const DEAD_ORIGIN = "http://127.0.0.1:9"; // discard port: connection refused

const results = [];
function launchEnv(roots, { apiBase, user, engineering = false }) {
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
      /SKIP_PROVIDER_LOGIN|FORK_DEV|FORK_PROVIDER_IMPORT|CREDENTIAL_SECRET|API_KEY|AUTH_TOKEN|E2E_CUA_ACTIVE|ACEVRA_/.test(
        key,
      )
    )
      delete env[key];
  }
  if (apiBase) {
    env.ACEVRA_API_BASE_URL = apiBase;
    env.ACEVRA_ACCOUNT_TEST_TOKEN = signSessionToken({ sub: user, expOffsetSec: 3600 });
  }
  // M2E：原始进程表单只是工程 harness，仅在显式开启（且未打包）时出现。
  if (engineering) env.ACEVRA_ENGINEERING_TOOLS = "1";
  return env;
}
const launch = (env) =>
  electron.launch({
    executablePath: resolve(
      desktop,
      "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [desktop, "--no-sandbox", "--disable-gpu"],
    cwd: desktop,
    env,
    timeout: 30000,
  });

async function connectProvider(page) {
  await page.getByTestId("acevra-first-run").waitFor({ timeout: 60000 });
  await page.getByTestId("acevra-provider-compatible").click();
  await page.locator("#setup-endpoint").fill(`${fixture.origin}/v1`);
  await page.locator("#setup-key").fill(SENTINEL_KEY);
  await page.locator("#setup-model").fill("acevra-fixture");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByTestId("acevra-first-run").waitFor({ state: "hidden", timeout: 30000 });
}
async function skipPreferences(page) {
  await page.getByText("What do you do?", { exact: true }).waitFor({ timeout: 15000 });
  for (const next of ["Choose your UI mode", "Personalize your work assistant"]) {
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await page.getByText(next, { exact: true }).waitFor();
  }
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await page.getByTestId("task-settings-button").first().waitFor({ timeout: 30000 });
}
async function infer(page, prompt) {
  const input = page.locator('[data-testid="v4-composer-input"]');
  await input.waitFor({ timeout: 30000 });
  await input.fill(prompt);
  await input.press("Enter");
  await page
    .getByText("AceVra fixture inference complete.", { exact: false })
    .first()
    .waitFor({ timeout: 60000 });
}
async function openAccountSection(page) {
  await page.getByTestId("task-settings-button").first().click();
  await page.getByTestId("settings-section-nav-aceVraAccount").click();
  await page.getByTestId("acevra-account-section").waitFor({ timeout: 10000 });
}
// Optional visual-review evidence (isolated profile only): E2E_SCREENSHOT_DIR=<dir>.
async function snap(target, name) {
  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await target.screenshot({ path: join(dir, `${name}.png`) });
}
async function backToWorkspace(page) {
  await page.keyboard.press("Escape");
  await page
    .getByText("Back to workspace")
    .click({ timeout: 3000 })
    .catch(() => {});
  await page.getByTestId("v4-composer-input").waitFor({ timeout: 30000 });
}
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const only = process.argv[2];
async function scenario(name, run) {
  if (only && !name.startsWith(only)) return;
  const roots = await createIsolatedRoots();
  const ctx = { roots, apps: [] };
  try {
    const result = (await run(ctx)) ?? {};
    results.push({ scenario: name, ...result });
    console.log(JSON.stringify({ scenario: name, ...result }));
  } catch (error) {
    const app = ctx.apps.at(-1);
    try {
      const page = await app.firstWindow();
      await writeFile(join(roots.root, "failure.txt"), await page.locator("body").innerText());
      await page.screenshot({ path: join(roots.root, "failure.png") });
    } catch {}
    console.error(`Scenario ${name} failed; isolated evidence: ${roots.root}`);
    throw error;
  } finally {
    await Promise.all(ctx.apps.map((app) => app.close().catch(() => {})));
  }
}
const open = async (ctx, options) => {
  const app = await launch(launchEnv(ctx.roots, options));
  ctx.apps.push(app);
  return { app, page: await app.firstWindow() };
};

// A. Fresh profile, account configured but backend DOWN: Continue locally works, no Clerk.
await scenario("A-local-backend-offline", async (ctx) => {
  const { page } = await open(ctx, { apiBase: DEAD_ORIGIN, user: "user_admitted" });
  await connectProvider(page);
  await page.getByTestId("acevra-account-choice").waitFor({ timeout: 30000 });
  await page.getByTestId("acevra-account-signin").click();
  await page
    .getByTestId("acevra-account-status")
    .getByText("unreachable", { exact: false })
    .waitFor({ timeout: 30000 });
  await page.getByTestId("acevra-account-local").click();
  await page.getByTestId("acevra-account-choice").waitFor({ state: "hidden" });
  await skipPreferences(page);
  await infer(page, "Reply with the fixture confirmation.");
  assert.ok(fixture.requests.some((r) => r.model === "acevra-fixture"));
  assert.equal((await readJson(join(ctx.roots.userData, "acevra-account.json"))).choice, "local");
  return { startup: "local-usable-backend-offline", inference: "completed" };
});

// B. Admitted account + provider; sign out preserves provider; relaunch keeps everything.
await scenario("B-admitted-then-logout", async (ctx) => {
  const { app, page } = await open(ctx, { apiBase: backendOrigin(), user: "user_admitted" });
  await connectProvider(page);
  await page.getByTestId("acevra-account-choice").waitFor({ timeout: 30000 });
  const providerBefore = await readFile(
    join(ctx.roots.profile, ".zcode/v2/provider_config.json"),
    "utf8",
  );
  await page.getByTestId("acevra-account-signin").click();
  await page.getByTestId("acevra-account-choice").waitFor({ state: "hidden", timeout: 30000 });
  await skipPreferences(page);
  await openAccountSection(page);
  await page
    .getByTestId("acevra-account-profile")
    .getByText("Ada Admitted")
    .waitFor({ timeout: 15000 });
  await page
    .getByTestId("acevra-account-status")
    .getByText("private alpha", { exact: false })
    .waitFor();
  // Secrets/tokens never reach the renderer.
  const exposure = await page.evaluate(() =>
    JSON.stringify([
      document.documentElement.outerHTML,
      { ...localStorage },
      Object.keys(window.zcode.account),
    ]),
  );
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\./.test(exposure), "no JWT in renderer");
  assert.ok(!/sk_(test|live)_|DATABASE_URL/.test(exposure), "no backend secret in renderer");
  // Provider + account coexist: inference works while signed in.
  await page.keyboard.press("Escape");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload());
  await page.getByTestId("task-settings-button").first().waitFor({ timeout: 30000 });
  await infer(page, "Reply while signed in.");
  // Sign out: account cleared; provider config, setup state and inference intact.
  await openAccountSection(page);
  await page.getByTestId("acevra-account-signout").click();
  await page.getByTestId("acevra-account-settings-signin").waitFor({ timeout: 15000 });
  assert.equal(
    await readFile(join(ctx.roots.profile, ".zcode/v2/provider_config.json"), "utf8"),
    providerBefore,
    "provider config untouched by sign-out",
  );
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload());
  // A fresh UI session with the choice still undecided asks again; local mode is one click.
  await page.getByTestId("acevra-account-choice").waitFor({ timeout: 30000 });
  await page.getByTestId("acevra-account-local").click();
  await infer(page, "Reply after sign-out.");
  // Relaunch (existing profile): no first-run, conversations present, no account reset.
  await app.close();
  const second = await open(ctx, { apiBase: backendOrigin(), user: "user_admitted" });
  await second.page.getByTestId("task-settings-button").first().waitFor({ timeout: 30000 });
  assert.equal(await second.page.getByTestId("acevra-first-run").count(), 0);
  // "Continue locally" was chosen earlier in this profile: the account step stays out of the way.
  assert.equal(await second.page.getByTestId("acevra-account-choice").count(), 0);
  await second.page
    .getByText("AceVra fixture inference complete", { exact: false })
    .first()
    .waitFor({ timeout: 30000 });
  assert.equal(
    await readFile(join(ctx.roots.profile, ".zcode/v2/provider_config.json"), "utf8"),
    providerBefore,
    "provider config not rewritten by sign-in",
  );
  return {
    signedIn: "ready+profile",
    logout: "provider config preserved",
    existingProfile: "conversations preserved, onboarding not reset",
  };
});

// C. Authenticated but not admitted: denial, then local mode.
await scenario("C-not-admitted", async (ctx) => {
  const { page } = await open(ctx, { apiBase: backendOrigin(), user: "user_stranger" });
  await connectProvider(page);
  await page.getByTestId("acevra-account-choice").waitFor({ timeout: 30000 });
  await page.getByTestId("acevra-account-signin").click();
  await page
    .getByTestId("acevra-account-status")
    .getByText("private alpha", { exact: false })
    .waitFor({ timeout: 30000 });
  assert.match(
    await page.getByTestId("acevra-account-status").innerText(),
    /isn't part of the private alpha/,
  );
  await page.getByTestId("acevra-account-local").click();
  await skipPreferences(page);
  await infer(page, "Reply with the fixture confirmation.");
  return { denial: "shown", localMode: "usable" };
});

// D. Signed in, no provider configured: account works, inference asks for a provider.
await scenario("D-account-without-provider", async (ctx) => {
  const { page } = await open(ctx, { apiBase: backendOrigin(), user: "user_admitted" });
  await page.getByTestId("acevra-first-run").waitFor({ timeout: 60000 });
  await page.getByTestId("acevra-configure-later").click();
  await page.getByTestId("acevra-account-choice").waitFor({ timeout: 30000 });
  await page.getByTestId("acevra-account-signin").click();
  await page.getByTestId("acevra-account-choice").waitFor({ state: "hidden", timeout: 30000 });
  await skipPreferences(page);
  const input = page.getByTestId("v4-composer-input");
  await input.fill("Attempt inference without a provider.");
  await input.press("Enter");
  await page
    .getByText("Connect a provider and select a model in Settings to start a conversation.", {
      exact: true,
    })
    .waitFor({ timeout: 15000 });
  await openAccountSection(page);
  await page.getByTestId("acevra-account-profile").getByText("Ada Admitted").waitFor();
  return { account: "ready", inference: "connection-required" };
});

// E. Device registry: register, rename, relogin same device, relaunch same device,
// different account refused, revoke. Local features never depend on any of it.
await scenario("E-device-registry", async (ctx) => {
  await backend.ledger.approve({ clerkUserId: "user_other" });
  const deviceRows = async () =>
    (
      await backend.db.query(
        "SELECT id, installation_id, account_id, revoked_at FROM devices ORDER BY created_at",
      )
    ).rows;
  const before = new Set((await deviceRows()).map((r) => r.id));
  const first = await open(ctx, { apiBase: backendOrigin(), user: "user_admitted" });
  const { app, page } = first;
  await connectProvider(page);
  await page.getByTestId("acevra-account-choice").waitFor({ timeout: 30000 });
  await page.getByTestId("acevra-account-signin").click();
  await page.getByTestId("acevra-account-choice").waitFor({ state: "hidden", timeout: 30000 });
  await skipPreferences(page);
  // Local use keeps working regardless of devices.
  await infer(page, "Reply with the fixture confirmation.");
  await openAccountSection(page);
  const row = page.locator('[data-testid="acevra-device-row"][data-this-device="true"]');
  await row.waitFor({ timeout: 20000 });
  assert.equal(await row.getAttribute("data-this-device"), "true");
  assert.match(await row.innerText(), /This device · Online/);
  // Capabilities are registry facts, not admin text in the normal Devices UI.
  const capabilities = (await row.getAttribute("data-capabilities")).split(",");
  for (const capability of ["files", "shell", "git"]) assert.ok(capabilities.includes(capability));
  assert.doesNotMatch(await row.innerText(), /Shell|Files|Git|Computer Use/);
  // M2E: the raw process runner is not part of normal Account UX.
  await snap(page.getByTestId("acevra-account-section"), "account-devices");
  assert.equal(await page.getByTestId("acevra-tasks-section").count(), 0);
  assert.equal(await page.getByLabel("Program").count(), 0);
  assert.equal(await page.getByLabel("Working directory").count(), 0);
  const rows1 = await deviceRows();
  assert.equal(rows1.length, before.size + 1);
  const deviceId = rows1.find((r) => !before.has(r.id)).id;
  const installation = await readJson(join(ctx.roots.userData, "acevra-installation.json"));
  assert.equal(rows1.find((r) => r.id === deviceId).installation_id, installation.installationId);
  // Rename.
  await row.getByTestId("acevra-device-rename").click();
  await page.getByLabel("Device name").fill("Studio Mac");
  await page.getByTestId("acevra-device-rename-save").click();
  await row.getByTestId("acevra-device-name").getByText("Studio Mac").waitFor({ timeout: 10000 });
  // Sign out keeps the installation identity; sign in again resolves the same device.
  await page.getByTestId("acevra-account-signout").click();
  await page.getByTestId("acevra-account-settings-signin").waitFor({ timeout: 15000 });
  assert.equal(await page.getByTestId("acevra-devices-section").count(), 0);
  assert.equal(
    (await readJson(join(ctx.roots.userData, "acevra-installation.json"))).installationId,
    installation.installationId,
  );
  await page.getByTestId("acevra-account-settings-signin").click();
  await row.waitFor({ timeout: 20000 });
  assert.equal((await deviceRows()).length, before.size + 1, "relogin created no duplicate");
  await row.getByTestId("acevra-device-name").getByText("Studio Mac").waitFor();
  await app.close();
  // Relaunch (existing profile) as the same account: same device.
  const second = await open(ctx, { apiBase: backendOrigin(), user: "user_admitted" });
  await second.page.getByTestId("acevra-account-choice").waitFor({ timeout: 30000 });
  await second.page.getByTestId("acevra-account-signin").click();
  await second.page
    .getByTestId("acevra-account-choice")
    .waitFor({ state: "hidden", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500));
  const rows2 = await deviceRows();
  assert.equal(rows2.length, before.size + 1);
  assert.ok(rows2.some((r) => r.id === deviceId));
  await second.app.close();
  // A different admitted account on the same installation is refused (no silent transfer).
  const third = await open(ctx, { apiBase: backendOrigin(), user: "user_other" });
  await third.page.getByTestId("acevra-account-choice").waitFor({ timeout: 30000 });
  await third.page.getByTestId("acevra-account-signin").click();
  await third.page
    .getByTestId("acevra-account-choice")
    .waitFor({ state: "hidden", timeout: 30000 });
  await openAccountSection(third.page);
  await third.page.getByTestId("acevra-device-conflict").waitFor({ timeout: 20000 });
  assert.equal((await deviceRows()).length, before.size + 1);
  assert.equal(
    (await deviceRows()).find((r) => r.id === deviceId).account_id ===
      rows2.find((r) => r.id === deviceId).account_id,
    true,
    "ownership unchanged",
  );
  await third.app.close();
  // Revoke from the owning account: device flagged, local use still works.
  const fourth = await open(ctx, { apiBase: backendOrigin(), user: "user_admitted" });
  await fourth.page.getByTestId("acevra-account-choice").waitFor({ timeout: 30000 });
  await fourth.page.getByTestId("acevra-account-signin").click();
  await fourth.page
    .getByTestId("acevra-account-choice")
    .waitFor({ state: "hidden", timeout: 30000 });
  await openAccountSection(fourth.page);
  const mine = fourth.page.locator('[data-testid="acevra-device-row"][data-this-device="true"]');
  await mine.getByTestId("acevra-device-revoke").click();
  await mine.getByTestId("acevra-device-revoke-confirm").click();
  await mine.getByText("Revoked").waitFor({ timeout: 10000 });
  assert.ok((await deviceRows()).find((r) => r.id === deviceId).revoked_at);
  await fourth.page.keyboard.press("Escape");
  await app4Reload(fourth);
  await infer(fourth.page, "Reply after revoke.");
  return {
    device:
      "registered, renamed, relogin+relaunch same id, account switch refused, revoke state, local use intact",
  };
});
async function app4Reload({ app, page }) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload());
  await page
    .getByTestId("acevra-account-local")
    .click({ timeout: 8000 })
    .catch(() => {});
  // The settings page can be restored after a reload; the conversation view must be showing.
  await page
    .getByText("Back to workspace")
    .click({ timeout: 5000 })
    .catch(() => {});
}

// F. Node pairing: headless node → code → approve in the desktop → proof-of-possession claim →
// independent device auth over WS → Online; stop → Offline; restart → same device; revoke → closed.
await scenario("F-node-pairing", async (ctx) => {
  const nodeHome = join(ctx.roots.root, "node-home");
  const nodeCwd = resolve(desktop, "../node");
  const nodes = () =>
    backend.db.query("SELECT id, revoked_at FROM devices WHERE type = 'node'").then((r) => r.rows);
  const startNode = () => {
    const child = spawn(
      process.execPath,
      ["bin/acevra.mjs", "node", "connect", "--api", backendOrigin(), "--name", "Dell Server"],
      {
        cwd: nodeCwd,
        env: { ...process.env, ACEVRA_NODE_HOME: nodeHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const exited = new Promise((r) => child.once("exit", (code) => r(code)));
    return { child, exited, out: () => out };
  };
  const { app, page } = await open(ctx, { apiBase: backendOrigin(), user: "user_admitted" });
  ctx.nodeChildren = [];
  try {
    await connectProvider(page);
    await page.getByTestId("acevra-account-choice").waitFor({ timeout: 30000 });
    await page.getByTestId("acevra-account-signin").click();
    await page.getByTestId("acevra-account-choice").waitFor({ state: "hidden", timeout: 30000 });
    await skipPreferences(page);
    await openAccountSection(page);
    const node = startNode();
    ctx.nodeChildren.push(node.child);
    const until = async (fn, ms = 20000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await fn()) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error("timeout");
    };
    await until(() => /Code: [A-Z2-9]{4}-[A-Z2-9]{4}/.test(node.out()));
    const code = node.out().match(/Code: ([A-Z2-9]{4}-[A-Z2-9]{4})/)[1];
    // Desktop: look up by code, review, approve.
    await page.getByTestId("acevra-pair-open").click();
    await page.getByLabel("Pairing code").fill("AAAA-AAAA");
    await page.getByTestId("acevra-pair-lookup").click();
    await page
      .getByTestId("acevra-pair-note")
      .getByText("No pending node found")
      .waitFor({ timeout: 10000 });
    await page.getByLabel("Pairing code").fill(code);
    await page.getByTestId("acevra-pair-lookup").click();
    await page
      .getByTestId("acevra-pair-pending")
      .getByText("Dell Server")
      .waitFor({ timeout: 10000 });
    await page.getByTestId("acevra-pair-approve").click();
    await page.getByTestId("acevra-pair-note").getByText("Approved").waitFor({ timeout: 10000 });
    const row = page.getByTestId("acevra-device-row").filter({ hasText: "Dell Server" });
    const refreshUntil = async (pattern) => {
      const end = Date.now() + 20000;
      while (Date.now() < end) {
        await page.getByTestId("acevra-devices-refresh").click();
        if ((await row.count()) && pattern.test(await row.first().innerText())) return;
        await new Promise((r) => setTimeout(r, 400));
      }
      throw new Error(`device row never matched ${pattern}: ${await row.allInnerTexts()}`);
    };
    await refreshUntil(/Node · Online/);
    assert.equal((await nodes()).length, 1);
    const nodeId = (await nodes())[0].id;
    assert.equal(await row.first().getAttribute("data-this-device"), "false");
    // Stop → Offline (after the grace window); restart → same device Online, no new pairing.
    node.child.kill("SIGTERM");
    await node.exited;
    await refreshUntil(/Node · Offline/);
    const again = startNode();
    ctx.nodeChildren.push(again.child);
    await refreshUntil(/Node · Online/);
    assert.ok(!/Code:/.test(again.out()), "restart does not re-pair");
    assert.deepEqual(
      (await nodes()).map((n) => n.id),
      [nodeId],
      "same device, no duplicate",
    );
    // Revoke from the desktop: the node's live connection is terminated and it exits as revoked.
    await row.first().getByTestId("acevra-device-revoke").click();
    await row.first().getByTestId("acevra-device-revoke-confirm").click();
    await refreshUntil(/Revoked/);
    assert.equal(
      await Promise.race([
        again.exited,
        new Promise((r) => setTimeout(() => r("still-running"), 8000)),
      ]),
      3,
    );
    assert.ok((await nodes())[0].revoked_at);
    // A restart of the revoked identity stays refused.
    const retry = startNode();
    ctx.nodeChildren.push(retry.child);
    assert.equal(
      await Promise.race([
        retry.exited,
        new Promise((r) => setTimeout(() => r("still-running"), 8000)),
      ]),
      3,
    );
    // Local use never depended on any of it.
    await page.keyboard.press("Escape");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.reload(),
    );
    await infer(page, "Reply with the fixture confirmation.");
    return {
      node: "paired by code, online, offline on stop, same device on restart, revoke terminated it, local use intact",
    };
  } finally {
    for (const child of ctx.nodeChildren) child.kill("SIGKILL");
  }
});

// G. Task routing: shell capability only after the node's service is ready; Run on [target];
// live events while running; completion; cancel kills the process; local target; offline target.
await scenario("G-remote-process", async (ctx) => {
  const nodeHome = join(ctx.roots.root, "node-home");
  const project = join(ctx.roots.root, "project");
  await mkdir(join(project, "app"), { recursive: true });
  const nodeCwd = resolve(desktop, "../node");
  const startNode = (extra = []) => {
    const child = spawn(
      process.execPath,
      [
        "bin/acevra.mjs",
        "node",
        "connect",
        "--api",
        backendOrigin(),
        "--name",
        "Dell Runner",
        ...extra,
      ],
      {
        cwd: nodeCwd,
        env: { ...process.env, ACEVRA_NODE_HOME: nodeHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    return { child, exited: new Promise((r) => child.once("exit", (c) => r(c))), out: () => out };
  };
  const until = async (fn, ms = 25000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("timeout");
  };
  const children = [];
  const { page } = await open(ctx, {
    apiBase: backendOrigin(),
    user: "user_admitted",
    engineering: true,
  });
  const hasShell = async (locator) =>
    (await locator.first().getAttribute("data-capabilities")).split(",").includes("shell");
  const runOn = page.getByTestId("v4-composer-run-on");
  const runOnOption = (id) =>
    page.locator(`[data-testid="v4-composer-run-on-option"][data-target-id="${id}"]`);
  // M2F: scripted model. A prompt tagged `AGENT-RUN:<name>` makes the fixture call RunOnTarget
  // with agentScripts[name] (only when the request offers that tool); the tool result is recorded.
  const agentScripts = {};
  const agentLog = [];
  fixture.setResponder((input) => {
    const tools = (input.tools ?? []).map((tool) => tool.function?.name);
    if (!tools.includes("RunOnTarget")) return null;
    const last = (input.messages ?? []).at(-1);
    const text = (content) => (typeof content === "string" ? content : JSON.stringify(content));
    if (last?.role === "tool") {
      agentLog.push({ toolResult: text(last.content) });
      return { content: "Agent remote step finished." };
    }
    const tag = last?.role === "user" ? text(last.content).match(/AGENT-RUN:(\w+)/) : null;
    if (!tag || !agentScripts[tag[1]]) return null;
    agentLog.push({
      prompt: tag[1],
      hasRunOnContext: text(last.content).includes("<execution-target-context"),
    });
    return {
      toolCall: {
        id: `call_${tag[1]}_${agentLog.length}`,
        name: "RunOnTarget",
        arguments: agentScripts[tag[1]],
      },
    };
  });
  const latestTaskId = async () =>
    (await backend.db.query("SELECT id FROM tasks ORDER BY created_at DESC LIMIT 1")).rows[0]?.id;
  const askAgent = async (prompt) => {
    const input = page.getByTestId("v4-composer-input");
    await input.fill(prompt);
    await input.press("Enter");
    // RunOnTarget needs approval (it runs a process on another device): allow once.
    const allow = page.locator('[data-permission-option-kind="allowOnce"]').first();
    await allow.waitFor({ timeout: 30000 });
    await allow.click();
    if (await allow.isVisible().catch(() => false)) await allow.click().catch(() => {});
  };
  const toolResults = () => agentLog.filter((entry) => entry.toolResult);
  try {
    await connectProvider(page);
    await page.getByTestId("acevra-account-choice").waitFor({ timeout: 30000 });
    await page.getByTestId("acevra-account-signin").click();
    await page.getByTestId("acevra-account-choice").waitFor({ state: "hidden", timeout: 30000 });
    await skipPreferences(page);
    // Composer: secondary Run-on control defaults to Automatic and lists this device by name.
    await runOn.waitFor({ timeout: 30000 });
    assert.equal(await runOn.getAttribute("data-run-on"), "auto");
    await runOn.click();
    await runOnOption("local").waitFor({ timeout: 10000 });
    assert.equal(await runOnOption("local").getAttribute("data-target-status"), "available");
    await page.keyboard.press("Escape");
    await openAccountSection(page);
    // Pair a node that has NO allowed root: it connects, but shell is not advertised.
    const bare = startNode();
    children.push(bare.child);
    await until(() => /Code: [A-Z2-9]{4}-[A-Z2-9]{4}/.test(bare.out()));
    await page.getByTestId("acevra-pair-open").click();
    await page
      .getByLabel("Pairing code")
      .fill(bare.out().match(/Code: ([A-Z2-9]{4}-[A-Z2-9]{4})/)[1]);
    await page.getByTestId("acevra-pair-lookup").click();
    await page.getByTestId("acevra-pair-approve").click();
    const dellOption = page.locator('[data-testid="acevra-run-target"] option', {
      hasText: "Dell Runner",
    });
    const row = page.getByTestId("acevra-device-row").filter({ hasText: "Dell Runner" });
    const refreshUntil = async (fn) => {
      const end = Date.now() + 25000;
      while (Date.now() < end) {
        await page.getByTestId("acevra-devices-refresh").click();
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error("condition never met");
    };
    await refreshUntil(
      async () => (await row.count()) && /Node · Online/.test(await row.first().innerText()),
    );
    assert.ok(!(await hasShell(row)), "no shell advertised without a ready service");
    await until(
      async () =>
        (await dellOption.count()) > 0 && (await dellOption.evaluate((el) => el.disabled)),
    );
    // Restart the same node with an allowed root: shell appears only now.
    bare.child.kill("SIGTERM");
    await bare.exited;
    const node = startNode(["--allow-root", project]);
    children.push(node.child);
    await refreshUntil(
      async () =>
        (await row.count()) &&
        /Node · Online/.test(await row.first().innerText()) &&
        (await hasShell(row)),
    );
    await until(async () => !(await dellOption.evaluate((el) => el.disabled)));
    const nodeId = (
      await backend.db.query(
        "SELECT id FROM devices WHERE type = 'node' AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
      )
    ).rows[0].id;
    // Composer: the paired node appears by its user-given name; choosing it is per conversation
    // and the caption states that agent commands go to the node while files/Computer stay here.
    await backToWorkspace(page);
    await snap(page, "composer-run-on-automatic");
    await runOn.click();
    await runOnOption(nodeId).waitFor({ timeout: 10000 });
    await snap(page, "composer-run-on-menu");
    assert.match(await runOnOption(nodeId).innerText(), /Dell Runner/);
    await runOnOption(nodeId).click();
    assert.equal(await runOn.getAttribute("data-run-on"), nodeId);
    await runOn.click();
    await page.getByTestId("v4-composer-run-on-gap").waitFor({ timeout: 5000 });
    await snap(page, "composer-run-on-node-selected");
    await page.keyboard.press("Escape");
    await openAccountSection(page);
    await snap(page.getByTestId("acevra-devices-section"), "devices-with-node");
    // Run on the node: the engineering runner defaults to the conversation's Run-on choice.
    const target = page.getByTestId("acevra-run-target");
    assert.equal(await target.inputValue(), nodeId, "runner follows the conversation's Run on");
    await page.getByLabel("Program").fill(process.execPath);
    await page
      .getByLabel("Arguments")
      .fill(
        `-e "console.log('71 tests discovered'); setTimeout(() => console.log('42 passed'), 2500)"`,
      );
    await page.getByLabel("Working directory").fill(join(project, "app"));
    await page.getByTestId("acevra-run-start").click();
    const output = page.getByTestId("acevra-task-output");
    await output.getByText("71 tests discovered").waitFor({ timeout: 20000 });
    assert.equal(
      await page.getByTestId("acevra-task-row").first().getAttribute("data-state"),
      "running",
      "visible output while still running",
    );
    assert.ok(!/42 passed/.test(await output.innerText()), "later output has not arrived yet");
    await output.getByText("42 passed").waitFor({ timeout: 20000 });
    await output.getByText("Exited 0").waitFor({ timeout: 20000 });
    await until(
      async () =>
        (await page.getByTestId("acevra-task-row").first().getAttribute("data-state")) ===
        "completed",
    );
    // Longer process → Cancel → the node terminates it → the UI shows Cancelled.
    await page
      .getByLabel("Arguments")
      .fill(`-e "console.log('long task started'); setInterval(() => {}, 1000)"`);
    await page.getByTestId("acevra-run-start").click();
    await output.getByText("long task started").waitFor({ timeout: 20000 });
    const longTask = (
      await backend.db.query("SELECT id FROM tasks ORDER BY created_at DESC LIMIT 1")
    ).rows[0].id;
    const pid = (
      await backend.db.query(
        "SELECT payload FROM task_events WHERE task_id = $1 AND type = 'process.started'",
        [longTask],
      )
    ).rows[0].payload.pid;
    process.kill(pid, 0);
    // The conversation shows the attached task as a live card driven by TaskEvents; Stop uses the
    // real cancellation path. The card never shows the command line.
    await backToWorkspace(page);
    const card = page.locator(`[data-testid="acevra-task-card"][data-task-id="${longTask}"]`);
    await card.waitFor({ timeout: 20000 });
    await until(async () => (await card.getAttribute("data-task-status")) === "running");
    assert.match(await card.innerText(), /Dell Runner · Running/);
    await card.getByText("long task started").waitFor({ timeout: 20000 });
    assert.doesNotMatch(await card.innerText(), /setInterval|node|-e /);
    // The first (completed) task is attached to this conversation too, shown as Done.
    assert.equal(await page.getByTestId("acevra-task-card").count(), 2);
    await snap(page, "conversation-task-card-running");
    await card.getByTestId("acevra-task-card-stop").click();
    await until(async () => (await card.getAttribute("data-task-status")) === "cancelled");
    await snap(page, "conversation-task-card-stopped");
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    await card.getByTestId("acevra-task-card-dismiss").click();
    await card.waitFor({ state: "detached", timeout: 5000 });
    // M2F: with Run on = Dell Runner the agent's command runs on the node as a Task; the card in
    // this conversation streams its TaskEvents. The caption states the real routing boundary.
    await runOn.click();
    assert.match(
      await page.getByTestId("v4-composer-run-on-gap").innerText(),
      /Commands the agent runs go to Dell Runner\. Files and Computer stay on this device\./,
    );
    await snap(page, "composer-run-on-agent-caption");
    await page.keyboard.press("Escape");
    agentScripts.quick = {
      targetId: nodeId,
      executable: process.execPath,
      args: ["-e", "console.log('agent ran on dell')"],
      cwd: join(project, "app"),
      waitSeconds: 30,
    };
    const beforeAgent = await latestTaskId();
    await askAgent("AGENT-RUN:quick run it on Dell");
    await until(async () => (await latestTaskId()) !== beforeAgent);
    const agentTask = await latestTaskId();
    const agentCard = page.locator(`[data-testid="acevra-task-card"][data-task-id="${agentTask}"]`);
    await agentCard.waitFor({ timeout: 20000 });
    await agentCard.getByText("agent ran on dell").waitFor({ timeout: 20000 });
    await until(async () => (await agentCard.getAttribute("data-task-status")) === "completed");
    await page.getByText("Agent remote step finished.").first().waitFor({ timeout: 30000 });
    assert.ok(agentLog.find((entry) => entry.prompt === "quick")?.hasRunOnContext);
    const quickResult = toolResults()[0].toolResult;
    assert.match(quickResult, /agent ran on dell/);
    assert.match(quickResult, /"state":"completed"/);
    await snap(page, "conversation-agent-task-card-completed");
    // Agent-started long task → Stop on the card → node kills it → the tool reports cancelled.
    agentScripts.long = {
      ...agentScripts.quick,
      args: ["-e", "console.log('agent long started'); setInterval(() => {}, 1000)"],
      waitSeconds: 120,
    };
    await askAgent("AGENT-RUN:long keep it running on Dell");
    await until(async () => (await latestTaskId()) !== agentTask);
    const agentLongTask = await latestTaskId();
    const agentLongCard = page.locator(
      `[data-testid="acevra-task-card"][data-task-id="${agentLongTask}"]`,
    );
    await agentLongCard.getByText("agent long started").waitFor({ timeout: 20000 });
    assert.match(await agentLongCard.innerText(), /Dell Runner · Running/);
    await snap(page, "conversation-agent-task-card-running");
    await agentLongCard.getByTestId("acevra-task-card-stop").click();
    await until(async () => (await agentLongCard.getAttribute("data-task-status")) === "cancelled");
    await until(() => toolResults().length >= 2, 30000);
    assert.match(toolResults()[1].toolResult, /"state":"cancelled"/);
    await openAccountSection(page);
    await until(
      async () =>
        (await page.getByTestId("acevra-task-row").first().getAttribute("data-state")) ===
        "cancelled",
    );
    // Local target: same UI, same event shape, no control plane.
    await target.selectOption({ index: 0 });
    await page.getByLabel("Program").fill(process.execPath);
    await page.getByLabel("Arguments").fill(`-e "console.log('ran locally')"`);
    await page.getByLabel("Working directory").fill(ctx.roots.workspace);
    await page.getByTestId("acevra-run-start").click();
    await output.getByText("ran locally").waitFor({ timeout: 20000 });
    await output.getByText("Exited 0").waitFor({ timeout: 20000 });
    // Offline node is visible but unavailable.
    node.child.kill("SIGTERM");
    await node.exited;
    await until(
      async () => await dellOption.evaluate((el) => el.disabled && /offline/.test(el.textContent)),
      30000,
    );
    // Composer shows the offline node truthfully (listed, disabled, labelled), keeping the choice.
    await backToWorkspace(page);
    await runOn.click();
    await until(
      async () => (await runOnOption(nodeId).getAttribute("data-target-status")) === "offline",
    );
    assert.equal(await runOnOption(nodeId).getAttribute("aria-disabled"), "true");
    assert.match(await runOnOption(nodeId).innerText(), /Offline/);
    await snap(page, "composer-run-on-offline");
    assert.equal(await runOn.getAttribute("data-run-on"), nodeId);
    await page.keyboard.press("Escape");
    // M2F: offline target → the agent's run fails truthfully; no task, nothing run on this Mac.
    agentScripts.offline = {
      ...agentScripts.quick,
      args: ["-e", "require('fs').writeFileSync('ran-locally.txt', 'x')"],
    };
    const beforeOffline = await latestTaskId();
    await askAgent("AGENT-RUN:offline try Dell again");
    await until(() => toolResults().length >= 3, 30000);
    assert.match(toolResults()[2].toolResult, /offline/i);
    assert.match(toolResults()[2].toolResult, /Nothing was run on this Mac/);
    assert.equal(await latestTaskId(), beforeOffline, "no task was created for an offline target");
    await assert.rejects(readFile(join(ctx.roots.workspace, "ran-locally.txt")));
    await assert.rejects(readFile(join(project, "app", "ran-locally.txt")));
    return {
      remote:
        "shell only after readiness; live events; completed; local target; offline target unavailable",
      composer:
        "Run on lists real targets, per-conversation choice, truthful routing caption, offline shown disabled",
      card: "TaskEvent-driven card in the attached conversation, Stop cancelled and killed the process",
      agent:
        "RunOnTarget routed via Task to the node, card streamed and completed, card Stop cancelled an agent task, offline failed with no local fallback",
    };
  } finally {
    for (const child of children) child.kill("SIGKILL");
  }
});

await listener.close();
await fixture.close();
console.log(JSON.stringify({ passed: results.map((r) => r.scenario) }));
process.exit(0);
