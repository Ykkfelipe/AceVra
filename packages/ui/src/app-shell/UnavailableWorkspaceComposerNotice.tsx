import { useCallback } from "react";
import { useWorkspaceTabRemoval } from "@/hooks/useWorkspaceTabRemoval.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTabReadOnly, type WorkspaceTabState } from "@/store/tabStore.js";
import { UnavailableWorkspaceNotice } from "@/app-shell/UnavailableWorkspaceNotice.js";

interface UnavailableWorkspaceComposerNoticeProps {
  workspacePath: string;
  workspaceIdentity?: string;
  onOpenFolder?: () => void;
}

/**
 * composer 位置的目录不可用提示（live wrapper）。
 *
 * tab store 是 availability 的唯一 owner：这里按 workspace key 读取当前 tab，
 * 只有它仍被标记为 unavailable-local-directory 时才渲染；移除后 tab 消失，提示随之卸载。
 */
export function UnavailableWorkspaceComposerNotice({
  workspacePath,
  workspaceIdentity,
  onOpenFolder,
}: UnavailableWorkspaceComposerNoticeProps) {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const tab = useTabStore((state) =>
    state.tabs.find(
      (candidate): candidate is WorkspaceTabState =>
        isWorkspaceTabReadOnly(candidate) &&
        (candidate.workspaceIdentity?.trim() || candidate.workspacePath) === workspaceKey,
    ),
  );
  if (!tab) {
    return null;
  }
  return <UnavailableWorkspaceComposerNoticeForTab tab={tab} onOpenFolder={onOpenFolder} />;
}

function UnavailableWorkspaceComposerNoticeForTab({
  tab,
  onOpenFolder,
}: {
  tab: WorkspaceTabState;
  onOpenFolder?: () => void;
}) {
  const removeWorkspace = useWorkspaceTabRemoval(tab, { source: "unavailable-notice" });
  const handleRemoveProject = useCallback(() => {
    void removeWorkspace();
  }, [removeWorkspace]);
  return (
    <UnavailableWorkspaceNotice
      workspacePath={tab.workspacePath}
      onOpenFolder={onOpenFolder}
      onRemoveProject={handleRemoveProject}
    />
  );
}
