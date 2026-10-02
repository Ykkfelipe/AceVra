import { randomUUID } from "node:crypto";
import type { CuaWorkspaceStreamResult, CuaWorkspaceView } from "@zcode/zcode-cua/broker";

export interface WorkspaceStreamDependencies {
  workspace(sessionId: string): CuaWorkspaceView | undefined;
  paused(): boolean;
  call(params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** The two holders of a trusted, in-process Helper transport inside one Local Host graph. */
export interface WorkspaceStreamHelperHolders {
  /** CUA-1.75 hardened session: the darwin product owner of the Helper transport. */
  hardened(): {
    host: {
      readonly helperConnected: boolean;
      callMethod(
        method: string,
        params: Record<string, unknown>,
        options?: { timeoutMs?: number },
      ): Promise<Record<string, unknown>>;
    };
  } | null;
  /** Managed MCP-host Helper (never acquired on darwin product; kept as a secondary holder). */
  managed():
    | { queryWorkspaceStream?(params: Record<string, unknown>): Promise<Record<string, unknown>> }
    | undefined;
}

const WORKSPACE_STREAM_TIMEOUT_MS = 3_000;

/**
 * 修复依据（本地预览拿不到 workspace_stream）：darwin 产品路径上 Helper 传输的唯一所有者是本
 * Local Host 服务图里的 hardened session（Agent spawn env 的 tuple 也出自它）；托管 MCP-host
 * Helper 在 darwin 上按设计从不 acquire，所以只认 `defaultCuaProductHelperLifecycle.peek()` 的
 * 读取在窗口 host 里永远失败。这里按「谁真正持有可信传输」解析：先走 hardened session 的进程内
 * 可信 `callMethod`（host-transport 的 host-only 闸门只放行这一路），托管 host 只作次要持有者。
 * 不新建 Helper / TCC 身份 / 捕获进程，也不放宽任何对端校验。
 */
export function createWorkspaceStreamHelperCall(holders: WorkspaceStreamHelperHolders) {
  return async (params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const hardened = holders.hardened();
    if (hardened?.host.helperConnected) {
      return hardened.host.callMethod("workspace_stream", params, {
        timeoutMs: WORKSPACE_STREAM_TIMEOUT_MS,
      });
    }
    const managed = holders.managed();
    if (managed?.queryWorkspaceStream) return managed.queryWorkspaceStream(params);
    throw new Error("Local computer capture unavailable");
  };
}

/** One visual demand, one in-flight read. Authority owns target/admission; Helper owns pixels. */
export function createWorkspaceStreamAdapter(deps: WorkspaceStreamDependencies) {
  let owner = "";
  let targetKey = "";
  let generation = "";
  let pending: Promise<CuaWorkspaceStreamResult> | null = null;

  const base = (workspace?: CuaWorkspaceView): CuaWorkspaceStreamResult => ({
    sourceId: "local-mac",
    executionTargetId: "this-device",
    status: "unavailable",
    generation,
    paused: deps.paused(),
    ...(workspace ? { workspace } : {}),
  });
  const stopCurrent = async () => {
    const old = generation;
    generation = "";
    targetKey = "";
    if (old) await deps.call({ operation: "stop", generation: old }).catch(() => undefined);
  };
  return async function read(
    sessionId: string,
    request: { operation: "read" | "stop"; afterSeq?: number },
  ): Promise<CuaWorkspaceStreamResult> {
    if (!sessionId || sessionId.length > 160) return { ...base(), reason: "invalid_session" };
    const workspace = deps.workspace(sessionId);
    const target = workspace?.target;
    if (request.operation === "stop") {
      if (owner === sessionId) await stopCurrent();
      return { ...base(workspace), reason: "hidden" };
    }
    if (request.operation !== "read") return { ...base(workspace), reason: "bad_request" };
    if (!target || !Number.isInteger(target.pid) || target.pid <= 0) {
      if (owner === sessionId && generation) await stopCurrent();
      return { ...base(workspace), reason: "target_unavailable" };
    }
    const key = `${sessionId}:${target.pid}:${target.windowId ?? 0}`;
    if (key !== targetKey || !generation) {
      // 另一个会话接手唯一的可视需求时，先停掉上一代，避免两个预览争抢同一条 Helper 流。
      if (owner && owner !== sessionId && generation) await stopCurrent();
      targetKey = key;
      owner = sessionId;
      generation = randomUUID();
    }
    const token = generation;
    // 同代并发读合并为一项；不排队。切换 target 后旧结果不能更新当前来源。
    if (pending) return { ...base(workspace), reason: "read_pending" };
    pending = (async () => {
      try {
        const raw = await deps.call({
          generation: token,
          pid: target.pid,
          window_id: target.windowId ?? 0,
          operation: "read",
          after_seq: request.afterSeq ?? 0,
        });
        const latest = deps.workspace(sessionId);
        const current = latest?.target;
        if (
          token !== generation ||
          current?.pid !== target.pid ||
          current?.windowId !== target.windowId
        ) {
          return { ...base(), reason: "superseded" };
        }
        // 光标与像素同一次读取返回：读完再取投影，光标不会比帧更旧。
        const result = base(latest);
        if (
          raw.status === "available" &&
          (raw.pid !== target.pid || (target.windowId != null && raw.windowId !== target.windowId))
        ) {
          return { ...result, reason: "wrong_target" };
        }
        result.status = raw.status === "available" ? "available" : "unavailable";
        if (typeof raw.reason === "string") result.reason = raw.reason;
        for (const field of [
          "seq",
          "capturedAt",
          "width",
          "height",
          "pid",
          "windowId",
          "originX",
          "originY",
          "pointWidth",
          "pointHeight",
        ] as const) {
          if (typeof raw[field] === "number" && Number.isFinite(raw[field]))
            result[field] = raw[field];
        }
        if (typeof raw.jpeg === "string" && raw.jpeg.length <= 2_000_000) result.jpeg = raw.jpeg;
        return result;
      } catch {
        return { ...base(workspace), reason: "capture_unavailable" };
      }
    })();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  };
}
