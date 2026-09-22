// browser-use 桥的 artifact 插桩：agent 截图成功时把结果字节注册成任务 artifact。
//
// 这是对 browserControlExecutor 的纯装饰：工具结果原样返回给 agent（模型看到的
// base64 image block 不变，agent loop 零改动）；注册是旁路副作用，失败只降级为
// warn 日志——没有注册成功，会话里就不会出现 artifact 卡片，也就不会宣称交付。
import type { TaskArtifactRegistry } from "./taskArtifactRegistry.js";
import { isInlinePreviewMimeType } from "@zcode/shared";

interface ExecutorLike {
  execute(input: {
    requestId: string;
    sessionId: string;
    turnId?: string;
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
    command: unknown;
  }): Promise<{ ok: boolean; image?: { base64: string; mimeType: string }; [k: string]: unknown }>;
}

function safeFileName(now: number, mimeType: string): string {
  const extension = isInlinePreviewMimeType(mimeType)
    ? `.${mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "png"}`
    : ".bin";
  const stamp = new Date(now).toISOString().replace(/[-:]/gu, "").replace(/\..+$/u, "");
  return `screenshot-${stamp}${extension}`;
}

export function instrumentBrowserExecutorForArtifacts<T extends ExecutorLike>(options: {
  executor: T;
  registry: TaskArtifactRegistry;
}): T {
  const { executor, registry } = options;
  const wrapped: ExecutorLike = {
    async execute(input) {
      const result = await executor.execute(input);
      if (!result.ok || !result.image?.base64) return result;
      try {
        const bytes = Uint8Array.from(Buffer.from(result.image.base64, "base64"));
        await registry.registerTaskArtifact({
          taskId: input.sessionId,
          scope: {
            workspacePath: input.workspacePath,
            ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
          },
          origin: "browser-use",
          fileName: safeFileName(Date.now(), result.image.mimeType),
          mimeType: result.image.mimeType,
          bytes,
          ...(input.turnId ? { turnId: input.turnId } : {}),
        });
      } catch {
        // 注册失败绝不影响工具结果，也绝不宣称交付（无 artifact 生成即无卡片）。
      }
      return result;
    },
  };
  return wrapped as T;
}
