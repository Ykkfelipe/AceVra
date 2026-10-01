import { useCallback, useEffect, useState } from "react";
import type { ExecutionTarget } from "@zcode/shared";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useExecutionTargetStore } from "@/store/executionTargetStore.js";

const REFRESH_MS = 30_000;

/**
 * Real execution targets from the desktop account bridge (this device + paired nodes).
 * `null` until the first read resolves; reading is status-only and never starts work.
 */
export function useExecutionTargets(enabled = true) {
  const account = useOptionalPlatform()?.account;
  const [targets, setTargets] = useState<ExecutionTarget[] | null>(null);
  const refresh = useCallback(async () => {
    if (!account) return;
    const next = await account.listTargets().catch(() => null);
    if (!next) return;
    setTargets(next);
    // 发送时据此把选择翻译成 executionTarget（名称 / 是否本机），见 resolveSubmissionExecutionTarget。
    useExecutionTargetStore.getState().rememberTargets(next);
  }, [account]);
  useEffect(() => {
    if (!account || !enabled) return;
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [account, enabled, refresh]);
  return { available: Boolean(account), targets, refresh };
}
