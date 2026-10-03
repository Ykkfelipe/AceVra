import assert from "node:assert/strict";
import test from "node:test";
import { resolveSafeAccountSignInReturn } from "../src/accountSignInReturn.js";

const ORIGIN = "https://app.acevra.ai";
const options = { allowedOrigin: ORIGIN, allowedPaths: new Set(["/", "/fork"]) };

test("an allowlisted same-origin path round-trips to an absolute URL", () => {
  assert.equal(resolveSafeAccountSignInReturn(`${ORIGIN}/fork`, options), `${ORIGIN}/fork`);
  assert.equal(resolveSafeAccountSignInReturn(`${ORIGIN}/`, options), `${ORIGIN}/`);
});

test("query and fragment are dropped so callers cannot smuggle state past validation", () => {
  assert.equal(
    resolveSafeAccountSignInReturn(`${ORIGIN}/fork?next=https://evil.example`, options),
    `${ORIGIN}/fork`,
  );
  assert.equal(resolveSafeAccountSignInReturn(`${ORIGIN}/fork#token`, options), `${ORIGIN}/fork`);
});

test("a cross-origin candidate is rejected even on an allowlisted path", () => {
  assert.equal(resolveSafeAccountSignInReturn("https://evil.example/fork", options), null);
  // A subdomain is a different origin, not a more specific match.
  assert.equal(
    resolveSafeAccountSignInReturn("https://app.acevra.ai.evil.example/", options),
    null,
  );
  // A different port or scheme is also a different origin.
  assert.equal(resolveSafeAccountSignInReturn("http://app.acevra.ai/", options), null);
  assert.equal(resolveSafeAccountSignInReturn("https://app.acevra.ai:8443/", options), null);
});

test("a protocol-relative candidate is rejected rather than resolved against the page", () => {
  assert.equal(resolveSafeAccountSignInReturn("//evil.example/fork", options), null);
  // Same host but still protocol-relative: reject rather than guess the scheme.
  assert.equal(resolveSafeAccountSignInReturn("//app.acevra.ai/fork", options), null);
});

test("credentials embedded in the URL are rejected", () => {
  assert.equal(resolveSafeAccountSignInReturn("https://user:pw@app.acevra.ai/", options), null);
  assert.equal(resolveSafeAccountSignInReturn("https://user@app.acevra.ai/", options), null);
});

test("a path outside the allowlist is rejected", () => {
  assert.equal(resolveSafeAccountSignInReturn(`${ORIGIN}/admin`, options), null);
  assert.equal(resolveSafeAccountSignInReturn(`${ORIGIN}/fork/../admin`, options), null);
  assert.equal(resolveSafeAccountSignInReturn(`${ORIGIN}/fork/extra`, options), null);
  assert.equal(resolveSafeAccountSignInReturn(`${ORIGIN}/FORK`, options), null);
});

test("malformed and empty candidates are rejected instead of throwing", () => {
  for (const value of [undefined, "", "   ", "not a url", "/fork", "javascript:alert(1)"]) {
    assert.equal(
      resolveSafeAccountSignInReturn(value, options),
      null,
      `expected null for ${value}`,
    );
  }
});

test("an unusable allowed origin fails closed instead of accepting everything", () => {
  assert.equal(
    resolveSafeAccountSignInReturn(`${ORIGIN}/fork`, {
      ...options,
      allowedOrigin: "not-an-origin",
    }),
    null,
  );
});

test("an empty path allowlist admits nothing", () => {
  assert.equal(
    resolveSafeAccountSignInReturn(`${ORIGIN}/fork`, {
      allowedOrigin: ORIGIN,
      allowedPaths: new Set(),
    }),
    null,
  );
});
