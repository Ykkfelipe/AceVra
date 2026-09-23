import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { installLinuxAppImageDesktopIconBestEffort } from "../src/main/desktopLinuxAppImageIcon.js";

test("AppImage user icon filename matches the AceVra desktop entry icon name", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "acevra-appimage-icon-"));
  try {
    const iconSourcePath = join(tempRoot, "source.png");
    const dataDir = join(tempRoot, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(iconSourcePath, "icon-bytes");

    const result = installLinuxAppImageDesktopIconBestEffort({
      dataDir,
      env: { APPIMAGE: "/tmp/AceVra.AppImage" },
      iconSourcePath,
      logger: { info() {}, warn() {} },
      runCommand: () => ({ status: 0 }),
    });

    assert.ok(result);
    assert.equal(basename(result.iconFilePath), "acevra.png");
    assert.equal(readFileSync(result.iconFilePath, "utf8"), "icon-bytes");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
