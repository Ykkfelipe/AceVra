// ============================================================
// Execution Target Port - agent process execution on the "Run on" target (M2F)
// ============================================================
// 每个会话一个 port（bootstrap 注入）。失败一律返回判别联合，原因跨 CLI↔host↔Main 保真，
// 让工具给模型稳定、可行动且真实的错误（离线/吊销/未登录），禁止降级到本机执行。

export type ExecutionTargetTaskState =
  | "queued"
  | "dispatching"
  | "running"
  | "running_unknown"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export interface ExecutionTargetInfo {
  id: string;
  type: "desktop" | "node";
  displayName: string;
  online: boolean;
  capabilities: string[];
  isThisDevice: boolean;
  available: boolean;
  unavailableReason?: string;
}

export interface ExecutionTaskSnapshot {
  id: string;
  targetId: string;
  state: ExecutionTargetTaskState;
  result: Record<string, unknown> | null;
  lastSequence: number;
}

export interface ExecutionTaskEventRecord {
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface ExecutionProcessSpec {
  executable: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ExecutionTargetFailure {
  ok: false;
  reason: string;
  detail?: string;
}

/** 会话当前的 Run-on 选择（由用户输入命令写入）；undefined = Automatic/本机。 */
export interface SelectedExecutionTarget {
  targetId: string;
  displayName?: string;
}

export interface ExecutionTargetCallContext {
  turnId?: string;
  toolCallId?: string;
}

export interface ExecutionTargetPort {
  selectedTarget(): SelectedExecutionTarget | undefined;
  listTargets(
    context?: ExecutionTargetCallContext,
  ): Promise<{ ok: true; targets: ExecutionTargetInfo[] } | ExecutionTargetFailure>;
  startProcess(
    input: { targetId: string; process: ExecutionProcessSpec },
    context?: ExecutionTargetCallContext,
  ): Promise<{ ok: true; taskId: string; targetId: string } | ExecutionTargetFailure>;
  readTask(
    input: { taskId: string; after: number },
    context?: ExecutionTargetCallContext,
  ): Promise<
    | { ok: true; task: ExecutionTaskSnapshot; events: ExecutionTaskEventRecord[] }
    | ExecutionTargetFailure
  >;
  cancelTask(
    input: { taskId: string },
    context?: ExecutionTargetCallContext,
  ): Promise<{ ok: true; task: ExecutionTaskSnapshot } | ExecutionTargetFailure>;
}
