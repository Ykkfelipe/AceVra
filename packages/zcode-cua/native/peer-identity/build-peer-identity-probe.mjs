#!/usr/bin/env node
// Build and sign the CUA-1.75 peer-identity probe (native peer binding for helper admission).
//
// The probe is a tiny Swift CLI, not a Node addon: it must query the accepted socket from a
// process holding the fd (delivered by child_process stdio passthrough) and it compiles the
// SAME CodeIdentity.swift source as the Helper, so the two code-signature verifications
// cannot drift (spec, "Why a small Swift sidecar, and not a native Node addon"). Deliberately
// NOT wired into packaging, exactly like build-dev-helper.mjs — the hardened transport is a
// dev/host-integration surface until the product host integration lands.
//
// Signing mirrors the Helper builder: the dev identity is REQUIRED by default (the probe is
// trusted code in the admission chain — an ad-hoc or substituted probe is a substituted
// verifier), with the same `--allow-unsigned` escape hatch recorded in the output.
//
// Usage:
//   node packages/zcode-cua/native/peer-identity/build-peer-identity-probe.mjs [--allow-unsigned]
//        [--install-root DIR] [--identity NAME] [--signing-dir DIR] [--out DIR]

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Contract constants, mirrored by hand on purpose (same rule as build-dev-helper.mjs): this
// script must not import package sources; the printed designated requirement below is
// asserted against this identifier so drift is caught at build time. Kept in lockstep with
// PEER_PROBE_IDENTIFIER in packages/zcode-cua/host-transport-policy.js by that same assertion
// reading the policy constant's literal from disk.
const PEER_PROBE_IDENTIFIER = "dev.acevra.cua-peer-identity.development";
const EXECUTABLE_NAME = "peer-identity-probe";
const ARM64_TARGET = "arm64-apple-macos12.0";
const X86_TARGET = "x86_64-apple-macos12.0";

function argValue(name, fallback) {
  return process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

const CUA_HOME = process.env.ZCODE_CUA_HOME?.trim() || join(homedir(), ".zcode-fork-cua-home");
const ZCODE_HOME = process.env.ZCODE_HOME?.trim() || join(CUA_HOME, ".zcode");
const INSTALL_ROOT = resolve(argValue("--install-root", join(ZCODE_HOME, "computer-use", "dev")));
const ALLOW_UNSIGNED = has("--allow-unsigned");
const SIGNING_DIR = resolve(
  argValue("--signing-dir", process.env.CUA_SIGNING_DIR?.trim() || join(CUA_HOME, "signing")),
);
const KEYCHAIN = join(SIGNING_DIR, "acevra-cua-dev.keychain-db");
const IDENTITY = argValue("--identity", "AceVra CUA Dev Signing");

if (process.platform !== "darwin") {
  console.log("[peer-identity] skipped: the probe is macOS-only");
  process.exit(0);
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
  console.error("[peer-identity] swiftc not found (needs Xcode Command Line Tools)");
  process.exit(1);
}

// The shared verification source: the Helper's CodeIdentity.swift is compiled into the probe
// target directly (one describeCode, two consumers).
const codeIdentitySource = resolve(here, "..", "cua-helper", "CodeIdentity.swift");
const swiftSources = [
  ...readdirSync(here)
    .filter((name) => name.endsWith(".swift"))
    .sort()
    .map((name) => join(here, name)),
];
if (swiftSources.length === 0) {
  console.error("[peer-identity] no swift sources found");
  process.exit(1);
}
if (!existsSync(codeIdentitySource)) {
  console.error(`[peer-identity] shared verification source missing: ${codeIdentitySource}`);
  process.exit(1);
}

const outDir = has("--out") ? resolve(argValue("--out")) : join(here, "build");
mkdirSync(outDir, { recursive: true });

function buildSlice(target, output) {
  execFileSync(
    "xcrun",
    [
      "swiftc",
      "-O",
      "-target",
      target,
      ...swiftSources,
      codeIdentitySource,
      "-o",
      output,
      "-framework",
      "Security",
    ],
    { stdio: "inherit" },
  );
}

const arm64 = join(outDir, `${EXECUTABLE_NAME}-arm64`);
const x86 = join(outDir, `${EXECUTABLE_NAME}-x86_64`);
buildSlice(ARM64_TARGET, arm64);
let universal;
try {
  buildSlice(X86_TARGET, x86);
  universal = join(outDir, EXECUTABLE_NAME);
  rmSync(universal, { force: true });
  execFileSync("lipo", ["-create", arm64, x86, "-output", universal], { stdio: "inherit" });
} catch {
  // Some CommandLineTools installs cannot link the x86_64 Swift compatibility pack; the
  // dev probe then runs arm64-only. Recorded so an arch-restricted build is never mistaken
  // for a universal one.
  universal = arm64;
  console.warn("[peer-identity] x86_64 slice failed to link; installing arm64-only");
}

let signature;
if (ALLOW_UNSIGNED) {
  // Recorded explicitly: an unsigned build can never be mistaken for a signed one.
  execFileSync(
    "codesign",
    [
      "--force",
      "--sign",
      "-",
      "--timestamp=none",
      "--identifier",
      PEER_PROBE_IDENTIFIER,
      universal,
    ],
    { stdio: "inherit" },
  );
  signature = "adhoc (--allow-unsigned)";
} else {
  if (!existsSync(KEYCHAIN)) {
    console.error(`[peer-identity] signing keychain missing: ${KEYCHAIN}`);
    console.error(
      "[peer-identity] run native/cua-helper/signing/create-dev-signing-identity.sh first",
    );
    process.exit(1);
  }
  execFileSync(
    "codesign",
    [
      "--force",
      "--timestamp=none",
      "--options",
      "runtime",
      "--identifier",
      PEER_PROBE_IDENTIFIER,
      "--sign",
      IDENTITY,
      "--keychain",
      KEYCHAIN,
      universal,
    ],
    { stdio: "inherit" },
  );
  signature = IDENTITY;
}

function codesignOutput(argv) {
  const result = spawnSync("/usr/bin/codesign", argv, { encoding: "utf8" });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

const requirement =
  codesignOutput(["-d", "-r-", universal])
    .split("\n")
    .find((l) => l.includes("=>")) ?? "";
// Drift guard (same idea as build-dev-helper.mjs's bundle-id assertion): the host refuses a
// probe whose designated requirement does not carry this identifier, so assert it here too.
if (!requirement.includes(`identifier "${PEER_PROBE_IDENTIFIER}"`)) {
  console.error("[peer-identity] designated requirement does not carry the probe identifier:");
  console.error(`[peer-identity]   ${requirement}`);
  process.exit(1);
}
// Keep the host-side literal honest: the policy module's constant must name the same probe.
const policySource = resolve(here, "..", "..", "host-transport-policy.js");
if (existsSync(policySource)) {
  const policy = spawnSync("grep", [`"${PEER_PROBE_IDENTIFIER}"`, policySource], {
    encoding: "utf8",
  });
  if (policy.status !== 0) {
    console.error(
      `[peer-identity] ${policySource} no longer names ${PEER_PROBE_IDENTIFIER}; ` +
        "update PEER_PROBE_IDENTIFIER in both places together",
    );
    process.exit(1);
  }
}

mkdirSync(INSTALL_ROOT, { recursive: true, mode: 0o700 });
const installed = join(INSTALL_ROOT, EXECUTABLE_NAME);
copyFileSync(universal, installed);
execFileSync("chmod", ["0755", installed]);

console.log(`[peer-identity] binary:    ${installed}`);
console.log(`[peer-identity] identifier: ${PEER_PROBE_IDENTIFIER}`);
console.log(`[peer-identity] signature: ${signature}`);
console.log(`[peer-identity] ${requirement.trim()}`);
