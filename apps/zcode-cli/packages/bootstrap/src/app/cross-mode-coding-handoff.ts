import {
  createHandoffAdmissionService,
  deserializeHandoffPacket,
  HandoffContractError,
  HandoffFlowError,
  validateHandoffPacketTransfer,
  type HandoffConfirmation,
  type HandoffExecutionPort,
  type HandoffPacket,
} from "@zcode/shared/cross-mode";
import {
  CROSS_MODE_ORIGIN_SESSION_ENTRY_TYPE,
  CROSS_MODE_ORIGIN_VERSION,
  projectCrossModeOriginState,
  type CrossModeOriginEntry,
  type CrossModeOriginState,
} from "@zcode/shared/zcode-protocol-v4";

// Cross-Mode 入站交接（目的 = Coding，docs/specs/cross-mode-bot-to-coding.md）：
// - 只接受渲染端已确认的冻结快照，经冻结 M2 准入服务重新解析/校验后派发到本执行端口；
// - 执行端口 = 在**已建好的**目的会话上落地：物化会话 → 写 `v4/cross_mode_origin` → accepted；
// - 首条输入由本文件从 packet 渲染（单一渲染所有者），只含用户勾选的上下文。
// 本模块不创建会话记录、不启动 turn、不碰 Bot 的任何状态；会话与 turn 归命令层既有路径。

/** 目的 workspace（结果侧事实，写入 origin）。 */
export interface CrossModeCodingDestination {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
}

export interface CrossModeCodingIntakeDeps {
  /** 目的会话 id（record 已由命令层建好）。 */
  readonly sessionId: string;
  readonly destination: CrossModeCodingDestination;
  /** 物化会话（标题取 objective）。session_entry 对 session 行有外键，必须先于 entry 写入。 */
  persistSession(objective: string): Promise<void>;
  saveOriginEntry(input: {
    id: string;
    type: typeof CROSS_MODE_ORIGIN_SESSION_ENTRY_TYPE;
    data: CrossModeOriginEntry;
    time: { created: number; updated: number };
  }): Promise<void>;
  now?: () => number;
}

export type CrossModeCodingIntakeOutcome =
  | { readonly ok: true; readonly packet: HandoffPacket; readonly origin: CrossModeOriginState }
  | { readonly ok: false; readonly reason: "invalid_input" | "rejected"; readonly message: string };

/** 拒绝原因只回可展示的短文本，避免把底层异常（路径、SQL）透给 UI。 */
const MAX_REASON_LENGTH = 300;

function boundedMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= MAX_REASON_LENGTH ? text : `${text.slice(0, MAX_REASON_LENGTH - 1)}…`;
}

/**
 * 建会话**之前**的预检：快照可解析、与 handoffId 一致、目的是 coding、满足冻结准入规则。
 * 失败时不应留下任何会话（spec §5 规则 1）。准入阶段仍会再校验一次（纵深防御）。
 */
export function preflightCrossModeCodingHandoff(
  confirmation: HandoffConfirmation,
): { ok: true; packet: HandoffPacket } | { ok: false; message: string } {
  let packet: HandoffPacket;
  try {
    packet = deserializeHandoffPacket(confirmation.packetJson);
  } catch (error) {
    return { ok: false, message: boundedMessage(error) };
  }
  if (packet.handoffId !== confirmation.handoffId) {
    return { ok: false, message: "handoff confirmation does not match its snapshot" };
  }
  if (packet.destinationMode !== "coding") {
    return {
      ok: false,
      message: `handoff destination must be coding, got ${packet.destinationMode}`,
    };
  }
  const errors = validateHandoffPacketTransfer(packet).filter(
    (issue) => issue.severity === "error",
  );
  if (errors.length > 0) {
    return {
      ok: false,
      message: errors.map((issue) => `${issue.path || "<root>"}: ${issue.message}`).join("; "),
    };
  }
  return { ok: true, packet };
}

/**
 * 准入 + 执行：冻结 admission 服务负责 re-parse / dispatched / accepted|rejected 语义，
 * 本函数只提供执行端口。准入记录本身是一次性的（内存 store）——持久事实是 origin entry。
 */
export async function acceptCrossModeCodingHandoff(
  confirmation: HandoffConfirmation,
  deps: CrossModeCodingIntakeDeps,
): Promise<CrossModeCodingIntakeOutcome> {
  const now = deps.now ?? (() => Date.now());
  let accepted: { packet: HandoffPacket; origin: CrossModeOriginState } | null = null;

  const execution: HandoffExecutionPort = {
    async execute({ packet }) {
      if (packet.destinationMode !== "coding") {
        return { status: "rejected", reason: "handoff destination must be coding" };
      }
      try {
        await deps.persistSession(packet.objective);
        const acceptedAt = now();
        const entry: CrossModeOriginEntry = {
          version: CROSS_MODE_ORIGIN_VERSION,
          confirmation: { ...confirmation, warnings: [...confirmation.warnings] },
          resultRef: { kind: "coding-session", id: deps.sessionId },
          destination: {
            workspacePath: deps.destination.workspacePath,
            ...(deps.destination.workspaceIdentity
              ? { workspaceIdentity: deps.destination.workspaceIdentity }
              : {}),
          },
          acceptedAt,
        };
        const origin = projectCrossModeOriginState(entry);
        if (!origin) {
          return { status: "rejected", reason: "handoff snapshot could not be projected" };
        }
        await deps.saveOriginEntry({
          // session_entry.id 是全库主键：带上 sessionId，避免同一 handoff 误绑到别的会话。
          id: `v4_cross_mode_origin:${deps.sessionId}:${packet.handoffId}`,
          type: CROSS_MODE_ORIGIN_SESSION_ENTRY_TYPE,
          data: entry,
          time: { created: acceptedAt, updated: acceptedAt },
        });
        accepted = { packet, origin };
        return { status: "accepted", externalRef: entry.resultRef };
      } catch (error) {
        return { status: "rejected", reason: boundedMessage(error) };
      }
    },
  };

  const admission = createHandoffAdmissionService({ execution, now });
  let record;
  try {
    record = await admission.admit(confirmation);
  } catch (error) {
    if (error instanceof HandoffFlowError || error instanceof HandoffContractError) {
      return { ok: false, reason: "invalid_input", message: boundedMessage(error) };
    }
    throw error;
  }
  if (record.status !== "accepted" || !accepted) {
    return {
      ok: false,
      reason: "rejected",
      message: record.rejectionReason ?? "handoff was not accepted",
    };
  }
  const result: { packet: HandoffPacket; origin: CrossModeOriginState } = accepted;
  return { ok: true, packet: result.packet, origin: result.origin };
}

function sourceLabel(packet: HandoffPacket): string {
  return packet.sourceMode === "bot" ? "a conversation with Ace" : `${packet.sourceMode} mode`;
}

/**
 * 交接首条用户消息（agent 可见、用户可见）。只渲染 objective、**已勾选**的上下文与约束；
 * 未勾选条目、来源引用 id、个人记忆都不进入正文。
 */
export function renderCrossModeHandoffFirstInput(packet: HandoffPacket): string {
  const lines: string[] = [
    `This work was handed off from ${sourceLabel(packet)}.`,
    "",
    "## Objective",
    packet.objective,
  ];
  const included = packet.context.filter((item) => item.included);
  if (included.length > 0) {
    lines.push("", "## Context carried over");
    for (const item of included) {
      lines.push("", `### ${item.label}`, item.content);
    }
  }
  if (packet.constraints.length > 0) {
    lines.push("", "## Constraints", ...packet.constraints.map((constraint) => `- ${constraint}`));
  }
  if (packet.returnPolicy !== "none") {
    lines.push(
      "",
      "When the work is done, end with a short summary of what changed and what is still open, so it can be brought back to Ace.",
    );
  }
  return lines.join("\n");
}
