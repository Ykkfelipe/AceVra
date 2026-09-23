/**
 * Presentation rules for the Connected accounts screens.
 *
 * Everything here is a pure mapping from the sanitized `AccountBridge*` contract onto
 * display facts. Keeping it out of the components lets the status and usage rules be unit
 * tested, and keeps the rule "never invent a figure the source app did not report" in one
 * place: a window is rendered only when the backend supplied `usedPercent`, and a resets-at
 * value only when the backend supplied one.
 */
import type { AccountBridgeStatus, AccountBridgeUsage } from "@zcode/shared";
import type { StatusDotTone } from "@/settings/StatusDot.js";

/** Codex reports the 5-hour window as 300 minutes and the weekly window as 10080. */
const FIVE_HOUR_WINDOW_MINUTES = 300;
const WEEKLY_WINDOW_MINUTES = 10080;

interface AccountBridgeStatusView {
  tone: StatusDotTone;
  labelId: string;
  spinning: boolean;
}

/** Harness-side link state. Deliberately says nothing about the source app's own login. */
export function resolveAccountBridgeStatusView(
  status: AccountBridgeStatus | undefined,
): AccountBridgeStatusView {
  if (!status || !status.installed) {
    return { tone: "subtle", labelId: "settings.accounts.bridge.notInstalled", spinning: false };
  }
  switch (status.state) {
    case "connected":
      return { tone: "green", labelId: "settings.accounts.bridge.connected", spinning: false };
    case "loading":
      return { tone: "amber", labelId: "settings.accounts.bridge.connecting", spinning: true };
    case "error":
      return { tone: "red", labelId: "settings.accounts.bridge.error", spinning: false };
    default:
      return { tone: "subtle", labelId: "settings.accounts.bridge.disconnected", spinning: false };
  }
}

/**
 * Whether the reported sign-in state can be shown as a fact.
 *
 * Codex answers `account/read` only while the harness bridge is running, so on a cold start
 * its `sourceSignedIn` is a placeholder. Rendering that placeholder as "Signed out" would
 * state something the host never verified, so the UI omits the claim instead.
 */
export function hasVerifiedSignIn(status: AccountBridgeStatus | undefined): boolean {
  return status?.sourceSignInChecked === true;
}

export type CodexUsageWindowKey = "primary" | "secondary";

export interface CodexUsageWindowView {
  key: CodexUsageWindowKey;
  /** Percentage of the window still available, derived from the reported used percent. */
  remainingPercent: number;
  /** ISO reset timestamp, only when the backend supplied one. */
  resetsAt?: string;
  /** Reported window length in minutes, when supplied. */
  windowDurationMins?: number;
}

/**
 * Both Codex windows in a stable order.
 *
 * A window is included only when the backend reported a used percentage for it, so an
 * unreported window disappears rather than rendering an empty or invented progress bar.
 */
export function resolveCodexUsageWindows(
  usage: AccountBridgeUsage | undefined,
): CodexUsageWindowView[] {
  if (!usage) return [];
  const windows: CodexUsageWindowView[] = [];
  const primary = buildWindowView("primary", usage.primaryUsedPercent, {
    resetsAt: usage.primaryResetsAt,
    windowDurationMins: usage.primaryWindowDurationMins,
  });
  if (primary) windows.push(primary);
  const secondary = buildWindowView("secondary", usage.secondaryUsedPercent, {
    resetsAt: usage.secondaryResetsAt,
    windowDurationMins: usage.secondaryWindowDurationMins,
  });
  if (secondary) windows.push(secondary);
  return windows;
}

function buildWindowView(
  key: CodexUsageWindowKey,
  usedPercent: number | undefined,
  extras: { resetsAt?: string; windowDurationMins?: number },
): CodexUsageWindowView | null {
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
    return null;
  }
  const clamped = Math.max(0, Math.min(100, usedPercent));
  return {
    key,
    // 与 Z.ai 额度卡一致：接口给的是已用百分比，卡片展示剩余。
    remainingPercent: Math.max(0, Math.min(100, 100 - clamped)),
    ...(extras.resetsAt ? { resetsAt: extras.resetsAt } : {}),
    ...(extras.windowDurationMins !== undefined && extras.windowDurationMins > 0
      ? { windowDurationMins: extras.windowDurationMins }
      : {}),
  };
}

interface CodexUsageWindowLabel {
  id: string;
  values?: Record<string, string>;
}

/**
 * Name a window from the length the backend reported.
 *
 * The two known Codex windows reuse the shipped Z.ai quota wording so the two surfaces read
 * identically; anything else is described by its reported length instead of being mislabelled
 * as a 5-hour or weekly window.
 */
export function resolveCodexUsageWindowLabel(
  windowDurationMins: number | undefined,
): CodexUsageWindowLabel {
  if (windowDurationMins === FIVE_HOUR_WINDOW_MINUTES) {
    return { id: "settings.usage.entitlementFiveHourUsage" };
  }
  if (windowDurationMins === WEEKLY_WINDOW_MINUTES) {
    return { id: "settings.usage.entitlementWeeklyUsage" };
  }
  if (windowDurationMins !== undefined && windowDurationMins > 0) {
    return {
      id: "settings.accounts.usage.windowDuration",
      values: { minutes: String(windowDurationMins) },
    };
  }
  return { id: "settings.accounts.usage.windowUnspecified" };
}

/**
 * Plan and account tokens for the status line.
 *
 * `planType` is a raw source-app identifier (`plus`, `pro`, `self_serve_business_usage_based`),
 * so it is only made presentable — never translated into a different claim.
 */
export function formatAccountPlanLabel(planType: string | undefined): string | undefined {
  const normalized = planType?.trim().replace(/[_-]+/g, " ");
  if (!normalized) return undefined;
  return normalized.replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * Why ordinary included usage is unavailable.
 *
 * The backend's `ordinaryUsageAllowed` flag is authoritative and its own contract warns that
 * clients must not infer recovery from percentages or reset times, so the blocked state is
 * always stated from this flag. The reason is only named when the backend supplied one of the
 * documented values.
 */
export function resolveUsageBlockedLabelId(blockedReason: string | undefined): string {
  switch (blockedReason) {
    case "rate_limit_reached":
      return "settings.accounts.usage.blocked.rateLimitReached";
    case "workspace_owner_credits_depleted":
    case "workspace_member_credits_depleted":
      return "settings.accounts.usage.blocked.workspaceCreditsDepleted";
    case "workspace_owner_usage_limit_reached":
    case "workspace_member_usage_limit_reached":
      return "settings.accounts.usage.blocked.workspaceUsageLimitReached";
    default:
      return "settings.accounts.usage.blocked.generic";
  }
}
