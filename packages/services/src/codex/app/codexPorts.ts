// Codex 执行后端的依赖端口（app 层）。
// 通过结构化类型做依赖倒置：node.ts 把真实 CodexAppServerBridge / TaskIndexRepo 注入进来，
// 本模块不 import 它们的实现，避免 codex 托管模块对 accounts/session 内部实现的深依赖。
import type { ZCodeTaskMeta } from "@zcode/shared";

/**
 * CodexAppServerBridge 的最小结构面。真实 bridge（accounts/codexAppServerBridge.ts）
 * 天然满足该形状；generation 语义由 bridge 权威维护，本模块只读。
 */
export interface CodexAppServerPort {
  readonly installed: boolean;
  /** 每次 (re)start 递增；换代后旧的 thread runtime 一律视为 stale。 */
  readonly generation: number;
  call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  /** 应答服务器 → 客户端请求（审批）。进程换代后代答会被 bridge 丢弃。 */
  respond(rawId: number, result: unknown): void;
  onNotification(
    handler: (method: string, params: unknown, rawRequest?: { method: string; params: unknown; rawId: number }) => void,
  ): () => void;
}

/** TaskIndexRepo 的最小结构面（方法双变让真实 repo 可直接注入）。 */
export interface CodexTaskIndexPort {
  syncTaskMeta(params: {
    meta: ZCodeTaskMeta;
    pinned?: boolean;
    archived?: boolean;
    deleted?: boolean;
    titleOverridden?: boolean;
    searchableText?: string;
  }): Promise<ZCodeTaskMeta>;
  updateTaskState(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    patch: {
      title?: string;
      titleOverridden?: boolean;
      status?: ZCodeTaskMeta["status"];
      lastError?: ZCodeTaskMeta["lastError"];
      updatedAt?: number;
    };
  }): Promise<ZCodeTaskMeta>;
  getTaskMeta(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<ZCodeTaskMeta | null>;
  listTaskMetas(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta[]>;
}
