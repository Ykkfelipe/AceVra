#!/usr/bin/env node
// Build and sign the CUA development helper app bundle (CUA-0.5 permission proof).
//
// Deliberately NOT wired into packaging: electron-builder expects the helper at
// `<app>/Contents/Resources/cua-helper/` and this dev bundle must never ship. The
// bundle lands at the dev install path the existing contract already declares
// (`<ZCODE_HOME>/computer-use/dev/<DEV_HELPER_APP_NAME>`), so the launcher, the
// settings page and this proof all agree on one location.
//
// Signing: by default this REQUIRES the stable development identity created by
// signing/create-dev-signing-identity.sh. Ad-hoc signing is not merely discouraged
// here, it is refused, because an ad-hoc cdhash changes on every rebuild and macOS
// TCC stores a grant against a code requirement — an ad-hoc helper loses its
// Accessibility/Screen Recording grant on each rebuild. Pass --allow-unsigned only for
// the local-development escape hatch the contract already models
// (ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL); the flag is recorded in the output so an
// unsigned run can never be mistaken for a signed one.
//
// Usage:
//   node packages/zcode-cua/native/cua-helper/build-dev-helper.mjs [--allow-unsigned]
//        [--bundle-id ID] [--app-name NAME] [--install-root DIR]
//        [--version X.Y.Z] [--build N] [--out DIR]

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Contract constants, mirrored by hand on purpose: this script must not import
// TypeScript sources, and a drift here is caught by the identity assertion below
// (the built bundle id is printed and asserted against the expected value).
const STABLE_HELPER_BUNDLE_ID = "dev.zcode.cua-helper";
const DEV_HELPER_BUNDLE_ID = "dev.zcode.cua-helper.dev";
const DEV_HELPER_APP_NAME = "ZCode Computer Use Dev.app";

// Reserved production/development identities for the AceVra-branded product. The fork and
// the product are being renamed to AceVra; identity reconciliation is deferred to
// integration, so these are declared here (and in the spec) as the targets rather than
// being wired in now. The dev helper above keeps the id the CUA-0.5 grant was actually
// measured against, because renaming a bundle id creates a NEW TCC identity and would
// silently invalidate the archived persistence proof. `zcode://` stays untouched for OAuth
// compatibility regardless of the rename.
export const RESERVED_ACEVRA_HELPER_BUNDLE_ID = "dev.acevra.cua-helper";
export const RESERVED_ACEVRA_DEV_HELPER_BUNDLE_ID = "dev.acevra.cua-helper.development";
const EXECUTABLE_NAME = "ZCodeComputerUseDev";
const MINIMUM_MACOS_TARGET = "arm64-apple-macos12.0";
const X86_TARGET = "x86_64-apple-macos12.0";

function argValue(name, fallback) {
  return process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

const CUA_HOME = process.env.ZCODE_CUA_HOME?.trim() || join(homedir(), ".zcode-fork-cua-home");
const ZCODE_HOME = process.env.ZCODE_HOME?.trim() || join(CUA_HOME, ".zcode");
const INSTALL_ROOT = resolve(argValue("--install-root", join(ZCODE_HOME, "computer-use", "dev")));
const APP_NAME = argValue("--app-name", DEV_HELPER_APP_NAME);
const BUNDLE_ID = argValue("--bundle-id", DEV_HELPER_BUNDLE_ID);
const VERSION = argValue("--version", "0.0.1");
const BUILD = argValue("--build", "1");
const ALLOW_UNSIGNED = has("--allow-unsigned");
const SIGNING_DIR = resolve(
  argValue("--signing-dir", process.env.CUA_SIGNING_DIR?.trim() || join(CUA_HOME, "signing")),
);
const KEYCHAIN = join(SIGNING_DIR, "zcode-cua-dev.keychain-db");
const IDENTITY = argValue("--identity", "ZCode CUA Dev Signing");

if (process.platform !== "darwin") {
  console.log("[cua-helper] skipped: the helper is macOS-only");
  process.exit(0);
}

const PRODUCT_HELPER_BUNDLE_IDS = [
  STABLE_HELPER_BUNDLE_ID,
  DEV_HELPER_BUNDLE_ID,
  RESERVED_ACEVRA_HELPER_BUNDLE_ID,
  RESERVED_ACEVRA_DEV_HELPER_BUNDLE_ID,
];
if (BUNDLE_ID === STABLE_HELPER_BUNDLE_ID || BUNDLE_ID === RESERVED_ACEVRA_HELPER_BUNDLE_ID) {
  console.error(`[cua-helper] refusing to build with the product helper bundle id ${BUNDLE_ID}.`);
  console.error(
    "[cua-helper] An installed product helper already holds a TCC grant under that id; reusing it " +
      "would both collide with the product install and make any permission measurement meaningless.",
  );
  process.exit(1);
}
if (PRODUCT_HELPER_BUNDLE_IDS.includes(BUNDLE_ID) && BUNDLE_ID !== DEV_HELPER_BUNDLE_ID) {
  console.error(`[cua-helper] refusing reserved product helper bundle id ${BUNDLE_ID}.`);
  console.error("[cua-helper] Reserved ids are declared, not built against, on this branch.");
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
  console.error("[cua-helper] swiftc not found (needs Xcode Command Line Tools)");
  process.exit(1);
}

const appDir = resolve(INSTALL_ROOT, APP_NAME);
const contents = join(appDir, "Contents");
const macosDir = join(contents, "MacOS");
const outDir = has("--out") ? resolve(argValue("--out")) : join(here, "build");

rmSync(appDir, { recursive: true, force: true });
mkdirSync(macosDir, { recursive: true });

// Build both slices and lipo them: the product ships universal, and a helper that
// only runs on the build host would hide that constraint until release.
const arm64 = join(outDir, `${EXECUTABLE_NAME}-arm64`);
const x86 = join(outDir, `${EXECUTABLE_NAME}-x86_64`);
mkdirSync(outDir, { recursive: true });
// Every .swift file in the directory is compiled together: CUA-1 split the helper into
// focused files (broker server, observation methods) rather than growing one 400+ line main.
const swiftSources = readdirSync(here)
  .filter((name) => name.endsWith(".swift"))
  .sort()
  .map((name) => join(here, name));
if (swiftSources.length === 0) {
  console.error("[cua-helper] no swift sources found");
  process.exit(1);
}
for (const [target, out] of [
  [MINIMUM_MACOS_TARGET, arm64],
  [X86_TARGET, x86],
]) {
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
execFileSync("lipo", ["-create", arm64, x86, "-output", join(macosDir, EXECUTABLE_NAME)], {
  stdio: "inherit",
});
rmSync(arm64, { force: true });
rmSync(x86, { force: true });

const plist = readFileSync(join(here, "Info.plist.template"), "utf8")
  .replaceAll("__EXECUTABLE__", EXECUTABLE_NAME)
  .replaceAll("__BUNDLE_ID__", BUNDLE_ID)
  .replaceAll("__DISPLAY_NAME__", APP_NAME.replace(/\.app$/, ""))
  .replaceAll("__VERSION__", VERSION)
  .replaceAll("__BUILD__", BUILD);
writeFileSync(join(contents, "Info.plist"), plist);

let signature = "unsigned";
if (ALLOW_UNSIGNED) {
  // Recorded explicitly: an unsigned build can never be mistaken for a signed one.
  execFileSync("codesign", ["--force", "--sign", "-", "--timestamp=none", appDir], {
    stdio: "inherit",
  });
  signature = "adhoc (--allow-unsigned)";
} else {
  if (!existsSync(KEYCHAIN)) {
    console.error(`[cua-helper] signing keychain missing: ${KEYCHAIN}`);
    console.error("[cua-helper] run signing/create-dev-signing-identity.sh first");
    process.exit(1);
  }
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
  signature = IDENTITY;
}

// codesign writes its diagnostics to stderr, so use spawnSync and read both streams.
function codesignOutput(argv) {
  const result = spawnSync("/usr/bin/codesign", argv, { encoding: "utf8" });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}
// A Developer-ID signature reports `CDHash=`; a self-signed one only reports
// CandidateCDHash{,Full} at -v3 or above, so accept either.
const cdHashLine =
  codesignOutput(["-dv", "--verbose=3", appDir])
    .split("\n")
    .find((l) => l.startsWith("CDHash=") || l.includes("CandidateCDHashFull sha256=")) ?? "";
const cdHash = cdHashLine.replace(/^.*sha256=/, "").replace(/^CDHash=/, "");
// `-d -r-` prints "Executable=..." first; take the requirement line explicitly.
const requirement =
  codesignOutput(["-d", "-r-", appDir])
    .split("\n")
    .find((l) => l.includes("=>")) ?? "";

console.log(`[cua-helper] app:        ${appDir}`);
console.log(`[cua-helper] bundle id:  ${BUNDLE_ID}`);
console.log(`[cua-helper] version:    ${VERSION} (${BUILD})`);
console.log(`[cua-helper] signature:  ${signature}`);
console.log(`[cua-helper] ${cdHash}`);
console.log(`[cua-helper] ${requirement}`);
