import { useCallback, useEffect, useState } from "react";
import type { ExecutionTarget } from "@zcode/shared";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";

const REFRESH_MS = 30_000;

/**
 * The user's computers as seen by the desktop account bridge (this computer + connected ones),
 * used to name the computer on a work card. `null` until the first read resolves; reading is
 * status-only and never starts work.
 */
export function useExecutionTargets(enabled = true) {
  const account = useOptionalPlatform()?.account;
  const [targets, setTargets] = useState<ExecutionTarget[] | null>(null);
  const refresh = useCallback(async () => {
    if (!account) return;
    const next = await account.listTargets().catch(() => null);
    if (next) setTargets(next);
  }, [account]);
  useEffect(() => {
    if (!account || !enabled) return;
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [account, enabled, refresh]);
  return { available: Boolean(account), targets, refresh };
}
