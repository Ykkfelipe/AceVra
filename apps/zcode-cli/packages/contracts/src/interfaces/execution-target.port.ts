// ============================================================
// Execution Target Port - agent process execution on the user's other computers (M2F)
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
  type: "desktop" | "node" | "ssh";
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

/** 会话绑定的另一台电脑（由用户输入命令写入）；undefined = automatic/本机。桌面端当前总是 automatic。 */
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
  /** SSH 电脑的一次 GUI 动作（坐标 = 远端屏幕像素）；离线/暂停/占用如实失败，绝不在本机执行。 */
  computer(
    input: { targetId: string; action: RemoteComputerAction },
    context?: ExecutionTargetCallContext,
  ): Promise<
    | {
        ok: true;
        screen: { width: number; height: number };
        image?: { base64: string; mimeType: string; width: number; height: number };
      }
    | ExecutionTargetFailure
  >;
}

export type RemoteComputerAction =
  | { kind: "screenshot" }
  | { kind: "click"; x: number; y: number; button?: "left" | "right" | "middle"; double?: boolean }
  | { kind: "move"; x: number; y: number }
  | { kind: "drag"; fromX: number; fromY: number; toX: number; toY: number }
  | { kind: "scroll"; x?: number; y?: number; dy: number }
  | { kind: "type"; text: string }
  | { kind: "key"; keys: string[] };
