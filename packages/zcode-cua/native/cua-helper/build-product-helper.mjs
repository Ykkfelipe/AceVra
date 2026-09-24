#!/usr/bin/env node
// Build and sign the product Computer Use Helper that ships inside AceVra.app.
//
// This is deliberately a separate builder from build-dev-helper.mjs: the development builder
// MUST keep refusing the product bundle id (an installed product Helper already holds a grant
// under it), while packaging needs exactly that identity. The two builders share the Swift
// sources and the signing rules, so behaviour cannot drift between the Harness and the product.
//
// Signing: requires the stable isolated identity created by
// signing/create-dev-signing-identity.sh. Ad-hoc signing is never accepted here; the caller must
// pass --allow-unsigned explicitly for a local diagnostic build, and the mode is reported.
//
// Usage:
//   node build-product-helper.mjs --install-root DIR --version 0.1.0-alpha.1 --build 1
//        [--arch arm64] [--signing-dir DIR] [--identity NAME] [--out DIR] [--allow-unsigned]
//
// Output: one line of JSON on stdout describing the signed bundle for packaging evidence.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const PRODUCT_HELPER_BUNDLE_ID = "dev.acevra.cua-helper";
export const PRODUCT_HELPER_APP_NAME = "AceVra Computer Use.app";
const PRODUCT_EXECUTABLE_NAME = "AceVraComputerUse";
const MINIMUM_MACOS_TARGET = "arm64-apple-macos12.0";
const X86_TARGET = "x86_64-apple-macos12.0";

function argValue(name, fallback) {
  return process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

const CUA_HOME = process.env.ZCODE_CUA_HOME?.trim() || join(homedir(), ".zcode-fork-cua-home");
const INSTALL_ROOT = resolve(argValue("--install-root", join(CUA_HOME, ".zcode", "computer-use")));
const VERSION = argValue("--version", process.env.ZCODE_CUA_HELPER_VERSION || "0.0.0");
const BUILD = argValue("--build", process.env.ZCODE_CUA_HELPER_BUILD_NUMBER || "1");
const ARCH = argValue("--arch", "arm64");
const ALLOW_UNSIGNED = has("--allow-unsigned");
const SIGNING_DIR = resolve(
  argValue("--signing-dir", process.env.CUA_SIGNING_DIR?.trim() || join(CUA_HOME, "signing")),
);
const KEYCHAIN = join(SIGNING_DIR, "acevra-cua-dev.keychain-db");
const IDENTITY = argValue("--identity", "AceVra CUA Dev Signing");
const BUNDLE_ID = argValue("--bundle-id", PRODUCT_HELPER_BUNDLE_ID);
const APP_NAME = argValue("--app-name", PRODUCT_HELPER_APP_NAME);

if (process.platform !== "darwin") {
  console.error("[cua-product-helper] the product Helper is macOS-only");
  process.exit(1);
}
if (BUNDLE_ID !== PRODUCT_HELPER_BUNDLE_ID) {
  console.error(`[cua-product-helper] refusing bundle id ${BUNDLE_ID}`);
  process.exit(1);
}
if (APP_NAME !== PRODUCT_HELPER_APP_NAME) {
  console.error(`[cua-product-helper] refusing app name ${APP_NAME}`);
  process.exit(1);
}
if (!/^[0-9]+$/.test(BUILD)) {
  console.error(`[cua-product-helper] --build must be numeric, got ${BUILD}`);
  process.exit(1);
}
if (!ALLOW_UNSIGNED && !existsSync(KEYCHAIN)) {
  console.error(`[cua-product-helper] signing keychain missing: ${KEYCHAIN}`);
  console.error("[cua-product-helper] run signing/create-dev-signing-identity.sh first");
  process.exit(1);
}

function hasSwiftc() {
  try {
    execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
if (!hasSwiftc()) {
  console.error("[cua-product-helper] swiftc not found (needs Xcode Command Line Tools)");
  process.exit(1);
}

const appDir = resolve(INSTALL_ROOT, APP_NAME);
const contents = join(appDir, "Contents");
const macosDir = join(contents, "MacOS");
const outDir = has("--out") ? resolve(argValue("--out")) : join(here, "build-product");
rmSync(appDir, { recursive: true, force: true });
mkdirSync(macosDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

if (!["universal", "arm64", "x86_64"].includes(ARCH)) {
  console.error(`[cua-product-helper] unsupported --arch ${ARCH}`);
  process.exit(1);
}
const arm64 = join(outDir, `${PRODUCT_EXECUTABLE_NAME}-arm64`);
const x86 = join(outDir, `${PRODUCT_EXECUTABLE_NAME}-x86_64`);
const swiftSources = readdirSync(here)
  .filter((name) => name.endsWith(".swift"))
  .sort()
  .map((name) => join(here, name));
const slices = [
  [MINIMUM_MACOS_TARGET, arm64],
  [X86_TARGET, x86],
].filter(([target]) => ARCH === "universal" || target.startsWith(ARCH));
for (const [target, out] of slices) {
  execFileSync(
    "xcrun",
    [
      "swiftc",
      "-O",
      "-swift-version",
      "5",
      "-target",
      target,
      "-framework",
      "AppKit",
      "-framework",
      "ApplicationServices",
      "-framework",
      "CoreGraphics",
      "-framework",
      "ScreenCaptureKit",
      "-framework",
      "ImageIO",
      "-framework",
      "UniformTypeIdentifiers",
      "-o",
      out,
      ...swiftSources,
    ],
    { stdio: "inherit" },
  );
}
if (ARCH === "universal") {
  execFileSync(
    "lipo",
    ["-create", arm64, x86, "-output", join(macosDir, PRODUCT_EXECUTABLE_NAME)],
    {
      stdio: "inherit",
    },
  );
} else {
  execFileSync("cp", [slices[0][1], join(macosDir, PRODUCT_EXECUTABLE_NAME)]);
}
rmSync(arm64, { force: true });
rmSync(x86, { force: true });

const plist = readFileSync(join(here, "Info.plist.template"), "utf8")
  .replaceAll("__EXECUTABLE__", PRODUCT_EXECUTABLE_NAME)
  .replaceAll("__BUNDLE_ID__", BUNDLE_ID)
  .replaceAll("__DISPLAY_NAME__", APP_NAME.replace(/\.app$/, ""))
  .replaceAll("__VERSION__", VERSION)
  .replaceAll("__BUILD__", BUILD);
writeFileSync(join(contents, "Info.plist"), plist);

if (ALLOW_UNSIGNED) {
  execFileSync("codesign", ["--force", "--sign", "-", "--timestamp=none", appDir], {
    stdio: "inherit",
  });
} else {
  execFileSync(
    "codesign",
    [
      "--force",
      "--timestamp=none",
      "--options",
      "runtime",
      "--sign",
      IDENTITY,
      "--keychain",
      KEYCHAIN,
      appDir,
    ],
    { stdio: "inherit" },
  );
}

function codesignOutput(argv) {
  const result = spawnSync("/usr/bin/codesign", argv, { encoding: "utf8" });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}
const requirement =
  codesignOutput(["-d", "-r-", appDir])
    .split("\n")
    .find((line) => line.includes("=>")) ?? "";
if (!requirement.includes(`identifier "${BUNDLE_ID}"`)) {
  console.error(
    "[cua-product-helper] designated requirement does not carry the product identifier:",
  );
  console.error(`[cua-product-helper]   ${requirement}`);
  process.exit(1);
}
const fingerprint =
  codesignOutput(["-dv", "--verbose=3", appDir])
    .split("\n")
    .find(
      (line) => line.trim().startsWith("CandidateCDHashFull sha256=") || line.startsWith("CDHash="),
    )
    ?.trim() ?? "";

process.stdout.write(
  `${JSON.stringify({
    appPath: appDir,
    bundleId: BUNDLE_ID,
    executableName: PRODUCT_EXECUTABLE_NAME,
    version: VERSION,
    buildNumber: BUILD,
    arch: ARCH,
    signature: ALLOW_UNSIGNED ? "adhoc" : IDENTITY,
    designatedRequirement: requirement.trim(),
    cdhash: fingerprint,
  })}\n`,
);
