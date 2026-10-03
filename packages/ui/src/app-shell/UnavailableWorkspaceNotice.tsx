import { memo } from "react";
import { FolderOpen, FolderX, XIcon } from "lucide-react";
import {
  TID_UNAVAILABLE_WORKSPACE_NOTICE,
  TID_UNAVAILABLE_WORKSPACE_NOTICE_OPEN_FOLDER,
  TID_UNAVAILABLE_WORKSPACE_NOTICE_REMOVE,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface UnavailableWorkspaceNoticeProps {
  workspacePath: string;
  /** 缺省时不显示「打开文件夹」（例如 Web 远控不允许打开新工作区）。 */
  onOpenFolder?: () => void;
  onRemoveProject?: () => void;
}

/**
 * 本地项目目录不可用时，替代 composer 显示在会话底部 dock 的说明与操作。
 *
 * 纯展示：只接收路径与显式动作，不读取 store/service；
 * 由 UnavailableWorkspaceComposerNotice 解析 tab 与移除事务后注入。
 */
export const UnavailableWorkspaceNotice = memo(function UnavailableWorkspaceNotice({
  workspacePath,
  onOpenFolder,
  onRemoveProject,
}: UnavailableWorkspaceNoticeProps) {
  const { intl } = useZCodeIntl();
  const hasActions = Boolean(onOpenFolder || onRemoveProject);
  // 根因：目录不可用时 composer 被整块移除且没有任何替代说明，用户误以为输入框被挪走。
  // 这里沿用同一 bottom dock 中其他提示条的 surface/border，只在图标上使用 warning 语义色。
  return (
    <div
      role="status"
      data-testid={TID_UNAVAILABLE_WORKSPACE_NOTICE}
      className="flex w-full shrink-0 flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-ui-base text-foreground"
    >
      <div className="flex min-w-0 items-start gap-2">
        <FolderX aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="font-medium">
            {intl.formatMessage({ id: "workspace.unavailableNotice.title" })}
          </p>
          <p className="font-mono text-ui-sm break-all text-foreground-subtle">{workspacePath}</p>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "workspace.unavailableNotice.description" })}
          </p>
        </div>
      </div>
      {hasActions ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {onRemoveProject ? (
            <Button
              type="button"
              variant="ghost"
              className="rounded-lg"
              data-testid={TID_UNAVAILABLE_WORKSPACE_NOTICE_REMOVE}
              onClick={onRemoveProject}
            >
              <XIcon data-icon="inline-start" aria-hidden="true" />
              {intl.formatMessage({ id: "workspace.unavailableNotice.removeProject" })}
            </Button>
          ) : null}
          {onOpenFolder ? (
            <Button
              type="button"
              variant="outline"
              className="rounded-lg"
              data-testid={TID_UNAVAILABLE_WORKSPACE_NOTICE_OPEN_FOLDER}
              onClick={onOpenFolder}
            >
              <FolderOpen data-icon="inline-start" aria-hidden="true" />
              {intl.formatMessage({ id: "workspace.openFolder" })}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
