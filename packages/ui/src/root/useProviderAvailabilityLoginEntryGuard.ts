import { useCallback, useEffect, useRef, useState } from "react";
import type { IAceVraSetupService, ModelSelectionView } from "@zcode/services";
import { resolveProviderAvailabilityState } from "@/lib/modelProviderAvailability.js";
import { logger } from "@/logger.js";

interface ProviderAvailabilityLoginEntryGuardResult {
  hasUsableProvider: boolean;
  providerCount: number;
  shouldOpenLoginEntry: boolean;
}

export function useProviderAvailabilityLoginEntryGuard({
  enabled = true,
  setupService,
  isRestoringOAuthSession,
  modelSelectionView,
  modelSelectionError,
  refreshProviderState,
  readModelSelectionView,
  setLoginEntryOpen,
}: {
  enabled?: boolean;
  setupService?: IAceVraSetupService;
  isRestoringOAuthSession: boolean;
  modelSelectionView: ModelSelectionView | null;
  modelSelectionError?: Error;
  refreshProviderState: () => Promise<void>;
  readModelSelectionView: () => Promise<ModelSelectionView>;
  setLoginEntryOpen: (open: boolean) => void;
}) {
  const [startupCheckCompleted, setStartupCheckCompleted] = useState(!enabled);
  const startupCheckCompletedRef = useRef(false);
  const providerAvailabilityHydrated = modelSelectionView !== null;

  const syncLoginEntryWithProviderAvailability = useCallback(
    async (options: { forceRefresh?: boolean; reason: string }) => {
      if (!enabled) {
        return {
          hasUsableProvider: true,
          providerCount: modelSelectionView?.providers.length ?? 0,
          shouldOpenLoginEntry: false,
        } satisfies ProviderAvailabilityLoginEntryGuardResult;
      }

      if (options.forceRefresh) {
        await refreshProviderState();
      }

      const refreshedView = options.forceRefresh
        ? await readModelSelectionView()
        : modelSelectionView;
      const availability = resolveProviderAvailabilityState({ modelSelectionView: refreshedView });
      const { hasUsableProvider, providerCount } = availability;
      const setup = await setupService?.getView();
      const shouldOpenLoginEntry = setup ? !setup.shellAllowed : !hasUsableProvider;

      // 旧守卫把 family 当产品初始化条件，误挡普通 Provider；只消费 Host readiness。
      // 启动检查、API Key 设置回流等入口统一走这里，避免各处复制判断后语义分叉。
      logger.info("[Root] provider 可用性登录入口守卫完成检查", {
        reason: options.reason,
        source: availability.source,
        providerCount,
        hasUsableProvider,
        setupStatus: setup?.status,
        shouldOpenLoginEntry,
      });
      setLoginEntryOpen(shouldOpenLoginEntry);
      return {
        hasUsableProvider,
        providerCount,
        shouldOpenLoginEntry,
      } satisfies ProviderAvailabilityLoginEntryGuardResult;
    },
    [
      enabled,
      setupService,
      modelSelectionView,
      refreshProviderState,
      readModelSelectionView,
      setLoginEntryOpen,
    ],
  );

  useEffect(() => {
    if (!enabled) {
      startupCheckCompletedRef.current = true;
      setStartupCheckCompleted(true);
      return;
    }

    if (modelSelectionError) {
      // 首次读取失败不能伪装成“没有 Provider”，也不能让启动门禁永久停在 loading。
      logger.error("[Root] provider 可用性读取失败，结束启动门禁等待", modelSelectionError);
      startupCheckCompletedRef.current = true;
      setStartupCheckCompleted(true);
      return;
    }

    if (
      startupCheckCompletedRef.current ||
      isRestoringOAuthSession ||
      !providerAvailabilityHydrated
    ) {
      return;
    }

    startupCheckCompletedRef.current = true;
    void syncLoginEntryWithProviderAvailability({
      reason: "startup",
    })
      .catch(() => {
        // 读取失败必须保留明确 setup 入口，不能默许进入未初始化 shell。
        logger.error("[Root] AceVra setup readiness could not be read");
        setLoginEntryOpen(true);
      })
      .finally(() => {
        setStartupCheckCompleted(true);
      });
  }, [
    enabled,
    isRestoringOAuthSession,
    modelSelectionError,
    providerAvailabilityHydrated,
    syncLoginEntryWithProviderAvailability,
    setLoginEntryOpen,
  ]);

  return {
    startupCheckCompleted,
    syncLoginEntryWithProviderAvailability,
  };
}
