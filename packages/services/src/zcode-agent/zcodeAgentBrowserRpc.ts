// browser-use 反向请求（agent → host）的处理器：interaction/browserList 与 interaction/browserExecute。
//
// 修复依据：executor 同步抛错（如 artifact 包装器曾丢失 list）会直接逃逸进 stdio 分发器，
// 被误判为 protocol_parse_error 并关闭整个 agent 连接。这里统一经 Promise 边界调用 executor，
// 使同步抛错与异步 reject 归一为同一结构化错误回复，且绝不同步抛出到调用方。
import {
  resolveWorkspaceKey,
  zcodeBrowserExecuteParamsSchema,
  zcodeBrowserListParamsSchema,
  type ZCodeProtocolRequestId,
} from "@zcode/shared";
import type { BrowserAmbientContextExecutor } from "./zcodeAgentBrowserAmbientContext.js";

interface BrowserRpcResponder {
  respond(id: ZCodeProtocolRequestId, result: unknown): Promise<void>;
  respondError(
    id: ZCodeProtocolRequestId,
    error: { code: number; message: string; data?: unknown },
  ): Promise<void>;
}

interface BrowserRpcContext {
  client: BrowserRpcResponder;
  executor: BrowserAmbientContextExecutor | undefined;
  requestId: ZCodeProtocolRequestId;
  params: unknown;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * browser-use discovery：backend 在线状态与 plugin/skill 是否暴露是两层状态。
 * executor 缺省时返回空列表，禁止 facade 伪造 IAB available。
 */
export function handleBrowserListRequest(context: BrowserRpcContext): void {
  const { client, executor, requestId } = context;
  const parsed = zcodeBrowserListParamsSchema.safeParse(context.params);
  if (!parsed.success) {
    void client.respondError(requestId, {
      code: -32602,
      message: "Invalid interaction/browserList params",
      data: parsed.error.flatten(),
    });
    return;
  }
  if (!executor) {
    void client.respond(requestId, { browsers: [] });
    return;
  }
  void Promise.resolve()
    .then(() => executor.list(parsed.data))
    .then((browsers) => client.respond(requestId, { browsers }))
    .catch((error: unknown) => {
      void client.respondError(requestId, { code: -32603, message: errorMessage(error) });
    });
}

/**
 * browser-use：agent 的 agent.browsers.* 经 interaction/browserExecute 到达这里。
 * 纯 RPC 中继——转发给 main（WebContentsView+CDP）执行后 respondResult，不 emitSessionEvent、
 * 不进 pending map（区别于 permission 的 UI 阻塞语义）。executor 缺省则 backend_unavailable。
 */
export function handleBrowserExecuteRequest(
  context: BrowserRpcContext & { workspace: { workspacePath: string; workspaceIdentity?: string } },
): void {
  const { client, executor, requestId, workspace } = context;
  const parsed = zcodeBrowserExecuteParamsSchema.safeParse(context.params);
  if (!parsed.success) {
    void client.respondError(requestId, {
      code: -32602,
      message: "Invalid interaction/browserExecute params",
      data: parsed.error.flatten(),
    });
    return;
  }
  if (!executor) {
    void client.respond(requestId, {
      ok: false,
      error: { code: "backend_unavailable", message: "browser control not available" },
      elapsedMs: 0,
    });
    return;
  }
  const workspaceIdentity = parsed.data.workspaceIdentity ?? workspace.workspaceIdentity;
  void Promise.resolve()
    .then(() =>
      executor.execute({
        requestId: parsed.data.requestId,
        ...(parsed.data.browserId ? { browserId: parsed.data.browserId } : {}),
        ...(parsed.data.browserGeneration !== undefined
          ? { browserGeneration: parsed.data.browserGeneration }
          : {}),
        sessionId: parsed.data.sessionId,
        ...(parsed.data.turnId ? { turnId: parsed.data.turnId } : {}),
        workspaceKey: parsed.data.workspaceKey ?? resolveWorkspaceKey(workspace),
        workspacePath: parsed.data.workspacePath ?? workspace.workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(parsed.data.remoteSessionId ? { remoteSessionId: parsed.data.remoteSessionId } : {}),
        clientMode: parsed.data.clientMode ?? "desktop-continuous",
        sessionContext: parsed.data.sessionContext ?? "live",
        command: parsed.data.command,
        ...(parsed.data.captureIntent ? { captureIntent: parsed.data.captureIntent } : {}),
      }),
    )
    .then((result) => client.respond(requestId, result))
    .catch((error: unknown) => {
      void client.respond(requestId, {
        ok: false,
        error: { code: "execution_error", message: errorMessage(error) },
        elapsedMs: 0,
      });
    });
}
