import assert from "node:assert/strict";
import test from "node:test";
import { buildDesktopOAuthRedirectUriFromEnv } from "../src/oauth/providers/configUtils.js";

test("desktop OAuth keeps the provider-registered zcode callback URI", () => {
  const redirect = new URL(buildDesktopOAuthRedirectUriFromEnv({ ZCODE_ENV: "production" }));
  assert.equal(redirect.searchParams.get("redirect"), "zcode://oauth/callback");
});
