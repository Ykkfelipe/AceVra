/**
 * Command Code status adapter — parsing contract.
 *
 * The CLI's documented automation surface is `commandcode status --json`
 * ("Output status as JSON for automation"). Parsing is isolated here rather than scattered
 * through UI code, so the contract is pinned and any CLI drift fails loudly.
 *
 * Observed contract (CLI v1.62.1):
 *   {"authenticated":true,"version":"1.62.1","user":"…","model":"…","context_window":1000000}
 *
 * Plan and usage metrics are intentionally absent: the CLI exposes them only through the
 * interactive `/usage` overlay, which refuses to run headlessly. The adapter therefore
 * reports them unavailable rather than inferring figures.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  isCommandCodeMissingExecutableError,
  parseCommandCodeStatusJson,
} from "../src/accounts/commandCodeStatusAdapter.js";

test("parses the documented status --json payload", () => {
  const parsed = parseCommandCodeStatusJson(
    '{"authenticated":true,"version":"1.62.1","user":"someone","model":"deepseek/deepseek-v4-flash","context_window":1000000}',
  );
  assert.equal(parsed.authenticated, true);
  assert.equal(parsed.version, "1.62.1");
  assert.equal(parsed.user, "someone");
  assert.equal(parsed.defaultModel, "deepseek/deepseek-v4-flash");
  assert.equal(parsed.contextWindow, 1_000_000);
});

test("treats a signed-out payload as unauthenticated", () => {
  const parsed = parseCommandCodeStatusJson('{"authenticated":false,"version":"1.62.1"}');
  assert.equal(parsed.authenticated, false);
  assert.equal(parsed.user, undefined);
});

test("ignores unknown and wrongly typed fields rather than trusting them", () => {
  const parsed = parseCommandCodeStatusJson(
    '{"authenticated":"yes","version":42,"user":null,"context_window":"1000000","futureField":1}',
  );
  // "yes" is not boolean true, so authentication must not be assumed.
  assert.equal(parsed.authenticated, false);
  assert.equal(parsed.version, undefined);
  assert.equal(parsed.user, undefined);
  assert.equal(parsed.contextWindow, undefined);
});

test("never surfaces an apiKey even if the CLI were to emit one", () => {
  const parsed = parseCommandCodeStatusJson(
    '{"authenticated":true,"apiKey":"cmd-secret-value","token":"secret"}',
  );
  assert.equal(Object.hasOwn(parsed, "apiKey"), false);
  assert.equal(Object.hasOwn(parsed, "token"), false);
  assert.doesNotMatch(JSON.stringify(parsed), /secret/);
});

test("only ENOENT means the Command Code executable is not installed", () => {
  assert.equal(isCommandCodeMissingExecutableError({ code: "ENOENT" }), true);
  assert.equal(isCommandCodeMissingExecutableError({ code: "ETIMEDOUT" }), false);
  assert.equal(isCommandCodeMissingExecutableError({ code: "EACCES" }), false);
  assert.equal(isCommandCodeMissingExecutableError(new Error("crashed")), false);
});
