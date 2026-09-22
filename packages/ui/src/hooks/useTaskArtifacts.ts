// Task artifacts 清单与字节读取（renderer）。
//
// 经 task-artifacts 通道只能拿到已注册 artifact 的脱敏描述符与分块字节；
// 图片用 object URL 内联预览（max-w-full，移动端不横向溢出）。
import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskArtifactDescriptor } from "@zcode/shared";
import type { ITaskArtifactDeliveryService } from "@zcode/services";
import { useResolvedServiceAccessor } from "@/hooks/useWorkspaceServices.js";

export interface UseTaskArtifactsResult {
  artifacts: readonly TaskArtifactDescriptor[];
  loading: boolean;
  /** 分块读取完整字节并生成 object URL；失败（含 backing missing）返回 null。 */
  loadObjectUrl: (artifact: TaskArtifactDescriptor) => Promise<string | null>;
}

export function useTaskArtifacts(params: {
  sessionId?: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
}): UseTaskArtifactsResult {
  const accessor = useResolvedServiceAccessor(undefined, undefined, undefined);
  const service = accessor.taskArtifactService as ITaskArtifactDeliveryService | undefined;
  const { sessionId, workspacePath, workspaceIdentity } = params;
  const [artifacts, setArtifacts] = useState<readonly TaskArtifactDescriptor[]>([]);
  const [loading, setLoading] = useState(false);
  const urlCacheRef = useRef(new Map<string, string>());

  useEffect(() => {
    if (!service || !sessionId) {
      setArtifacts([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void service
      .listTaskArtifacts({
        taskId: sessionId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      })
      .then((result) => {
        if (!cancelled) setArtifacts(result.artifacts);
      })
      .catch(() => {
        if (!cancelled) setArtifacts([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [service, sessionId, workspacePath, workspaceIdentity]);

  // object URL 生命周期跟随 hook：卸载统一 revoke，避免泄漏。
  useEffect(() => {
    const cache = urlCacheRef.current;
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    };
  }, []);

  const loadObjectUrl = useCallback(
    async (artifact: TaskArtifactDescriptor): Promise<string | null> => {
      if (!service) return null;
      const cached = urlCacheRef.current.get(artifact.artifactId);
      if (cached) return cached;
      if (artifact.state !== "available") return null;
      try {
        const chunks: Uint8Array[] = [];
        let offset = 0;
        for (;;) {
          const chunk = await service.readTaskArtifact({
            taskId: artifact.taskId,
            artifactId: artifact.artifactId,
            offset,
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
          });
          // base64 → 字节：renderer（Electron/浏览器均为 Chromium）恒有 atob。
          const binary = atob(chunk.dataBase64);
          const part = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) part[i] = binary.charCodeAt(i);
          chunks.push(part);
          if (chunk.nextOffset === null) break;
          offset = chunk.nextOffset;
        }
        const total = chunks.reduce((sum, part) => sum + part.byteLength, 0);
        const merged = new Uint8Array(total);
        let cursor = 0;
        for (const part of chunks) {
          merged.set(part, cursor);
          cursor += part.byteLength;
        }
        const url = URL.createObjectURL(new Blob([merged], { type: artifact.mimeType }));
        urlCacheRef.current.set(artifact.artifactId, url);
        return url;
      } catch {
        return null;
      }
    },
    [service, workspacePath, workspaceIdentity],
  );

  return { artifacts, loading, loadObjectUrl };
}
