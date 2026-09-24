import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LOCAL_ENGINEERING_ALPHA_PROFILE,
  canonicalizeProfileRoot,
  resolveLocalAlphaDataBaseRoot,
  resolveLocalEngineeringAlphaPaths,
} from "./desktop-release-profile.mjs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "acevra-alpha-profile-"));
}

test("alpha defaults use the exact profile filesystem contract", () => {
  const home = tempDir();
  const paths = resolveLocalEngineeringAlphaPaths({
    env: { ZCODE_DESKTOP_RELEASE_PROFILE: LOCAL_ENGINEERING_ALPHA_PROFILE },
    homeDir: home,
    platform: "darwin",
  });
  assert.equal(paths.profileHome, join(home, ".zcode-local-engineering-alpha"));
  assert.equal(paths.dataBaseDir, paths.profileHome);
  assert.equal(paths.zcodeHome, join(paths.profileHome, ".zcode"));
  assert.equal(paths.appConfigDir, join(paths.profileHome, ".zcode", "v2"));
  assert.equal(paths.cuaRoot, join(paths.profileHome, ".zcode", "computer-use"));
  assert.equal(
    paths.userData,
    join(home, "Library", "Application Support", "AceVra Local Engineering Alpha"),
  );
  assert.equal(paths.sessionData, join(paths.userData, "session"));
  assert.equal(paths.source, "alpha-default");
});

test("either explicit override may be supplied alone and wins over the default", () => {
  const home = tempDir();
  const dataBaseOnly = resolveLocalAlphaDataBaseRoot({
    env: { ZCODE_DATA_BASE_DIR: join(home, "alpha-data") },
    homeDir: home,
  });
  assert.equal(dataBaseOnly.root, join(home, "alpha-data"));
  assert.equal(dataBaseOnly.source, "data-base-dir");

  const homeOnly = resolveLocalAlphaDataBaseRoot({
    env: { ZCODE_DESKTOP_HOME_DIR: join(home, "alpha-home") },
    homeDir: home,
  });
  assert.equal(homeOnly.root, join(home, "alpha-home"));
  assert.equal(homeOnly.source, "desktop-home-dir");
});

test("both overrides are accepted only when they canonicalize to the same root", () => {
  const home = tempDir();
  const shared = join(home, "shared-root");
  mkdirSync(shared, { recursive: true });
  const link = join(home, "shared-link");
  symlinkSync(shared, link);

  const accepted = resolveLocalAlphaDataBaseRoot({
    env: { ZCODE_DESKTOP_HOME_DIR: link, ZCODE_DATA_BASE_DIR: shared },
    homeDir: home,
    platform: "darwin",
  });
  assert.equal(accepted.root, shared);
  assert.equal(accepted.source, "explicit-both");

  assert.throws(
    () =>
      resolveLocalAlphaDataBaseRoot({
        env: { ZCODE_DESKTOP_HOME_DIR: join(home, "one"), ZCODE_DATA_BASE_DIR: join(home, "two") },
        homeDir: home,
      }),
    /profile\/path conflict/,
  );
});

test("realpath canonicalization resolves symlinked overrides", () => {
  const home = tempDir();
  const target = join(home, "real");
  mkdirSync(target, { recursive: true });
  const link = join(home, "link");
  symlinkSync(target, link);
  assert.equal(canonicalizeProfileRoot(link), canonicalizeProfileRoot(realpathSync(target)));
});
