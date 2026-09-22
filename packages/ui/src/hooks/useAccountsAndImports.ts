/**
 * State for the Settings → Accounts & Imports section.
 *
 * Keeps two concerns deliberately separate:
 * - account connection (bridge status, connect/reconnect/disconnect)
 * - history import (candidate discovery)
 *
 * Nothing here ever holds credential material; every value originates from a sanitized
 * host response.
 */
import { useCallback, useEffect, useState } from "react";
import type {
  AccountBridgeSource,
  AccountBridgeStatus,
  ZCodeImportableSessionCandidate,
} from "@zcode/shared";
import type { CommandCodeStatus } from "@zcode/services";
import { useAccountsService } from "@/hooks/useAccountsService.js";
import { logger } from "@/logger.js";

export interface AccountsAndImportsState {
  readonly statuses: readonly AccountBridgeStatus[];
  readonly commandCode: CommandCodeStatus | null;
  readonly codexCandidates: readonly ZCodeImportableSessionCandidate[];
  readonly busy: AccountBridgeSource | "command-code" | "codex-history" | null;
  readonly loading: boolean;
  readonly lastError: string | null;
}

export function useAccountsAndImports() {
  const accountsService = useAccountsService();
  const [statuses, setStatuses] = useState<readonly AccountBridgeStatus[]>([]);
  const [commandCode, setCommandCode] = useState<CommandCodeStatus | null>(null);
  const [codexCandidates, setCodexCandidates] = useState<
    readonly ZCodeImportableSessionCandidate[]
  >([]);
  const [busy, setBusy] = useState<AccountsAndImportsState["busy"]>(null);
  const [loading, setLoading] = useState(true);
  const [lastError, setLastError] = useState<string | null>(null);

  const refreshStatuses = useCallback(async () => {
    try {
      setStatuses(await accountsService.readAllAccountStatuses());
    } catch (error) {
      logger.warn("[accounts] status refresh failed", error);
      setLastError("status_refresh_failed");
    }
  }, [accountsService]);

  const refreshCommandCode = useCallback(async () => {
    try {
      setCommandCode(await accountsService.readCommandCodeStatus());
    } catch (error) {
      logger.warn("[accounts] command code status failed", error);
    }
  }, [accountsService]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      await Promise.all([refreshStatuses(), refreshCommandCode()]);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshStatuses, refreshCommandCode]);

  const connect = useCallback(
    async (source: AccountBridgeSource) => {
      setBusy(source);
      setLastError(null);
      try {
        // The host opens any OAuth URL with the Mac's default browser; it is never sent here.
        const result = await accountsService.connectAccount(source);
        setStatuses((prev) =>
          prev.map((s) => (s.source === source ? result.status : s)),
        );
        if (result.error) setLastError(result.error);
      } catch (error) {
        logger.warn("[accounts] connect failed", error);
        setLastError("connect_failed");
      } finally {
        setBusy(null);
        void refreshStatuses();
      }
    },
    [accountsService, refreshStatuses],
  );

  const reconnectBridge = useCallback(
    async (source: AccountBridgeSource) => {
      setBusy(source);
      try {
        const status = await accountsService.reconnectAccountBridge(source);
        setStatuses((prev) => prev.map((s) => (s.source === source ? status : s)));
      } finally {
        setBusy(null);
      }
    },
    [accountsService],
  );

  const disconnect = useCallback(
    async (source: AccountBridgeSource) => {
      setBusy(source);
      try {
        // Harness-side only. Never logs the source application out.
        const status = await accountsService.disconnectAccount(source);
        setStatuses((prev) => prev.map((s) => (s.source === source ? status : s)));
      } finally {
        setBusy(null);
      }
    },
    [accountsService],
  );

  const scanCodexHistory = useCallback(
    async (limit = 10) => {
      setBusy("codex-history");
      try {
        setCodexCandidates(await accountsService.scanCodexHistory({ limit }));
      } catch (error) {
        logger.warn("[accounts] codex history scan failed", error);
        setLastError("codex_history_scan_failed");
      } finally {
        setBusy(null);
      }
    },
    [accountsService],
  );

  const statusFor = useCallback(
    (source: AccountBridgeSource) => statuses.find((s) => s.source === source),
    [statuses],
  );

  return {
    statuses,
    statusFor,
    commandCode,
    codexCandidates,
    busy,
    loading,
    lastError,
    connect,
    reconnectBridge,
    disconnect,
    scanCodexHistory,
    refreshStatuses,
    refreshCommandCode,
  };
}
