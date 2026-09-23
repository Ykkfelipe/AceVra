/**
 * Pure wire→contract mapping for the account bridge.
 *
 * Kept out of `accountBridgeService` for two reasons: the mapping can be unit tested without
 * spawning a local client, and the service file stays under the repository file-length cap.
 *
 * SECURITY: every mapper here reads only the fields named in the local source application's
 * documented status surface. None of these inputs contain token material, and the only
 * backend strings that may cross the wire are the allowlisted machine enums below.
 */
import type { AccountBridgeIdentity, AccountBridgeUsage } from "@zcode/shared";

/**
 * Codex `RateLimitReachedType` values. An unrecognised value is dropped rather than
 * forwarded, so an unexpected backend string can never reach the renderer.
 */
const CODEX_BLOCKED_REASONS = new Set([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Percentages are clamped defensively; the backend contract is 0-100 integers. */
function asPercent(value: unknown): number | undefined {
  const parsed = asFiniteNumber(value);
  return parsed === undefined ? undefined : Math.max(0, Math.min(100, parsed));
}

/** Codex reports reset times as Unix seconds; ISO keeps them meaningful across the relay. */
function toIsoFromUnixSeconds(value: unknown): string | undefined {
  const seconds = asFiniteNumber(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** `account/read` → sanitized identity. Only `email` and `planType` are documented fields. */
export function mapCodexIdentity(account: unknown): AccountBridgeIdentity | undefined {
  const record = asRecord(account);
  if (!record) return undefined;
  const email = asString(record.email);
  const planType = asString(record.planType);
  if (!email && !planType) return undefined;
  return { ...(email ? { email } : {}), ...(planType ? { planType } : {}) };
}

/**
 * `claude auth status --json` → sanitized identity.
 *
 * The CLI reports `authMethod`, `apiProvider`, `email` and `subscriptionType`. The
 * subscription tier is Claude's plan identifier, so it maps onto the shared `planType`
 * slot used by Codex.
 */
export function mapClaudeAuthStatusIdentity(parsed: unknown): AccountBridgeIdentity | undefined {
  const record = asRecord(parsed);
  if (!record) return undefined;
  const email = asString(record.email);
  const planType = asString(record.subscriptionType);
  const authMethod = asString(record.authMethod);
  const apiProvider = asString(record.apiProvider);
  if (!email && !planType && !authMethod && !apiProvider) return undefined;
  return {
    ...(email ? { email } : {}),
    ...(planType ? { planType } : {}),
    ...(authMethod ? { authMethod } : {}),
    ...(apiProvider ? { apiProvider } : {}),
  };
}

/**
 * `account/rateLimits/read` → sanitized usage.
 *
 * `rateLimits` is the documented backward-compatible single-bucket view; when it is absent
 * the first entry of `rateLimitsByLimitId` is used instead. Every window field is copied
 * only when the backend actually supplied it, so the UI can tell "not reported" from "zero".
 */
export function mapCodexAccountUsage(response: unknown): AccountBridgeUsage | undefined {
  const record = asRecord(response);
  if (!record) return undefined;

  const usage: {
    -readonly [K in keyof AccountBridgeUsage]: AccountBridgeUsage[K];
  } = {};

  if (typeof record.ordinaryUsageAllowed === "boolean") {
    usage.ordinaryUsageAllowed = record.ordinaryUsageAllowed;
  }

  const snapshot = resolveRateLimitSnapshot(record);
  if (snapshot) {
    const primary = asRecord(snapshot.primary);
    const secondary = asRecord(snapshot.secondary);
    if (primary) {
      const usedPercent = asPercent(primary.usedPercent);
      const resetsAt = toIsoFromUnixSeconds(primary.resetsAt);
      const windowDurationMins = asFiniteNumber(primary.windowDurationMins);
      if (usedPercent !== undefined) usage.primaryUsedPercent = usedPercent;
      if (resetsAt) usage.primaryResetsAt = resetsAt;
      if (windowDurationMins !== undefined && windowDurationMins > 0) {
        usage.primaryWindowDurationMins = windowDurationMins;
      }
    }
    if (secondary) {
      const usedPercent = asPercent(secondary.usedPercent);
      const resetsAt = toIsoFromUnixSeconds(secondary.resetsAt);
      const windowDurationMins = asFiniteNumber(secondary.windowDurationMins);
      if (usedPercent !== undefined) usage.secondaryUsedPercent = usedPercent;
      if (resetsAt) usage.secondaryResetsAt = resetsAt;
      if (windowDurationMins !== undefined && windowDurationMins > 0) {
        usage.secondaryWindowDurationMins = windowDurationMins;
      }
    }
    const reachedType = asString(snapshot.rateLimitReachedType);
    if (reachedType && CODEX_BLOCKED_REASONS.has(reachedType)) {
      usage.blockedReason = reachedType;
    }
  }

  return Object.keys(usage).length > 0 ? usage : undefined;
}

function resolveRateLimitSnapshot(
  response: Record<string, unknown>,
): Record<string, unknown> | null {
  const direct = asRecord(response.rateLimits);
  if (direct) return direct;
  const byLimitId = asRecord(response.rateLimitsByLimitId);
  if (!byLimitId) return null;
  for (const value of Object.values(byLimitId)) {
    const snapshot = asRecord(value);
    if (snapshot) return snapshot;
  }
  return null;
}
