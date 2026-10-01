import { randomUUID } from "node:crypto";
import type { CuaWorkspaceStreamResult, CuaWorkspaceView } from "@zcode/zcode-cua/broker";

export interface WorkspaceStreamDependencies {
  workspace(sessionId: string): CuaWorkspaceView | undefined;
  paused(): boolean;
  pause(): Promise<unknown>;
  resume(): Promise<unknown>;
  stop(sessionId: string): Promise<unknown>;
  call(params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** One visual demand, one in-flight read. Authority owns target/admission; Helper owns pixels. */
export function createWorkspaceStreamAdapter(deps: WorkspaceStreamDependencies) {
  let owner = "";
  let targetKey = "";
  let generation = "";
  let userControl = false;
  let pending: Promise<CuaWorkspaceStreamResult> | null = null;

  const base = (workspace?: CuaWorkspaceView): CuaWorkspaceStreamResult => ({
    sourceId: "local-mac",
    executionTargetId: "this-device",
    status: "unavailable",
    generation,
    paused: deps.paused(),
    userControl,
    ...(workspace ? { workspace } : {}),
  });
  return async function read(
    sessionId: string,
    request: {
      operation: "read" | "stop" | "take_control" | "give_back" | "stop_agent";
      afterSeq?: number;
    },
  ): Promise<CuaWorkspaceStreamResult> {
    if (!sessionId || sessionId.length > 160) return { ...base(), reason: "invalid_session" };
    const workspace = deps.workspace(sessionId);
    const target = workspace?.target;
    if (request.operation === "stop") {
      if (owner === sessionId) {
        const old = generation;
        generation = "";
        await deps.call({ operation: "stop", generation: old }).catch(() => undefined);
      }
      return { ...base(workspace), reason: "hidden" };
    }
    if (!target || !Number.isInteger(target.pid) || target.pid <= 0) {
      if (owner === sessionId && generation) {
        const old = generation;
        generation = "";
        targetKey = "";
        await deps.call({ operation: "stop", generation: old }).catch(() => undefined);
      }
      return { ...base(workspace), reason: "target_unavailable" };
    }
    const key = `${sessionId}:${target.pid}:${target.windowId ?? 0}`;
    if (key !== targetKey || !generation) {
      if (key !== targetKey) userControl = false;
      targetKey = key;
      owner = sessionId;
      generation = randomUUID();
    }
    const token = generation;
    const params = { generation: token, pid: target.pid, window_id: target.windowId ?? 0 };
    if (request.operation === "give_back") {
      if (!userControl) return { ...base(workspace), reason: "not_in_control" };
      await deps.resume();
      userControl = false;
      return base(workspace);
    }
    if (request.operation === "stop_agent") {
      await deps.pause();
      await deps.stop(sessionId);
      return base(workspace);
    }
    if (request.operation === "take_control") {
      await deps.pause();
      const result = await deps.call({ ...params, operation: "take_control" });
      if (token !== generation) return { ...base(), reason: "superseded" };
      userControl = result.status === "available";
      return {
        ...base(workspace),
        status: userControl ? "available" : "unavailable",
        ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
      };
    }
    // 同代并发读合并为一项；不排队。切换 target 后旧结果不能更新当前来源。
    if (pending) return { ...base(workspace), reason: "read_pending" };
    pending = (async () => {
      try {
        const raw = await deps.call({
          ...params,
          operation: "read",
          after_seq: request.afterSeq ?? 0,
        });
        const current = deps.workspace(sessionId)?.target;
        if (
          token !== generation ||
          current?.pid !== target.pid ||
          current?.windowId !== target.windowId
        ) {
          return { ...base(), reason: "superseded" };
        }
        const result = base(workspace);
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
