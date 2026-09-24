#!/usr/bin/env node
// Profile-aware validator for the AceVra 0.1.0-alpha.1 macOS arm64 candidate.
//
// It is intentionally not `scripts/doctor-macos-release-app.sh`: that doctor treats the expected
// self-signed Gatekeeper rejection as failure. This validator checks exactly what a local alpha
// can honestly claim — bundle identity/version/arch, packaged native CUA components with strict
// nested signatures signed by the isolated identity, exactly two release archives, non-secret
// provenance, and candidate contents free of secrets and developer-absolute paths.
//
// Usage:
//   node scripts/release/verify-local-alpha-candidate.mjs --dist DIR [--json]

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..", "..");
const rootVersion = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8")).version;

function argValue(name, fallback) {
  return process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
}

function run(command, args, options = {}) {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    if (result.error || result.status !== 0) {
      return {
        ok: false,
        output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`,
      };
    }
    return { ok: true, output: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    return {
      ok: false,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? ""}`,
    };
  }
}

function plistValue(plistPath, key) {
  const result = run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plistPath]);
  return result.ok ? result.output.trim() : null;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function extractCertificateRoot(signingText) {
  return /certificate root = H"([0-9a-f]+)"/i.exec(signingText)?.[1]?.toLowerCase() ?? null;
}

function verifyArchivedApp(archivePath, label, errors, expectedRoot) {
  const tempRoot = mkdtempSync(join(tmpdir(), "acevra-archive-"));
  const mountPath = join(tempRoot, "dmg");
  let mounted = false;
  try {
    let appPath;
    if (label === "zip") {
      const extractPath = join(tempRoot, "zip");
      mkdirSync(extractPath);
      const extract = run("/usr/bin/unzip", ["-q", archivePath, "-d", extractPath]);
      if (!extract.ok) {
        errors.push(`${label} extraction failed: ${extract.output.trim()}`);
        return null;
      }
      appPath = join(extractPath, "AceVra.app");
    } else {
      mkdirSync(mountPath);
      const attach = run("/usr/bin/hdiutil", [
        "attach",
        "-nobrowse",
        "-readonly",
        "-mountpoint",
        mountPath,
        archivePath,
      ]);
      if (!attach.ok) {
        errors.push(`${label} mount failed: ${attach.output.trim()}`);
        return null;
      }
      mounted = true;
      appPath = join(mountPath, "AceVra.app");
    }
    const bundleId = plistValue(join(appPath, "Contents", "Info.plist"), "CFBundleIdentifier");
    const version = plistValue(join(appPath, "Contents", "Info.plist"), "CFBundleShortVersionString");
    if (bundleId !== "com.acevra.desktop") errors.push(`${label} app bundle id is ${bundleId}`);
    if (version !== rootVersion) errors.push(`${label} app version is ${version}`);
    const verify = run("/usr/bin/codesign", ["--verify", "--strict", "--deep", appPath]);
    if (!verify.ok) errors.push(`${label} app strict signature verification failed: ${verify.output.trim()}`);
    const details = run("/usr/bin/codesign", ["-dv", "--verbose=4", appPath]);
    const requirement = run("/usr/bin/codesign", ["-d", "-r-", appPath]);
    const detailsText = `${details.output}${details.stderr ?? ""}`;
    const requirementText = `${requirement.output}${requirement.stderr ?? ""}`;
    const root = extractCertificateRoot(requirementText);
    if (/Signature=adhoc/i.test(detailsText)) errors.push(`${label} app is ad-hoc signed`);
    if (!requirementText.includes('identifier "com.acevra.desktop"') || !root) {
      errors.push(`${label} app designated requirement is not certificate-root anchored`);
    }
    if (root && expectedRoot && root !== expectedRoot) {
      errors.push(`${label} app certificate root does not match the validated build root`);
    }
    for (const finding of scanCandidateContents(appPath).slice(0, 50)) {
      errors.push(`${label} content scan: ${finding.kind} at ${finding.path}`);
    }
    return root;
  } finally {
    if (mounted) run("/usr/bin/hdiutil", ["detach", mountPath, "-quiet"]);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function rawBuildInventory(dist) {
  return readdirSync(dist, { withFileTypes: true })
    .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? "directory" : "file" }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function walkFiles(root, limit = 200_000) {
  const files = [];
  const stack = [root];
  while (stack.length > 0 && files.length < limit) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(full);
    }
  }
  return files;
}

const SENSITIVE_NAME_PATTERNS = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|\/)keychain-password$/,
  /(^|\/)credentials\.json$/,
  /(^|\/)[^/]*\.(pem|p12|pfx|key)$/,
];
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const DEVELOPER_PATH_PATTERN = /\/Users\/[A-Za-z0-9._-]+\/Projects\/AceVra\//;
const TMP_DEPENDENCY_PATTERN = /(^|[^A-Za-z])\/tmp\/[A-Za-z0-9._-]+/;
const SECRET_VALUE_PATTERN = /(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,})/;

function isTextLike(filePath) {
  return /\.(json|plist|js|mjs|cjs|ts|txt|md|ya?ml|config|nsh|sh|html|css)$/i.test(filePath);
}

export function scanCandidateContents(appPath) {
  const findings = [];
  const files = walkFiles(appPath);
  for (const file of files) {
    const relative = file.slice(appPath.length + 1);
    for (const pattern of SENSITIVE_NAME_PATTERNS) {
      if (pattern.test(relative)) {
        findings.push({ kind: "sensitive-file", path: relative });
        break;
      }
    }
    if (!isTextLike(file)) continue;
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (size > 8 * 1024 * 1024) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (PRIVATE_KEY_PATTERN.test(text))
      findings.push({ kind: "private-key-material", path: relative });
    if (DEVELOPER_PATH_PATTERN.test(text))
      findings.push({ kind: "developer-absolute-path", path: relative });
    // `/tmp` is only suspicious as a declared runtime dependency, so restrict it to config-like
    // files rather than flagging every bundled string literal that happens to mention /tmp.
    if (/\.(json|plist|ya?ml)$/i.test(relative) && TMP_DEPENDENCY_PATTERN.test(text)) {
      findings.push({ kind: "tmp-absolute-path", path: relative });
    }
    if (SECRET_VALUE_PATTERN.test(text))
      findings.push({ kind: "credential-value", path: relative });
  }
  return findings;
}

export function verifyLocalAlphaCandidate(distDir) {
  const errors = [];
  const warnings = [];
  const dist = resolve(distDir);
  const rawInventory = existsSync(dist) ? rawBuildInventory(dist) : [];
  const appPath = join(dist, "mac-arm64", "AceVra.app");

  const expectedArchives = [`AceVra-${rootVersion}-arm64.dmg`, `AceVra-${rootVersion}-arm64.zip`];
  const entries = existsSync(dist) ? readdirSync(dist) : [];
  const archiveEntries = entries.filter((name) => /\.(dmg|zip)$/i.test(name)).sort();
  for (const expected of expectedArchives.sort()) {
    if (!archiveEntries.includes(expected)) errors.push(`missing release archive: ${expected}`);
  }
  for (const actual of archiveEntries) {
    if (!expectedArchives.includes(actual)) errors.push(`unexpected release archive: ${actual}`);
  }

  if (!existsSync(appPath)) {
    errors.push(`missing app bundle: ${appPath}`);
    return { ok: false, errors, warnings, appPath, archives: archiveEntries, rawInventory };
  }

  const infoPlist = join(appPath, "Contents", "Info.plist");
  const bundleId = plistValue(infoPlist, "CFBundleIdentifier");
  const shortVersion = plistValue(infoPlist, "CFBundleShortVersionString");
  const bundleVersion = plistValue(infoPlist, "CFBundleVersion");
  const executable = plistValue(infoPlist, "CFBundleExecutable");
  if (bundleId !== "com.acevra.desktop") errors.push(`app bundle id is ${bundleId}`);
  if (shortVersion !== rootVersion)
    errors.push(`app version is ${shortVersion}, expected ${rootVersion}`);

  const archResult = run("/usr/bin/lipo", [
    "-archs",
    join(appPath, "Contents", "MacOS", executable ?? "AceVra"),
  ]);
  if (!archResult.ok || !archResult.output.trim().split(/\s+/).includes("arm64")) {
    errors.push(`app executable is not arm64: ${archResult.output.trim()}`);
  }
  if (
    archResult.output
      .trim()
      .split(/\s+/)
      .some((arch) => arch && arch !== "arm64")
  ) {
    warnings.push(`app executable contains additional architectures: ${archResult.output.trim()}`);
  }

  const helperPath = join(
    appPath,
    "Contents",
    "Resources",
    "cua-helper",
    "AceVra Computer Use.app",
  );
  const probePath = join(appPath, "Contents", "Resources", "cua-helper", "peer-identity-probe");
  const helperInfoPath = join(
    appPath,
    "Contents",
    "Resources",
    "cua-helper",
    "helper-build-info.json",
  );
  if (!existsSync(helperPath)) errors.push("packaged CUA Helper is missing");
  if (!existsSync(probePath)) errors.push("packaged CUA peer-identity probe is missing");

  let helperReport = null;
  if (existsSync(helperInfoPath)) {
    try {
      helperReport = JSON.parse(readFileSync(helperInfoPath, "utf8"));
    } catch {
      errors.push("helper-build-info.json is not valid JSON");
    }
  } else {
    errors.push("helper-build-info.json is missing");
  }

  let helperCertificateRoot = null;
  let probeCertificateRoot = null;
  if (existsSync(helperPath)) {
    const helperPlist = join(helperPath, "Contents", "Info.plist");
    const helperId = plistValue(helperPlist, "CFBundleIdentifier");
    const helperVersion = plistValue(helperPlist, "CFBundleShortVersionString");
    const helperBuild = plistValue(helperPlist, "CFBundleVersion");
    if (helperId !== "dev.acevra.cua-helper") errors.push(`Helper bundle id is ${helperId}`);
    if (helperVersion !== rootVersion) errors.push(`Helper version is ${helperVersion}`);
    if (helperReport && helperBuild !== helperReport.buildNumber) {
      errors.push(
        `Helper CFBundleVersion ${helperBuild} != reported build ${helperReport.buildNumber}`,
      );
    }
    const verify = run("/usr/bin/codesign", ["--verify", "--strict", "--deep", helperPath]);
    if (!verify.ok)
      errors.push(`Helper strict signature verification failed: ${verify.output.trim()}`);
  }
  if (existsSync(probePath)) {
    const verify = run("/usr/bin/codesign", ["--verify", "--strict", probePath]);
    if (!verify.ok)
      errors.push(`probe strict signature verification failed: ${verify.output.trim()}`);
  }

  const appVerify = run("/usr/bin/codesign", ["--verify", "--strict", "--deep", appPath]);
  if (!appVerify.ok)
    errors.push(`app strict signature verification failed: ${appVerify.output.trim()}`);
  const appDetails = run("/usr/bin/codesign", ["-dv", "--verbose=4", appPath]);
  const appDetailsText = `${appDetails.output}${appDetails.stderr ?? ""}`;
  if (/Signature=adhoc/i.test(appDetailsText)) errors.push("app is ad-hoc signed");
  if (/Authority=Developer ID Application/i.test(appDetailsText)) {
    errors.push("app claims a Developer ID authority that this local alpha must not use");
  }
  if (!/Identifier=com\.acevra\.desktop/.test(appDetailsText) && !appDetails.ok) {
    warnings.push("unable to read app signing identifier");
  }

  if (existsSync(helperPath)) {
    const helperArch = run("/usr/bin/lipo", [
      "-archs",
      join(helperPath, "Contents", "MacOS", "AceVraComputerUse"),
    ]);
    if (!helperArch.ok || helperArch.output.trim() !== "arm64") {
      errors.push(
        `Helper architecture is ${helperArch.output.trim() || "unavailable"}, expected arm64`,
      );
    }
    const helperRequirement = run("/usr/bin/codesign", ["-d", "-r-", helperPath]);
    const helperRequirementText = `${helperRequirement.output}${helperRequirement.stderr ?? ""}`;
    helperCertificateRoot = extractCertificateRoot(helperRequirementText);
    if (
      !helperRequirementText.includes('identifier "dev.acevra.cua-helper"') ||
      !helperCertificateRoot
    ) {
      errors.push("Helper designated requirement is not identifier-plus-certificate-root anchored");
    }
  }
  if (existsSync(probePath)) {
    const probeArch = run("/usr/bin/lipo", ["-archs", probePath]);
    if (!probeArch.ok || probeArch.output.trim() !== "arm64") {
      errors.push(
        `Probe architecture is ${probeArch.output.trim() || "unavailable"}, expected arm64`,
      );
    }
    const probeRequirement = run("/usr/bin/codesign", ["-d", "-r-", probePath]);
    const probeRequirementText = `${probeRequirement.output}${probeRequirement.stderr ?? ""}`;
    probeCertificateRoot = extractCertificateRoot(probeRequirementText);
    if (
      !probeRequirementText.includes('identifier "dev.acevra.cua-peer-identity.development"') ||
      !probeCertificateRoot
    ) {
      errors.push("Probe designated requirement is not identifier-plus-certificate-root anchored");
    }
  }
  const appRequirement = run("/usr/bin/codesign", ["-d", "-r-", appPath]);
  const appRequirementText = `${appRequirement.output}${appRequirement.stderr ?? ""}`;
  const appCertificateRoot = extractCertificateRoot(appRequirementText);
  if (!/Runtime Version=/.test(appDetailsText) || !/flags=.*runtime/.test(appDetailsText)) {
    errors.push("app signature does not report the hardened runtime flag");
  }
  if (
    !appRequirement.ok ||
    !appRequirementText.includes('identifier "com.acevra.desktop"') ||
    !appCertificateRoot
  ) {
    errors.push("app designated requirement is not identifier-plus-certificate-root anchored");
  }
  if (appCertificateRoot && helperCertificateRoot && appCertificateRoot !== helperCertificateRoot) {
    errors.push("app and Helper certificate roots do not match");
  }
  if (appCertificateRoot && probeCertificateRoot && appCertificateRoot !== probeCertificateRoot) {
    errors.push("app and peer probe certificate roots do not match");
  }

  for (const archive of archiveEntries) {
    verifyArchivedApp(
      join(dist, archive),
      archive.toLowerCase().endsWith(".zip") ? "zip" : "dmg",
      errors,
      appCertificateRoot,
    );
  }

  const nested = scanCandidateContents(appPath);
  for (const finding of nested.slice(0, 50)) {
    errors.push(`candidate content scan: ${finding.kind} at ${finding.path}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    appPath,
    archives: archiveEntries,
    helperReport,
    bundleId,
    shortVersion,
    bundleVersion,
    rawInventory,
  };
}

export function writeCandidateProvenance(distDir, result) {
  const dist = resolve(distDir);
  const buildInfo = {
    product: "AceVra",
    version: rootVersion,
    releaseProfile: "local-engineering-alpha",
    platform: "darwin",
    arch: "arm64",
    bundleId: result.bundleId ?? null,
    signing: {
      kind: "self-signed-local",
      identity: "AceVra CUA Dev Signing",
      notarized: false,
      stapled: false,
      developerId: false,
    },
    native: result.helperReport ?? null,
    archives: result.archives,
  };
  writeFileSync(join(dist, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");

  const releaseNotes = `# AceVra ${rootVersion} (local engineering alpha, macOS arm64)

This is a self-signed, non-notarized local engineering candidate. Gatekeeper will reject it by
default; that rejection is expected and is not treated as trust. Install only after the
documented human checkpoints.

- Product: AceVra ${rootVersion}, bundle id com.acevra.desktop.
- Native Computer Use Helper: dev.acevra.cua-helper, version ${rootVersion}, bundled and signed
  with the isolated local identity.
- Release profile: local-engineering-alpha (isolated data root, updates disabled).
- No Developer ID, notarization, staple, public publish, or provider inference is part of this
  candidate.

See build-info.json and SHA256SUMS.txt for non-secret provenance.
`;
  writeFileSync(join(dist, "RELEASE_NOTES.md"), releaseNotes, "utf8");

  const checksumLines = [];
  for (const archive of result.archives) {
    const filePath = join(dist, archive);
    checksumLines.push(`${sha256(filePath)}  ${archive}`);
  }
  writeFileSync(join(dist, "SHA256SUMS.txt"), `${checksumLines.join("\n")}\n`, "utf8");
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
if (isEntrypoint) {
  const buildDir = resolve(
    argValue(
      "--build-dir",
      argValue("--dist", resolve(workspaceRoot, "release", "0.1.0-alpha.1", "build")),
    ),
  );
  const validationDirArg = argValue("--validation-dir");
  const result = verifyLocalAlphaCandidate(buildDir);
  if (result.ok && validationDirArg) {
    const validationDir = resolve(validationDirArg);
    if (existsSync(validationDir))
      throw new Error(`validation directory already exists: ${validationDir}`);
    mkdirSync(validationDir);
    cpSync(result.appPath, join(validationDir, "AceVra.app"), { recursive: true });
    for (const archive of result.archives)
      cpSync(join(buildDir, archive), join(validationDir, archive));
    writeCandidateProvenance(validationDir, {
      ...result,
      appPath: join(validationDir, "AceVra.app"),
    });
  } else if (result.ok) {
    writeCandidateProvenance(buildDir, result);
  }
  for (const warning of result.warnings) console.warn(`[candidate] warning: ${warning}`);
  for (const error of result.errors) console.error(`[candidate] ${error}`);
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  console.log(`[candidate] ${result.ok ? "OK" : "FAILED"}: ${result.appPath}`);
  process.exit(result.ok ? 0 : 1);
}
