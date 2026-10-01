import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  installCandidate,
  installedAppProcessPattern,
  validateHandoff,
} from "./accept-local-alpha-installed.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function createFixture(root, version) {
  const handoff = join(root, "handoff");
  mkdirSync(handoff);
  const dmgName = `AceVra-${version}-arm64.dmg`;
  const zipName = `AceVra-${version}-arm64.zip`;
  const dmg = Buffer.from("dmg");
  const zip = Buffer.from("zip");
  writeFileSync(join(handoff, dmgName), dmg);
  writeFileSync(join(handoff, zipName), zip);
  writeFileSync(join(handoff, "build-info.json"), "{}\n");
  writeFileSync(join(handoff, "RELEASE_NOTES.md"), "notes\n");
  writeFileSync(
    join(handoff, "SHA256SUMS.txt"),
    `${sha256(dmg)}  ${dmgName}\n${sha256(zip)}  ${zipName}\n`,
  );

  const source = join(root, "source", "AceVra.app");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "marker"), "candidate");
  return { handoff, source, dmgName, zipName };
}

function fixtureVerifier(path) {
  const markerPath = join(path, "marker");
  return {
    bundleId: "com.acevra.desktop",
    shortVersion: "0.1.0-alpha.1",
    executable: "AceVra",
    treeHash: readFileSync(markerPath, "utf8"),
  };
}

test("validates the exact five-file handoff and checksums", () => {
  const root = mkdtempSync(join(tmpdir(), "acevra-handoff-"));
  try {
    const fixture = createFixture(root, "0.1.0-alpha.1");
    assert.deepEqual(
      validateHandoff(fixture.handoff).entries,
      [
        "AceVra-0.1.0-alpha.1-arm64.dmg",
        "AceVra-0.1.0-alpha.1-arm64.zip",
        "SHA256SUMS.txt",
        "RELEASE_NOTES.md",
        "build-info.json",
      ].sort(),
    );
    writeFileSync(join(fixture.handoff, "debug.yaml"), "not allowed\n");
    assert.throws(() => validateHandoff(fixture.handoff), /exact five-file candidate/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installs a fresh candidate without creating a backup", () => {
  const root = mkdtempSync(join(tmpdir(), "acevra-install-"));
  try {
    const fixture = createFixture(root, "0.1.0-alpha.1");
    const target = join(root, "Applications", "AceVra.app");
    const result = installCandidate({
      handoffPath: fixture.handoff,
      sourceAppPath: fixture.source,
      targetPath: target,
      verifyApp: fixtureVerifier,
      isRunning: () => false,
    });
    assert.equal(result.backupPath, null);
    assert.equal(readFileSync(join(target, "marker"), "utf8"), "candidate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backs up an existing app and rolls back an ambiguous target", () => {
  const root = mkdtempSync(join(tmpdir(), "acevra-install-"));
  try {
    const fixture = createFixture(root, "0.1.0-alpha.1");
    const target = join(root, "Applications", "AceVra.app");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "marker"), "existing");
    const result = installCandidate({
      handoffPath: fixture.handoff,
      sourceAppPath: fixture.source,
      targetPath: target,
      verifyApp: fixtureVerifier,
      isRunning: () => false,
    });
    assert.ok(result.backupPath);
    assert.equal(readFileSync(join(target, "marker"), "utf8"), "candidate");
    assert.equal(readFileSync(join(result.backupPath, "marker"), "utf8"), "existing");

    const ambiguousTarget = join(root, "Applications", "Ambiguous.app");
    mkdirSync(ambiguousTarget, { recursive: true });
    writeFileSync(join(ambiguousTarget, "marker"), "existing");
    assert.throws(
      () =>
        installCandidate({
          handoffPath: fixture.handoff,
          sourceAppPath: fixture.source,
          targetPath: ambiguousTarget,
          verifyApp: (path) => {
            if (path === ambiguousTarget) throw new Error("ambiguous provenance");
            return fixtureVerifier(path);
          },
          isRunning: () => false,
        }),
      /ambiguous provenance/,
    );
    assert.equal(readFileSync(join(ambiguousTarget, "marker"), "utf8"), "existing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("running-app check only matches processes executing from inside the installed bundle", () => {
  const pattern = new RegExp(installedAppProcessPattern("/Applications/AceVra.app"));
  assert.ok(pattern.test("/Applications/AceVra.app/Contents/MacOS/AceVra"));
  assert.ok(
    pattern.test(
      "/Applications/AceVra.app/Contents/Frameworks/AceVra Helper (Renderer).app/Contents/MacOS/AceVra Helper (Renderer) --type=renderer",
    ),
  );
  // The installer itself (and shells/greps) only mention the path as an argument.
  assert.ok(
    !pattern.test(
      "node scripts/release/accept-local-alpha-installed.mjs --app /Applications/AceVra.app",
    ),
  );
  assert.ok(!pattern.test("/usr/bin/pgrep -f /Applications/AceVra.app"));
  assert.ok(!pattern.test("/Applications/.AceVra.app.backup-1/Contents/MacOS/AceVra"));
  assert.ok(!pattern.test("/Applications/AceVraXapp/Contents/MacOS/AceVra"));
});
