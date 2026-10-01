import assert from "node:assert/strict";
import test from "node:test";
import { buildAccountCsp, resolveAccountAsset } from "./accountProtocol.js";
import { registerPrivilegedSchemes } from "./accountScheme.js";
import { clerkFrontendHost } from "./accountConfig.js";

const dir = "/app/out/renderer";

test("only the account entry and assets are served", () => {
  assert.equal(resolveAccountAsset("acevra-account://renderer/", dir), `${dir}/account.html`);
  assert.equal(
    resolveAccountAsset("acevra-account://renderer/assets/a.js", dir),
    `${dir}/assets/a.js`,
  );
  for (const bad of [
    "acevra-account://renderer/index.html",
    "acevra-account://renderer/../index.html",
    "acevra-account://renderer/assets/../../secret",
    "acevra-account://renderer/assets/%2e%2e/%2e%2e/secret",
    "acevra-account://renderer/%2e%2e/index.html",
    "acevra-account://other/account.html",
    "https://renderer/account.html",
    "acevra-account://renderer/assets%00/x",
    "not a url",
  ]) {
    assert.equal(resolveAccountAsset(bad, dir), null, bad);
  }
});

test("CSP derives the Clerk Frontend API host and never allows eval", () => {
  const key = `pk_test_${Buffer.from("example-1.clerk.accounts.dev$").toString("base64")}`;
  assert.equal(clerkFrontendHost(key), "example-1.clerk.accounts.dev");
  const csp = buildAccountCsp(key);
  assert.match(csp, /script-src 'self' 'unsafe-inline' https:\/\/example-1\.clerk\.accounts\.dev/);
  assert.ok(!csp.includes("unsafe-eval"));
});

test("privileged schemes are declared in one call so neither registration is lost", () => {
  const calls: unknown[][] = [];
  registerPrivilegedSchemes(
    { registerSchemesAsPrivileged: (s) => calls.push(s) },
    { accountEnabled: true },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(
    (calls[0] as { scheme: string }[]).map((s) => s.scheme).sort(),
    ["acevra-account", "zcode-media"].sort(),
  );
  const local = [] as unknown[][];
  registerPrivilegedSchemes(
    { registerSchemesAsPrivileged: (s) => local.push(s) },
    { accountEnabled: false },
  );
  assert.deepEqual(
    (local[0] as { scheme: string }[]).map((s) => s.scheme),
    ["zcode-media"],
  );
});
