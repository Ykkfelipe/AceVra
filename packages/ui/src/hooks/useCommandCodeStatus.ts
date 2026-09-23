/**
 * Command Code CLI account status.
 *
 * Separate from `useAccountBridge` on purpose. Codex and Claude Code are execution accounts
 * this harness hands work to; Command Code's status is a reading from its own CLI and belongs
 * to the Command Code provider detail, so Model Settings keeps exactly one Command Code
 * presence instead of a provider plus a look-alike account card.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandCodeStatus } from "@zcode/services";
import { useAccountsService } from "@/hooks/useAccountsService.js";
import { logger } from "@/logger.js";

export function useCommandCodeStatus() {
  const accountsService = useAccountsService();
  const [status, setStatus] = useState<CommandCodeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const disposedRef = useRef(false);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await accountsService.readCommandCodeStatus();
      if (!disposedRef.current) setStatus(next);
    } catch (error) {
      logger.warn("[accounts] command code status failed", error);
    } finally {
      if (!disposedRef.current) setLoading(false);
    }
  }, [accountsService]);

  useEffect(() => {
    void load();
  }, [load]);

  return { status, loading, refresh: load };
}
