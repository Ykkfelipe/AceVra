#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runCommand } from "../../../scripts/spawn-command.mjs";
import { resolveDesktopBuildCwd, runDesktopProductionBuild } from "./run-production-build.mjs";

const requireFromDesktop = createRequire(import.meta.url);
const asar = requireFromDesktop("@electron/asar");

const runId = process.env.ZCODE_DESKTOP_E2E_RUN_ID?.trim();
if (!runId || process.env.ZCODE_DESKTOP_E2E !== "1") {
  throw new Error("CUA alpha E2E requires the real E2E run id and build flag");
}

const cwd = resolveDesktopBuildCwd();
process.chdir(cwd);
const e2eDataRoot = mkdtempSync(join(tmpdir(), "acevra-cua-alpha-e2e-"));
process.env.ZCODE_DESKTOP_RELEASE_PROFILE = "local-engineering-alpha";
process.env.ZCODE_DESKTOP_HOME_DIR = e2eDataRoot;
process.env.ZCODE_DATA_BASE_DIR = e2eDataRoot;
process.env.VITE_ZCODE_E2E_STORE_BRIDGE = "1";
process.env.VITE_ZCODE_E2E_SKIP_PROVIDER_LOGIN = "1";
process.env.VITE_ZCODE_E2E_SKIP_OCCUPATION_ONBOARDING = "1";

const packagedAppPath = process.env.ZCODE_DESKTOP_E2E_APP_PATH?.trim();
const expectedPackagedCommit = process.env.ZCODE_DESKTOP_E2E_EXPECTED_COMMIT?.trim();
let metadata;
if (packagedAppPath) {
  if (!expectedPackagedCommit) {
    throw new Error("packaged CUA alpha E2E requires ZCODE_DESKTOP_E2E_EXPECTED_COMMIT");
  }
  const appAsarPath = resolve(packagedAppPath, "Contents/Resources/app.asar");
  if (!existsSync(appAsarPath)) {
    throw new Error(`packaged CUA alpha E2E app.asar is missing: ${appAsarPath}`);
  }
  metadata = JSON.parse(asar.extractFile(appAsarPath, "out/metadata/build-meta.json").toString());
  if (metadata.releaseProfile !== "local-engineering-alpha") {
    throw new Error(
      `packaged CUA alpha E2E requires local-engineering-alpha metadata, got ${metadata.releaseProfile}`,
    );
  }
  if (metadata.buildCommitId !== expectedPackagedCommit) {
    throw new Error(
      `packaged CUA alpha E2E commit mismatch: ${metadata.buildCommitId} !== ${expectedPackagedCommit}`,
    );
  }
} else {
  runCommand("pnpm", ["run", "prepare:build-meta"], { cwd, env: process.env });
  await runDesktopProductionBuild({ cwd });

  const metadataPath = resolve(cwd, "out/metadata/build-meta.json");
  if (!existsSync(metadataPath)) {
    throw new Error(`CUA alpha E2E build metadata is missing: ${metadataPath}`);
  }
  metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (metadata.releaseProfile !== "local-engineering-alpha") {
    throw new Error(
      `CUA alpha E2E requires local-engineering-alpha metadata, got ${metadata.releaseProfile}`,
    );
  }
  for (const marker of [".main-build-ready", ".host-build-ready", ".preload-build-ready"]) {
    if (!existsSync(resolve(cwd, "out", marker))) {
      throw new Error(`CUA alpha E2E build is incomplete: missing out/${marker}`);
    }
  }
  for (const output of ["out/main/index.js", "out/preload/index.cjs", "out/renderer/index.html"]) {
    if (!existsSync(resolve(cwd, output))) {
      throw new Error(`CUA alpha E2E build is incomplete: missing ${output}`);
    }
  }
}

try {
  await import("../e2e/cua-release-safety.e2e.mjs");
} finally {
  rmSync(e2eDataRoot, { recursive: true, force: true });
}
