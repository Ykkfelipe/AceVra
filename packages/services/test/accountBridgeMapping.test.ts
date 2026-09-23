/**
 * Account bridge wire→contract mapping.
 *
 * The Codex fixtures below are the real `account/read` and `account/rateLimits/read`
 * responses captured from the bundled `codex-cli 0.155.0-alpha.9.2` app-server on this
 * machine (identity/account values redacted). They pin the protocol so CLI drift fails
 * loudly instead of silently emptying the usage card.
 *
 * The mapping must never synthesise a value: an absent backend field stays absent so the UI
 * can distinguish "not reported" from "zero".
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  mapClaudeAuthStatusIdentity,
  mapCodexAccountUsage,
  mapCodexIdentity,
} from "../src/accounts/accountBridgeMapping.js";

const CODEX_RATE_LIMITS_RESPONSE = {
  ordinaryUsageAllowed: false,
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1790142223 },
    secondary: { usedPercent: 16, windowDurationMins: 10080, resetsAt: 1790729023 },
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    spendControlReached: false,
    planType: "plus",
    rateLimitReachedType: "rate_limit_reached",
  },
  rateLimitResetCredits: { availableCount: 0, credits: [] },
};

test("maps the observed Codex rate-limit response into both usage windows", () => {
  const usage = mapCodexAccountUsage(CODEX_RATE_LIMITS_RESPONSE);
  assert.ok(usage);
  assert.equal(usage.ordinaryUsageAllowed, false);
  assert.equal(usage.blockedReason, "rate_limit_reached");
  assert.equal(usage.primaryUsedPercent, 100);
  assert.equal(usage.primaryWindowDurationMins, 300);
  assert.equal(usage.primaryResetsAt, new Date(1790142223 * 1000).toISOString());
  assert.equal(usage.secondaryUsedPercent, 16);
  assert.equal(usage.secondaryWindowDurationMins, 10080);
  assert.equal(usage.secondaryResetsAt, new Date(1790729023 * 1000).toISOString());
});

test("omits every field the backend did not report instead of defaulting to zero", () => {
  const usage = mapCodexAccountUsage({ rateLimits: { primary: { usedPercent: 42 } } });
  assert.deepEqual(usage, { primaryUsedPercent: 42 });
});

test("falls back to the first bucket of rateLimitsByLimitId when rateLimits is absent", () => {
  const usage = mapCodexAccountUsage({
    rateLimitsByLimitId: {
      codex: { secondary: { usedPercent: 7, windowDurationMins: 10080 } },
    },
  });
  assert.deepEqual(usage, { secondaryUsedPercent: 7, secondaryWindowDurationMins: 10080 });
});

test("drops an unrecognised blocked reason rather than forwarding a backend string", () => {
  const usage = mapCodexAccountUsage({
    rateLimits: { rateLimitReachedType: "some_future_reason" },
  });
  assert.equal(usage, undefined);
});

test("clamps an out-of-range percentage and ignores a non-positive reset time", () => {
  const usage = mapCodexAccountUsage({
    rateLimits: { primary: { usedPercent: 180, resetsAt: 0, windowDurationMins: 0 } },
  });
  assert.deepEqual(usage, { primaryUsedPercent: 100 });
});

test("returns undefined for a response with no usable usage fields", () => {
  assert.equal(mapCodexAccountUsage(null), undefined);
  assert.equal(mapCodexAccountUsage({ rateLimits: null }), undefined);
});

test("maps the observed Codex account identity", () => {
  assert.deepEqual(
    mapCodexIdentity({ type: "chatgpt", email: "u@example.com", planType: "plus" }),
    { email: "u@example.com", planType: "plus" },
  );
  assert.equal(mapCodexIdentity(null), undefined);
  assert.equal(mapCodexIdentity({ type: "chatgpt" }), undefined);
});

test("maps the observed Claude auth status including subscription tier", () => {
  assert.deepEqual(
    mapClaudeAuthStatusIdentity({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      email: "u@example.com",
      orgId: "org-1",
      orgName: "Example Org",
      subscriptionType: "pro",
    }),
    {
      email: "u@example.com",
      planType: "pro",
      authMethod: "claude.ai",
      apiProvider: "firstParty",
    },
  );
});

test("maps Claude signed-out status without inventing an email or plan", () => {
  assert.deepEqual(
    mapClaudeAuthStatusIdentity({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }),
    { authMethod: "none", apiProvider: "firstParty" },
  );
});
