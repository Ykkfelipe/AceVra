/**
 * 读取一个会话当前投影里的可见行（只读）。
 *
 * 不新开读路径：经同一个 workspace 连接注册表 + SessionDataLayer 租用该会话的
 * ConversationProjectionStore——会话正在屏上时这就是对话面正在渲染的那一份（warm，无额外订阅）；
 * 不在屏上时按普通冷订阅打开，卸载时释放租约（keep-warm 语义由数据层负责）。
 *
 * 只返回尾部窗口（snapshot.rows.window）：调用方用于「最近的对话」，不需要全量历史；
 * 另带会话持久化的模型选择，供交接沿用同一模型。
 */
import { useEffect, useState } from "react";
import type { ConversationRow, SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import { useServices } from "@/hooks/useServices.js";
import { acquireWorkspaceConnection } from "@/v4/workspaceConnectionRegistry.js";

export type ConversationRowsSnapshot =
  | { status: "loading" }
  | {
      status: "ready";
      rows: readonly ConversationRow[];
      /** 会话持久化的模型选择（上次实际使用的 provider/model/effort）；稀疏，可能缺省。 */
      modelSelection: SessionConfigState["modelSelection"];
    }
  | { status: "error"; message: string | null };

export function useConversationRowsSnapshot(params: {
  workspacePath: string;
  sessionId: string;
}): ConversationRowsSnapshot {
  const { workspacePath, sessionId } = params;
  const { zcodeAgentService } = useServices();
  const [state, setState] = useState<ConversationRowsSnapshot>({ status: "loading" });

  useEffect(() => {
    const connection = acquireWorkspaceConnection({ workspacePath }, zcodeAgentService);
    const session = connection.layer.acquire(sessionId);
    const read = () => {
      const current = session.store.getState();
      if (current.snapshot) {
        setState({
          status: "ready",
          rows: current.snapshot.rows.window,
          modelSelection: current.snapshot.config.modelSelection,
        });
      } else if (current.status === "error") {
        setState({ status: "error", message: current.lastError });
      }
    };
    read();
    const unsubscribe = session.store.subscribe(read);
    return () => {
      unsubscribe();
      session.release();
      connection.release();
    };
  }, [sessionId, workspacePath, zcodeAgentService]);

  return state;
}

/**
 * 一次性读取（无表单 Work on this 用）：同一条租约路径，拿到快照即释放；
 * 会话在屏上时 store 已是 warm，通常同步返回。
 */
export function readConversationSnapshotOnce(params: {
  workspacePath: string;
  sessionId: string;
  agentService: Parameters<typeof acquireWorkspaceConnection>[1];
  timeoutMs?: number;
}): Promise<{
  rows: readonly ConversationRow[];
  modelSelection: SessionConfigState["modelSelection"];
}> {
  const connection = acquireWorkspaceConnection(
    { workspacePath: params.workspacePath },
    params.agentService,
  );
  const session = connection.layer.acquire(params.sessionId);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      session.release();
      connection.release();
      action();
    };
    const read = () => {
      const current = session.store.getState();
      if (current.snapshot) {
        const snapshot = current.snapshot;
        finish(() =>
          resolve({ rows: snapshot.rows.window, modelSelection: snapshot.config.modelSelection }),
        );
      } else if (current.status === "error") {
        finish(() => reject(new Error(current.lastError ?? "conversation unavailable")));
      }
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("conversation load timed out"))),
      params.timeoutMs ?? 10_000,
    );
    const unsubscribe = session.store.subscribe(read);
    read();
  });
}
