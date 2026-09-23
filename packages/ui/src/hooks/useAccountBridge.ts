/**
 * State for the Connected accounts screens (Codex / Claude Code).
 *
 * Keeps two concerns deliberately separate:
 * - account connection (bridge status, connect/reconnect/disconnect)
 * - history import (candidate discovery)
 *
 * Nothing here ever holds credential material; every value originates from a sanitized
 * host response. Command Code status is NOT part of this hook: it belongs to the Command
 * Code provider detail, because it is a CLI account reading rather than an execution account
 * this harness hands work to.
 */
import { useCallback, useEffect, useState } from "react";
import type {
  AccountBridgeSource,
  AccountBridgeStatus,
  ZCodeImportableSessionCandidate,
} from "@zcode/shared";
import { useAccountsService } from "@/hooks/useAccountsService.js";
import { logger } from "@/logger.js";

type AccountBridgeBusy = AccountBridgeSource | "codex-history";

/** Failures the renderer itself observes. Each maps to one localized line. */
interface AccountBridgeFailure {
  readonly code: AccountBridgeFailureCode;
  /**
   * Sanitized reason reported by the host (`codex_not_installed`, `login_timeout`, …).
   * The host already strips paths, URLs and opaque blobs, so this is display-safe; it is
   * kept separate from `code` because it is diagnostic, not a localized message.
   */
  readonly reason?: string;
}

type AccountBridgeFailureCode =
  | "status_refresh_failed"
  | "connect_failed"
  | "codex_history_scan_failed";

export function useAccountBridge() {
  const accountsService = useAccountsService();
  const [statuses, setStatuses] = useState<readonly AccountBridgeStatus[]>([]);
  const [codexCandidates, setCodexCandidates] = useState<
    readonly ZCodeImportableSessionCandidate[]
  >([]);
  const [busy, setBusy] = useState<AccountBridgeBusy | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * 状态读取自身的进行中标记。
   * loading 只覆盖首次水合；手动刷新必须也有独立反馈，否则按钮点了没有任何变化。
   */
  const [refreshing, setRefreshing] = useState(false);
  const [lastError, setLastError] = useState<AccountBridgeFailure | null>(null);

  const refreshStatuses = useCallback(async () => {
    setRefreshing(true);
    try {
      setStatuses(await accountsService.readAllAccountStatuses());
      // 只清除本次读取失败留下的提示；连接失败等原因不能被随后成功的状态读取掩盖。
      setLastError((current) => (current?.code === "status_refresh_failed" ? null : current));
    } catch (error) {
      logger.warn("[accounts] status refresh failed", error);
      setLastError({ code: "status_refresh_failed" });
    } finally {
      setRefreshing(false);
    }
  }, [accountsService]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      await refreshStatuses();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshStatuses]);

  const connect = useCallback(
    async (source: AccountBridgeSource) => {
      setBusy(source);
      setLastError(null);
      try {
        // The host opens any OAuth URL with the Mac's default browser; it is never sent here.
        const result = await accountsService.connectAccount(source);
        setStatuses((prev) => prev.map((s) => (s.source === source ? result.status : s)));
        if (result.error) {
          setLastError({
            code: "connect_failed",
            reason: result.error,
          });
        }
      } catch (error) {
        logger.warn("[accounts] connect failed", error);
        setLastError({ code: "connect_failed" });
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
        setLastError((current) =>
          current?.code === "codex_history_scan_failed" ? null : current,
        );
      } catch (error) {
        logger.warn("[accounts] codex history scan failed", error);
        setLastError({ code: "codex_history_scan_failed" });
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
    codexCandidates,
    busy,
    loading,
    refreshing,
    lastError,
    connect,
    reconnectBridge,
    disconnect,
    scanCodexHistory,
    refreshStatuses,
  };
}
