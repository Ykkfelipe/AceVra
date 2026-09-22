// Task artifact 卡片：图片内联预览 / 其他文件下载卡。
// 字节经 task-artifacts 通道按需分块读取（object URL）；宿主路径不进入 renderer。
import { memo, useCallback, useEffect, useState } from "react";
import { DownloadIcon, FileIcon } from "lucide-react";
import type { TaskArtifactDescriptor } from "@zcode/shared";
import { isInlinePreviewMimeType } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useTaskArtifacts } from "@/hooks/useTaskArtifacts.js";

function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 单卡片：图片内联预览（移动端 max-w-full，不横向溢出）；其他类型下载卡。 */
export const TaskArtifactCard = memo(function TaskArtifactCard({
  artifact,
  workspacePath,
  workspaceIdentity,
  layout = "trailing",
}: {
  artifact: TaskArtifactDescriptor;
  workspacePath: string;
  workspaceIdentity?: string;
  /** trailing：任务尾部独立卡片；row：对话行内（更紧凑）。 */
  layout?: "trailing" | "row";
}) {
  const { loadObjectUrl } = useTaskArtifacts({
    sessionId: artifact.taskId,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  });
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const inline = isInlinePreviewMimeType(artifact.mimeType);

  const load = useCallback(() => {
    void loadObjectUrl(artifact).then((url) => {
      if (url) setObjectUrl(url);
      else setFailed(true);
    });
  }, [artifact, loadObjectUrl]);

  useEffect(() => {
    if (inline && artifact.state === "available") load();
  }, [inline, artifact.state, load]);

  return (
    <div
      data-testid={`task-artifact-${artifact.artifactId}`}
      data-artifact-state={artifact.state}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-lg border border-card-border bg-card",
        layout === "trailing" ? "px-3 py-2" : "px-2 py-1.5",
      )}
    >
      {inline && objectUrl ? (
        // max-w-full + h-auto：任意尺寸图片都收缩到容器宽度内，移动端无横向溢出。
        <img
          src={objectUrl}
          alt={artifact.fileName}
          className="h-auto max-h-96 w-auto max-w-full self-stretch rounded-md object-contain"
          loading="lazy"
        />
      ) : (
        <FileIcon className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui-base text-foreground">{artifact.fileName}</p>
        <p className="text-ui-sm text-foreground-subtle">
          {inline && !objectUrl && !failed
            ? "…"
            : failed || artifact.state === "missing"
              ? undefined
              : formatByteSize(artifact.byteSize)}
          {failed || artifact.state === "missing" ? "unavailable" : ""}
        </p>
      </div>
      {artifact.state === "available" ? (
        <a
          href={objectUrl ?? undefined}
          download={artifact.fileName}
          onClick={(event) => {
            if (!objectUrl) {
              event.preventDefault();
              load();
            }
          }}
          aria-label={`Download ${artifact.fileName}`}
          className="shrink-0 rounded-md p-1.5 text-foreground-subtle hover:bg-hover hover:text-foreground"
        >
          <DownloadIcon className="size-4" aria-hidden="true" />
        </a>
      ) : null}
    </div>
  );
});

/**
 * 任务尾部 artifact 组（zcode 任务 / 无 turn 锚点的 artifact）。
 * `presentArtifactIds`：已作为真实 artifact 行内联渲染的 id，在这里跳过避免重复。
 */
export function SessionTaskArtifactSection(params: {
  sessionId?: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  enabled?: boolean;
  presentArtifactIds?: ReadonlySet<string>;
}) {
  const { artifacts } = useTaskArtifacts({
    sessionId: params.sessionId,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
  });
  if (!params.enabled || !params.sessionId) return null;
  const visible = params.presentArtifactIds
    ? artifacts.filter((artifact) => !params.presentArtifactIds!.has(artifact.artifactId))
    : artifacts;
  if (visible.length === 0) return null;
  return (
    <div
      data-testid="task-artifact-section"
      className="flex flex-col gap-1.5 px-4 pb-2"
    >
      {visible.map((artifact) => (
        <TaskArtifactCard
          key={artifact.artifactId}
          artifact={artifact}
          workspacePath={params.workspacePath}
          {...(params.workspaceIdentity
            ? { workspaceIdentity: params.workspaceIdentity }
            : {})}
        />
      ))}
    </div>
  );
}
