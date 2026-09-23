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
  }): Promise<{
    ok: boolean;
    image?: { base64?: string; hostPath?: string; fileName?: string; mimeType: string };
    [k: string]: unknown;
  }>;
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
      if (!result.ok || !result.image || (!result.image.base64 && !result.image.hostPath)) return result;
      const returnedImage = result.image.base64
        ? { base64: result.image.base64, mimeType: result.image.mimeType }
        : undefined;
      try {
        // Electron currently returns bytes. If a future executor materializes a
        // file too, bytes are the deterministic preferred source: never register
        // both forms and rely on the registry for retry/replay idempotency.
        const bytes = result.image.base64
          ? Uint8Array.from(Buffer.from(result.image.base64, "base64"))
          : undefined;
        await registry.registerTaskArtifact({
          taskId: input.sessionId,
          scope: {
            workspacePath: input.workspacePath,
            ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
          },
          origin: "browser-use",
          fileName: result.image.fileName ?? safeFileName(Date.now(), result.image.mimeType),
          mimeType: result.image.mimeType,
          ...(bytes ? { bytes } : { hostPath: result.image.hostPath! }),
          ...(input.turnId ? { turnId: input.turnId } : {}),
        });
        // A saved-file source is host-private. Do not let it reach the agent,
        // renderer, relay, or model; report only whether the user-deliverable
        // artifact was actually registered.
        return {
          ...result,
          ...(returnedImage ? { image: returnedImage } : { image: undefined }),
          artifactDelivery: { status: "delivered" },
        };
      } catch {
        // 注册失败绝不影响工具结果，也绝不宣称交付（无 artifact 生成即无卡片）。
        return {
          ...result,
          ...(returnedImage ? { image: returnedImage } : { image: undefined }),
          artifactDelivery: { status: "registration_failed" },
        };
      }
    },
  };
  return wrapped as T;
}
