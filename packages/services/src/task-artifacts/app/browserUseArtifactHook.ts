// browser-use 桥的 artifact 插桩：agent 截图成功时把结果字节注册成任务 artifact。
//
// 这是对 browserControlExecutor 的纯装饰：工具结果原样返回给 agent（模型看到的
// base64 image block 不变，agent loop 零改动）；注册是旁路副作用，失败只降级为
// warn 日志——没有注册成功，会话里就不会出现 artifact 卡片，也就不会宣称交付。
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  TaskArtifactRegistrationError,
  type TaskArtifactRegistry,
} from "./taskArtifactRegistry.js";
import { isInlinePreviewMimeType } from "@zcode/shared";

const logger = createServiceLogger("task-artifacts");

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
  // 修复依据：旧实现返回只含 execute 的新对象并用 `as T` 冒充完整接口，host 的
  // interaction/browserList 调 executor.list 时同步抛 TypeError，经 stdio 分发路径
  // 被误判为 protocol_parse_error 并关掉整个 agent 连接。这里改为 Proxy 装饰：
  // 只拦截 execute，其余成员（list 及未来新增方法）原样委托给原 executor。
  const instrumentedExecute: ExecutorLike["execute"] = async (input) => {
    const result = await executor.execute(input);
    if (!result.ok || !result.image || (!result.image.base64 && !result.image.hostPath))
      return result;
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
    } catch (error) {
      // 注册失败绝不影响工具结果，也绝不宣称交付（无 artifact 生成即无卡片）。
      // 修复依据：旧实现静默吞掉失败，与文件头"降级为 warn 日志"的约定不符，导致无卡片时无从定位。
      // 只记录原因码与任务关联，不记录路径或字节。
      logger.warn(undefined, "browser-use screenshot artifact registration failed", {
        taskId: input.sessionId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        reason:
          error instanceof TaskArtifactRegistrationError
            ? error.reasonCode
            : error instanceof Error
              ? error.name
              : "unknown",
      });
      return {
        ...result,
        ...(returnedImage ? { image: returnedImage } : { image: undefined }),
        artifactDelivery: { status: "registration_failed" },
      };
    }
  };
  return new Proxy(executor, {
    get(target, property) {
      if (property === "execute") return instrumentedExecute;
      const value: unknown = Reflect.get(target, property, target);
      // 绑定原 executor 作为 this，保证委托方法的参数/结果/异常与未包装时等价。
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
