import type { AccountBridgeSource, AccountBridgeStatus } from "@zcode/shared";

export const ACCOUNT_STATUS_REQUEST_TIMEOUT_MS = 50_000;

/** Convert both channel rejection and a stalled host RPC into a terminal per-source state. */
export async function readAccountStatusWithDeadline(
  source: AccountBridgeSource,
  request: () => Promise<AccountBridgeStatus>,
  timeoutMs = ACCOUNT_STATUS_REQUEST_TIMEOUT_MS,
): Promise<AccountBridgeStatus> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("account_status_timeout")), timeoutMs);
      }),
    ]);
  } catch {
    return {
      source,
      // A failed status transport cannot prove that a program is absent. Keep retry enabled.
      installed: true,
      state: "error",
      sourceSignedIn: false,
      sourceSignInChecked: false,
      checkedAt: new Date().toISOString(),
      error: "status_read_failed",
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
