import assert from "node:assert/strict";
import test from "node:test";
import { resolveDataBaseDir } from "../src/paths.js";

test("AceVra development stays isolated from the official ZCode home", () => {
  assert.equal(
    resolveDataBaseDir({
      env: { ZCODE_FORK_DEV: "1", HOME: "/official-home" },
      homeDir: "/os-home",
    }),
    "/os-home/.zcode-fork-dev-home",
  );
  assert.equal(
    resolveDataBaseDir({ env: { HOME: "/official-home" }, homeDir: "/os-home" }),
    "/official-home",
  );
});

test("explicit data base directory overrides custom fork defaults", () => {
  assert.equal(
    resolveDataBaseDir({
      env: {
        ZCODE_FORK_DEV: "1",
        ZCODE_DATA_BASE_DIR: "/custom/data",
        HOME: "/official-home",
      },
      homeDir: "/os-home",
    }),
    "/custom/data",
  );
});

test("an explicit .zcode home resolves to its containing data base", () => {
  assert.equal(
    resolveDataBaseDir({ env: { ZCODE_HOME: "/tmp/fork-root/.zcode" }, homeDir: "/home/test" }),
    "/tmp/fork-root",
  );
});

test("official runtime retains its HOME-based data root", () => {
  assert.equal(
    resolveDataBaseDir({ env: { HOME: "/official-home" }, homeDir: "/os-home" }),
    "/official-home",
  );
});
