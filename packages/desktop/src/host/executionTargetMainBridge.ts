import { randomUUID } from "node:crypto";
import { HostResponseTypes } from "@zcode/shared";
import type {
  ExecutionTargetExecutor,
  ZCodeExecutionTargetParams,
  ZCodeExecutionTargetResult,
} from "@zcode/shared";

/**
 * host↔main 执行目标桥（M2F）。agent 的 interaction/executionTarget 经 services 到这里，
 * 再经 parentPort 交给 Main 的账号任务 API；按 requestId 关联回传。与 browser 桥同一 pending map 模式。
 */

interface ExecutionTargetRequestMessage {
  type: typeof HostResponseTypes.ExecutionTargetRequest;
  requestId: string;
  request: ZCodeExecutionTargetParams;
}

interface PendingEntry {
  resolve: (result: ZCodeExecutionTargetResult) => void;
  timer: ReturnType<typeof setTimeout>;
  op: ZCodeExecutionTargetParams["op"];
}

/** 每个 op 只是一次控制面 HTTP 往返；20s 足够，超时如实返回 timeout 而不是悬挂 agent 工具。 */
const DEFAULT_TIMEOUT_MS = 20_000;
/** computer op 首次可能要建 SSH 隧道 + 取 token + 截屏，给足时间但仍有上限。 */
const COMPUTER_TIMEOUT_MS = 60_000;

export interface ExecutionTargetMainBridge extends ExecutionTargetExecutor {
  handleResult(message: { requestId: string; result: ZCodeExecutionTargetResult }): void;
  dispose(): void;
}

export function createExecutionTargetMainBridge(deps: {
  postToMain: (message: ExecutionTargetRequestMessage) => void;
  timeoutMs?: number;
}): ExecutionTargetMainBridge {
  const pending = new Map<string, PendingEntry>();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const settle = (requestId: string, result: ZCodeExecutionTargetResult) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(result);
  };
  return {
    execute(request) {
      // bridge 自己的 correlation key：agent 侧 requestId 可能在重试时复用，不能直接当 pending key。
      const requestId = randomUUID();
      return new Promise<ZCodeExecutionTargetResult>((resolve) => {
        const timer = setTimeout(
          () => {
            settle(requestId, {
              op: request.op,
              ok: false,
              reason: "timeout",
              // start 超时无法证明任务未创建；如实告知，避免 agent 误以为可以安全重试。
              ...(request.op === "start" ? { detail: "task_may_have_started" } : {}),
            });
          },
          Math.max(timeoutMs, request.op === "computer" ? COMPUTER_TIMEOUT_MS : 0),
        );
        pending.set(requestId, { resolve, timer, op: request.op });
        try {
          deps.postToMain({ type: HostResponseTypes.ExecutionTargetRequest, requestId, request });
        } catch {
          settle(requestId, { op: request.op, ok: false, reason: "unavailable" });
        }
      });
    },
    handleResult(message) {
      const entry = pending.get(message.requestId);
      // 迟到结果（已超时）或 op 不匹配的结果一律丢弃。
      if (!entry || entry.op !== message.result.op) return;
      settle(message.requestId, message.result);
    },
    dispose() {
      for (const [requestId, entry] of pending) {
        settle(requestId, {
          op: entry.op,
          ok: false,
          reason: "unavailable",
          detail: "host_disposed",
        });
      }
    },
  };
}
