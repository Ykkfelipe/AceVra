// Codex 任务的 v4 快照/control 构造（domain，纯函数）。
// 不建模的区段（goal/plan/queue/workflow/subagent/backgroundWorks）恒为空或 null，
// 绝不伪造；availability 全量禁用并携带统一的 reasonCode，UI 据此渲染禁用态。
import type {
  ConversationRow,
  ConversationSnapshot,
  PendingInteraction,
  SessionControl,
} from "@zcode/shared/zcode-protocol-v4";
import type { CodexExecutionApprovalRequestInfo } from "@zcode/shared";

export type CodexPhase = SessionControl["phase"];

/** 投影对外的最小状态面；快照构造只允许读这些字段。 */
export interface CodexProjectionState {
  readonly logEpoch: string;
  readonly seq: number;
  readonly revision: number;
  readonly phase: CodexPhase;
  readonly lastError: SessionControl["lastError"];
  readonly rows: readonly ConversationRow[];
  readonly pendingInteractions: readonly PendingInteraction[];
}

const UNSUPPORTED_REASON = "codex.backendUnsupported";

export function buildCodexControl(state: CodexProjectionState): SessionControl {
  const sessionEnded =
    state.phase === "completedSuccess" ||
    state.phase === "completedInterrupted" ||
    state.phase === "error";
  return {
    phase: state.phase,
    sessionEnded,
    canStop: state.phase === "running",
    stopState: state.phase === "running" ? "stoppable" : "idle",
    stopTargetKind: state.phase === "running" ? "assistant" : "unknown",
    activeWorks: state.phase === "running" ? [{ kind: "primaryTurn", startedAt: 0 }] : [],
    lastError: state.lastError,
    apiRetry: null,
  };
}

export function buildCodexSnapshot(
  state: CodexProjectionState,
  sessionId: string,
  title: string,
): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId,
    logEpoch: state.logEpoch,
    seq: state.seq,
    revision: state.revision,
    control: buildCodexControl(state),
    availability: {
      fork: { allowed: false, reasonCode: UNSUPPORTED_REASON },
      compact: { allowed: false, reasonCode: UNSUPPORTED_REASON },
      switchModelConfig: { allowed: false, reasonCode: UNSUPPORTED_REASON },
      setFollowupMode: { allowed: false, reasonCode: UNSUPPORTED_REASON },
      queueEdit: { allowed: false, reasonCode: UNSUPPORTED_REASON },
      sendQueuedNow: { allowed: false, reasonCode: UNSUPPORTED_REASON },
      pauseGoal: { allowed: false, reasonCode: UNSUPPORTED_REASON },
      resumeGoal: { allowed: false, reasonCode: UNSUPPORTED_REASON },
    },
    inputRouting: { mode: state.phase === "running" ? "reject" : "startNow" },
    meta: { title, titleSource: "default" },
    config: {
      provider: "codex",
      model: "",
      thought: "",
      thoughtLevels: [],
      followupMode: "queue",
      mode: "build",
    },
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [...state.pendingInteractions],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    workspaceHookAdmission: null,
    rows: {
      window: [...state.rows],
      totalCount: state.rows.length,
      firstRowId: state.rows.length > 0 ? (state.rows[0]?.rowId ?? null) : null,
    },
  };
}

const APPROVAL_OPTIONS = [
  { optionId: "approved", label: "Allow", kind: "allowOnce", response: { decision: "allow" } },
  { optionId: "denied", label: "Deny", kind: "deny", response: { decision: "deny" } },
] as const;

export function buildCodexApprovalInteraction(params: {
  interactionId: string;
  info: CodexExecutionApprovalRequestInfo;
  anchorRowId: number | null;
  createdAt: number;
}): PendingInteraction {
  return {
    interactionId: params.interactionId,
    kind: "permission",
    anchorRowId: params.anchorRowId,
    createdAt: params.createdAt,
    payload: {
      kind: "permission",
      toolCallId: params.anchorRowId !== null ? String(params.anchorRowId) : params.interactionId,
      toolName: params.info.toolName,
      summary: params.info.summary,
      detail: { kind: params.info.kind },
      options: APPROVAL_OPTIONS.map((option) => ({ ...option })),
    },
  };
}
