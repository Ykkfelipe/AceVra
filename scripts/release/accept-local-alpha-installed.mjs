#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function assertDirectory(path, label) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory: ${path}`);
}

function walkTree(rootPath) {
  const hash = createHash("sha256");
  const resolvedRoot = realpathSync(resolve(rootPath));
  const visit = (current, relativePath) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const stat = lstatSync(fullPath);
      hash.update(`${childRelativePath}\0${stat.mode}\0${stat.size}\0`);
      if (stat.isSymbolicLink()) {
        const target = realpathSync(fullPath);
        const targetRelative = relative(resolvedRoot, target);
        if (targetRelative.startsWith("..") || isAbsolute(targetRelative)) {
          throw new Error(`app tree symlink escapes bundle: ${childRelativePath}`);
        }
        hash.update(readlinkSync(fullPath));
      } else if (stat.isDirectory()) {
        visit(fullPath, childRelativePath);
      } else if (stat.isFile()) {
        hash.update(readFileSync(fullPath));
      } else {
        throw new Error(`unsupported app tree entry: ${childRelativePath}`);
      }
    }
  };
  visit(resolvedRoot, "");
  return hash.digest("hex");
}

function readPlistValue(appPath, key) {
  return execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print :${key}`, join(appPath, "Contents", "Info.plist")],
    { encoding: "utf8" },
  ).trim();
}

export function verifyLocalAlphaApp(appPath, expectedVersion = version) {
  assertDirectory(appPath, "candidate app");
  const bundleId = readPlistValue(appPath, "CFBundleIdentifier");
  const shortVersion = readPlistValue(appPath, "CFBundleShortVersionString");
  const executable = readPlistValue(appPath, "CFBundleExecutable");
  if (bundleId !== "com.acevra.desktop") throw new Error(`unexpected app bundle id: ${bundleId}`);
  if (shortVersion !== expectedVersion) {
    throw new Error(`unexpected app version: ${shortVersion}, expected ${expectedVersion}`);
  }
  const executablePath = join(appPath, "Contents", "MacOS", executable);
  const arch = execFileSync("/usr/bin/lipo", ["-archs", executablePath], { encoding: "utf8" })
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (arch.length !== 1 || arch[0] !== "arm64") {
    throw new Error(`candidate app architecture is ${arch.join(",") || "unknown"}, expected arm64`);
  }
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", "--deep", appPath], {
    stdio: "ignore",
  });
  const detailsResult = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], {
    encoding: "utf8",
  });
  const requirementResult = spawnSync("/usr/bin/codesign", ["-d", "-r-", appPath], {
    encoding: "utf8",
  });
  if (detailsResult.status !== 0 || requirementResult.status !== 0) {
    throw new Error("candidate app signature details could not be read");
  }
  const details = `${detailsResult.stdout ?? ""}${detailsResult.stderr ?? ""}`;
  const requirement = `${requirementResult.stdout ?? ""}${requirementResult.stderr ?? ""}`;
  const detailsText = `${details}${requirement}`;
  if (/Signature=adhoc/i.test(detailsText)) throw new Error("candidate app is ad-hoc signed");
  if (!detailsText.includes("Authority=AceVra CUA Dev Signing")) {
    throw new Error("candidate app is not signed by the local AceVra identity");
  }
  if (
    !requirement.includes('identifier "com.acevra.desktop"') ||
    !requirement.includes("certificate root = H")
  ) {
    throw new Error("candidate app designated requirement is not certificate-root anchored");
  }
  return { bundleId, shortVersion, executable, treeHash: walkTree(appPath) };
}

function defaultIsRunning(targetPath) {
  try {
    execFileSync("/usr/bin/pgrep", ["-f", targetPath], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function validateHandoff(handoffPath, expectedVersion = version) {
  assertDirectory(handoffPath, "handoff");
  const entries = readdirSync(handoffPath).sort();
  const expected = [
    `AceVra-${expectedVersion}-arm64.dmg`,
    `AceVra-${expectedVersion}-arm64.zip`,
    "build-info.json",
    "RELEASE_NOTES.md",
    "SHA256SUMS.txt",
  ].sort();
  if (entries.join("\n") !== expected.join("\n")) {
    throw new Error(`handoff is not the exact five-file candidate: ${entries.join(", ")}`);
  }
  const checksumText = readFileSync(join(handoffPath, "SHA256SUMS.txt"), "utf8");
  for (const archive of [expected[0], expected[1]]) {
    const line = checksumText
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.endsWith(`  ${archive}`));
    if (!line) throw new Error(`SHA256SUMS.txt is missing ${archive}`);
    const actual = sha256(join(handoffPath, archive));
    if (line.split(/\s+/)[0] !== actual) throw new Error(`checksum mismatch for ${archive}`);
  }
  return { path: resolve(handoffPath), entries: expected };
}

function uniqueSiblingPath(targetPath, label) {
  return join(dirname(targetPath), `.${basename(targetPath)}.${label}-${randomUUID()}`);
}

export function installCandidate({
  handoffPath,
  sourceAppPath,
  targetPath,
  expectedVersion = version,
  verifyApp = verifyLocalAlphaApp,
  isRunning = defaultIsRunning,
}) {
  const handoff = validateHandoff(handoffPath, expectedVersion);
  const target = resolve(targetPath);
  const source = resolve(sourceAppPath);
  mkdirSync(dirname(target), { recursive: true });
  if (source === target) throw new Error("source app and installed target must be different paths");
  const sourceInfo = verifyApp(source, expectedVersion);
  const targetExists = existsSync(target);
  let backupPath;
  if (targetExists) {
    assertDirectory(target, "installed app");
    if (isRunning(target)) throw new Error(`installed AceVra app is running: ${target}`);
    verifyApp(target, expectedVersion);
    backupPath = uniqueSiblingPath(target, "backup");
  }

  const stagingPath = uniqueSiblingPath(target, "staging");
  execFileSync("/usr/bin/ditto", [source, stagingPath]);
  try {
    const stagingInfo = verifyApp(stagingPath, expectedVersion);
    if (stagingInfo.treeHash !== sourceInfo.treeHash) {
      throw new Error("staging tree hash does not match the validated source app");
    }
    if (targetExists) renameSync(target, backupPath);
    try {
      renameSync(stagingPath, target);
      verifyApp(target, expectedVersion);
    } catch (error) {
      if (backupPath && existsSync(backupPath)) {
        if (existsSync(target)) rmSync(target, { recursive: true, force: true });
        renameSync(backupPath, target);
      }
      throw error;
    }
  } catch (error) {
    if (existsSync(stagingPath)) rmSync(stagingPath, { recursive: true, force: true });
    if (backupPath && existsSync(backupPath) && !existsSync(target)) renameSync(backupPath, target);
    throw error;
  }

  return {
    handoff,
    sourceAppPath: source,
    targetPath: target,
    backupPath: backupPath ?? null,
    sourceTreeHash: sourceInfo.treeHash,
    targetTreeHash: walkTree(target),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const handoffPath = argValue("--handoff");
  const sourceAppPath = argValue("--source-app");
  const targetPath = argValue("--app");
  if (!handoffPath || !sourceAppPath || !targetPath) {
    throw new Error("--handoff, --source-app, and --app are required");
  }
  const result = installCandidate({
    handoffPath,
    sourceAppPath,
    targetPath,
  });
  console.log(
    `[installed] candidate installed transaction completed: ${result.targetPath}; backup=${result.backupPath ?? "none"}`,
  );
  console.log("[installed] human Gatekeeper/TCC/CUA checkpoints remain intentionally pending");
}
