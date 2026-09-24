import assert from "node:assert/strict";
import test from "node:test";
import { resolveCuaHelperBuildMetadata } from "./build-metadata.mjs";

test("Helper build metadata is deterministic and numeric", () => {
  const metadata = resolveCuaHelperBuildMetadata({}, "0.1.0-alpha.1");
  assert.equal(metadata.helperVersion, "0.1.0-alpha.1");
  assert.equal(metadata.helperBuildNumber, "1");
  assert.equal(metadata.cuaSigningIdentityName, null);
});

test("explicit build number must be numeric and the alpha records its signing identity", () => {
  const metadata = resolveCuaHelperBuildMetadata(
    {
      ZCODE_DESKTOP_RELEASE_PROFILE: "local-engineering-alpha",
      ZCODE_CUA_HELPER_BUILD_NUMBER: "42",
    },
    "0.1.0-alpha.1",
  );
  assert.equal(metadata.helperBuildNumber, "42");
  assert.equal(metadata.cuaSigningIdentityName, "AceVra CUA Dev Signing");
  assert.throws(() => resolveCuaHelperBuildMetadata({ ZCODE_CUA_HELPER_BUILD_NUMBER: "ts" }, "1"));
});
