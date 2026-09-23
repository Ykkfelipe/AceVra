/**
 * Connected accounts presentation rules.
 *
 * These pin the two rules the redesign depends on:
 *  - a reported figure is never synthesised (no window without a used percentage, no reset
 *    time without one, no sign-in claim the host never verified), and
 *  - a window is named from the length Codex reported rather than assumed to be the 5-hour one.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AccountBridgeStatus } from "@zcode/shared";
import {
  formatAccountPlanLabel,
  hasVerifiedSignIn,
  resolveAccountBridgeStatusView,
  resolveCodexUsageWindowLabel,
  resolveCodexUsageWindows,
  resolveUsageBlockedLabelId,
} from "../src/settings/account-bridge/accountBridgePresentation.js";

function status(overrides: Partial<AccountBridgeStatus>): AccountBridgeStatus {
  return {
    source: "codex",
    installed: true,
    state: "connected",
    sourceSignedIn: true,
    sourceSignInChecked: true,
    checkedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("bridge state maps to the shipped status tones and labels", () => {
  assert.deepEqual(resolveAccountBridgeStatusView(undefined), {
    tone: "subtle",
    labelId: "settings.accounts.bridge.notInstalled",
    spinning: false,
  });
  assert.deepEqual(resolveAccountBridgeStatusView(status({ installed: false, state: "not-installed" })), {
    tone: "subtle",
    labelId: "settings.accounts.bridge.notInstalled",
    spinning: false,
  });
  assert.equal(resolveAccountBridgeStatusView(status({ state: "connected" })).tone, "green");
  assert.equal(
    resolveAccountBridgeStatusView(status({ state: "connecting" })).spinning,
    true,
    "connecting must spin",
  );
  assert.equal(resolveAccountBridgeStatusView(status({ state: "error" })).tone, "red");
  assert.equal(resolveAccountBridgeStatusView(status({ state: "disconnected" })).tone, "subtle");
});

test("sign-in is only treated as a fact when the host actually checked it", () => {
  assert.equal(hasVerifiedSignIn(status({})), true);
  // Codex reports a placeholder while its app-server is not running: the snapshot is real,
  // but the sign-in value in it was never verified.
  assert.equal(
    hasVerifiedSignIn(status({ sourceSignInChecked: false, sourceSignedIn: false })),
    false,
  );
  assert.equal(hasVerifiedSignIn(undefined), false);
});

test("derives remaining percentage from the reported used percentage", () => {
  // Real capture: primary usedPercent 100 over a 300-minute window.
  const [fiveHour] = resolveCodexUsageWindows({
    primaryUsedPercent: 100,
    primaryWindowDurationMins: 300,
  });
  assert.equal(fiveHour?.remainingPercent, 0);
  const [weekly] = resolveCodexUsageWindows({ secondaryUsedPercent: 16 });
  assert.equal(weekly?.remainingPercent, 84);
});

test("omits a window the backend did not report a percentage for", () => {
  const windows = resolveCodexUsageWindows({ secondaryUsedPercent: 16 });
  assert.deepEqual(
    windows.map((window) => window.key),
    ["secondary"],
    "an unreported primary window must not render an empty bar",
  );
  assert.deepEqual(resolveCodexUsageWindows({ ordinaryUsageAllowed: false }), []);
  assert.deepEqual(resolveCodexUsageWindows(undefined), []);
});

test("keeps a reset time and duration only when they were reported", () => {
  const [window] = resolveCodexUsageWindows({ primaryUsedPercent: 50 });
  assert.equal(window?.resetsAt, undefined);
  assert.equal(window?.windowDurationMins, undefined);
});

test("names a window from the reported length, and reuses the shipped Z.ai wording", () => {
  assert.deepEqual(resolveCodexUsageWindowLabel(300), {
    id: "settings.usage.entitlementFiveHourUsage",
  });
  assert.deepEqual(resolveCodexUsageWindowLabel(10080), {
    id: "settings.usage.entitlementWeeklyUsage",
  });
  assert.deepEqual(resolveCodexUsageWindowLabel(45), {
    id: "settings.accounts.usage.windowDuration",
    values: { minutes: "45" },
  });
  assert.deepEqual(resolveCodexUsageWindowLabel(undefined), {
    id: "settings.accounts.usage.windowUnspecified",
  });
});

test("names the blocked reason only for documented backend values", () => {
  assert.equal(
    resolveUsageBlockedLabelId("rate_limit_reached"),
    "settings.accounts.usage.blocked.rateLimitReached",
  );
  assert.equal(
    resolveUsageBlockedLabelId("workspace_member_credits_depleted"),
    "settings.accounts.usage.blocked.workspaceCreditsDepleted",
  );
  assert.equal(
    resolveUsageBlockedLabelId("workspace_owner_usage_limit_reached"),
    "settings.accounts.usage.blocked.workspaceUsageLimitReached",
  );
  assert.equal(resolveUsageBlockedLabelId(undefined), "settings.accounts.usage.blocked.generic");
  assert.equal(
    resolveUsageBlockedLabelId("something_new"),
    "settings.accounts.usage.blocked.generic",
  );
});

test("makes a raw plan identifier presentable without changing its claim", () => {
  assert.equal(formatAccountPlanLabel("plus"), "Plus");
  assert.equal(formatAccountPlanLabel("self_serve_business_usage_based"), "Self Serve Business Usage Based");
  assert.equal(formatAccountPlanLabel("  "), undefined);
  assert.equal(formatAccountPlanLabel(undefined), undefined);
});

test("treats a reported zero as a real value rather than as missing", () => {
  assert.deepEqual(resolveCodexUsageWindows({ primaryUsedPercent: 0 }), [
    { key: "primary", remainingPercent: 100 },
  ]);
  assert.deepEqual(resolveCodexUsageWindows({ primaryUsedPercent: 100 }), [
    { key: "primary", remainingPercent: 0 },
  ]);
});
