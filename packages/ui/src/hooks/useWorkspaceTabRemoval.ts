import { useCallback } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useBaseWorkspaceServices, useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  hasRunningWorkspaceChat,
  scanWindowsReservedDeviceNameFiles,
} from "@/lib/workspaceRemovalSafety.js";
import { releaseWorkspaceRuntimeAfterProjectRemoval } from "@/lib/workspaceRuntimeRelease.js";
import { logger } from "@/logger.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { invalidateTaskQueryCacheByScopes } from "@/store/taskQueryCacheStore.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

interface WorkspaceTabRemovalOptions {
  /** 调用入口，仅用于日志区分（侧栏菜单 / 目录不可用提示）。 */
  source: "sidebar" | "unavailable-notice";
  /** 调用时读取最新任务列表；入口没有任务列表时缺省为空。 */
  getTaskItems?: () => Pick<ZCodeTaskMeta, "taskId">[];
}

/**
 * 移除项目（workspace tab）的唯一事务。
 *
 * 侧栏「移除」与目录不可用提示的「移除项目」共用本 hook，避免两条关闭路径
 * 在运行中确认、runtime 释放、缓存失效上出现分叉。顺序：
 * 运行中确认 → closeTab → 释放 runtime → 失效任务缓存 → 本地 Windows 保留名扫描。
 *
 * @returns 用户取消运行中确认时 resolve false，否则 true。
 */
export function useWorkspaceTabRemoval(
  tab: WorkspaceTabState,
  { source, getTaskItems }: WorkspaceTabRemovalOptions,
): () => Promise<boolean> {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const closeTab = useTabStore((state) => state.closeTab);
  const baseServices = useBaseWorkspaceServices();
  const zcodeTaskService = useWorkspaceServices(
    tab.workspacePath,
    tab.remoteSessionId,
    tab.workspaceIdentity,
    tab.remoteTarget,
  ).zcodeTaskService;
  const isRemoteWorkspace = Boolean(
    tab.remoteSessionId || tab.remoteTarget || tab.workspaceIdentity,
  );

  return useCallback(async () => {
    const workspaceKey = tab.workspaceIdentity?.trim() || tab.workspacePath;
    logger.debug("[useWorkspaceTabRemoval] 移除 workspace", { source, workspaceKey });

    if (
      hasRunningWorkspaceChat({
        // 在调用时读取最新运行态，避免渲染期快照落后于刚开始的运行。
        workspaceState: selectWorkspaceZCodeState(
          useZCodeSessionStore.getState(),
          tab.workspacePath,
          tab.workspaceIdentity,
        ),
        taskItems: getTaskItems?.() ?? [],
      })
    ) {
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "workspaceSidebar.removeRunningWorkspace.title" }),
        description: intl.formatMessage({
          id: "workspaceSidebar.removeRunningWorkspace.description",
        }),
        confirmLabel: intl.formatMessage({ id: "workspaceSidebar.removeRunningWorkspace.confirm" }),
        cancelLabel: intl.formatMessage({ id: "common.cancel" }),
        confirmVariant: "destructive",
      });
      if (!confirmed) {
        logger.debug("[useWorkspaceTabRemoval] 用户取消移除运行中 workspace", {
          source,
          workspaceKey,
        });
        return false;
      }
    }

    closeTab(tab.id);
    releaseWorkspaceRuntimeAfterProjectRemoval({
      tab: {
        workspacePath: tab.workspacePath,
        workspaceIdentity: tab.workspaceIdentity,
      },
      zcodeTaskService,
    });
    // 移除 workspace 只是移除入口和连接历史，不代表用户要隐藏历史任务：
    // 这里只失效缓存，保留 sqlite 任务索引原状态，避免重连同一 SSH workspace 后任务像“丢了”。
    invalidateTaskQueryCacheByScopes([
      {
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      },
    ]);

    if (!isRemoteWorkspace) {
      void scanWindowsReservedDeviceNameFiles(baseServices.fileService, tab.workspacePath)
        .then((result) => {
          if (result.findings.length === 0) {
            return;
          }
          const firstFinding = result.findings[0] ?? tab.workspacePath;
          toast(
            intl.formatMessage(
              { id: "workspaceSidebar.windowsReservedNameRisk" },
              { count: result.findings.length, path: firstFinding },
            ),
            { durationMs: 8_000, variant: "warning" },
          );
        })
        .catch((error: unknown) => {
          // Windows 保留设备名扫描只是移除后的兼容风险提示，失败不能影响 workspace 生命周期释放。
          logger.debug("[useWorkspaceTabRemoval] Windows 保留名风险扫描失败", {
            workspaceKey,
            error,
          });
        });
    }
    return true;
  }, [
    baseServices.fileService,
    closeTab,
    confirmDialog,
    getTaskItems,
    intl,
    isRemoteWorkspace,
    source,
    tab.id,
    tab.workspaceIdentity,
    tab.workspacePath,
    zcodeTaskService,
  ]);
}
