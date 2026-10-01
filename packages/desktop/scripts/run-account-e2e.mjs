#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(desktop, "../..");
const env = { ...process.env };
// 与 onboarding E2E 相同：必须走正式 onboarding 守卫，禁止继承 skip/profile 导入开关。
for (const key of Object.keys(env)) {
  if (
    /SKIP_PROVIDER_LOGIN|SKIP_OCCUPATION_ONBOARDING|FORK_DEV|FORK_PROVIDER_IMPORT|E2E_KEEP_BUILD_CACHE|ACEVRA_/.test(
      key,
    )
  )
    delete env[key];
}
async function run(command, args, cwd) {
  await new Promise((ok, fail) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", fail);
    child.once("exit", (code) =>
      code === 0 ? ok() : fail(new Error(`${command} failed: ${code}`)),
    );
  });
}
if (process.argv[2] !== "--no-build") {
  await run(process.execPath, ["scripts/build-desktop-agent-cli.mjs"], repo);
  await run("pnpm", ["--filter", "@zcode/desktop", "build:no-runtime-assets"], repo);
}
await run(process.execPath, ["--import", "tsx", "e2e/account.e2e.mjs"], desktop);
