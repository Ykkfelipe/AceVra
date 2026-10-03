import { buildHandoffContextPreview, type HandoffContextPreview } from "./context.js";
import {
  HandoffContractError,
  handoffIssuesSorted,
  type HandoffValidationIssue,
} from "./errors.js";
import { HandoffFlowError } from "./flow-errors.js";
import {
  serializeHandoffPacket,
  validateHandoffPacketTransfer,
  type HandoffPacket,
  type HandoffReturnPolicy,
} from "./handoff-packet.js";
import type { AceVraMode, HandoffObjectRef } from "./modes.js";

/**
 * M2 预览会话（纯逻辑，UI 无关）：用户确认前的草稿、编辑与确认状态机。
 * - 草稿通过 M1 编辑原语修改（setHandoffContextItemIncluded / updateHandoffContextItemContent 等）；
 * - 确认只在准入校验没有 error 级问题时成立，并冻结规范序列化快照；
 * - 本模块不发起任何转移、不触达 UI、执行端口或持久化。
 *
 * 状态：draft →（编辑）→ confirmed。已确认的会话不可再编辑；
 * 需要修改时开启新的预览（快照保持不变，准入从快照解析）。
 */

export interface HandoffConfirmation {
  readonly handoffId: string;
  /** 确认时刻的规范序列化快照；准入流程必须从这个快照重新解析。 */
  readonly packetJson: string;
  readonly confirmedAt: number;
  /** 确认时接受的非阻塞提示（warning）。 */
  readonly warnings: readonly HandoffValidationIssue[];
}

export interface HandoffPreviewSession {
  readonly draft: HandoffPacket;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly confirmation: HandoffConfirmation | null;
}

export function beginHandoffPreview(
  draft: HandoffPacket,
  now: number = Date.now(),
): HandoffPreviewSession {
  return { draft, createdAt: now, updatedAt: now, confirmation: null };
}

/** 用编辑函数（通常是 M1 编辑原语）更新草稿；已确认的会话冻结，需要新的预览会话。 */
export function editHandoffPreviewDraft(
  session: HandoffPreviewSession,
  edit: (draft: HandoffPacket) => HandoffPacket,
  now: number = Date.now(),
): HandoffPreviewSession {
  if (session.confirmation) {
    throw new HandoffFlowError(
      "handoff_flow_preview_confirmed",
      "preview session is already confirmed; start a new preview to make changes",
    );
  }
  return { ...session, draft: edit(session.draft), updatedAt: now };
}

/** 当前草稿的准入问题（确定性排序）；与最终准入使用同一份 M1 校验。 */
export function validateHandoffPreview(session: HandoffPreviewSession): HandoffValidationIssue[] {
  return validateHandoffPacketTransfer(session.draft);
}

export function canConfirmHandoffPreview(session: HandoffPreviewSession): boolean {
  return validateHandoffPreview(session).every((issue) => issue.severity !== "error");
}

export type HandoffConfirmResult =
  | { ok: true; session: HandoffPreviewSession }
  | { ok: false; issues: HandoffValidationIssue[] };

/**
 * 用户确认：存在 error 级问题时不抛错、返回 issues；否则冻结规范序列化快照。
 * 确认本身不发起转移 —— 派发是独立的一步（admission），由用户显式触发的下一步完成。
 */
export function confirmHandoffPreview(
  session: HandoffPreviewSession,
  now: number = Date.now(),
): HandoffConfirmResult {
  if (session.confirmation) {
    throw new HandoffFlowError(
      "handoff_flow_preview_confirmed",
      "preview session is already confirmed",
    );
  }
  const issues = validateHandoffPreview(session);
  const errors = issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    return { ok: false, issues };
  }
  let packetJson: string;
  try {
    packetJson = serializeHandoffPacket(session.draft);
  } catch (error) {
    if (error instanceof HandoffContractError) {
      const contractIssues =
        error.issues.length > 0
          ? error.issues
          : [{ code: error.code, path: "", message: error.message, severity: "error" as const }];
      return { ok: false, issues: handoffIssuesSorted(contractIssues) };
    }
    throw error;
  }
  const confirmation: HandoffConfirmation = {
    handoffId: session.draft.handoffId,
    packetJson,
    confirmedAt: now,
    warnings: issues.filter((issue) => issue.severity === "warning"),
  };
  return { ok: true, session: { ...session, updatedAt: now, confirmation } };
}

export interface HandoffPreviewViewModel {
  readonly handoffId: string;
  readonly sourceMode: AceVraMode;
  readonly destinationMode: AceVraMode;
  readonly objective: string;
  readonly linkedProject: HandoffObjectRef | null;
  readonly returnPolicy: HandoffReturnPolicy;
  readonly context: HandoffContextPreview;
  readonly issues: HandoffValidationIssue[];
  readonly blocked: boolean;
  readonly confirmedAt: number | null;
}

/** UI（后续）直接把此视图渲染成预览对话框；这里只有数据，不含任何 UI 框架类型。 */
export function buildHandoffPreviewViewModel(
  session: HandoffPreviewSession,
): HandoffPreviewViewModel {
  const issues = validateHandoffPreview(session);
  return {
    handoffId: session.draft.handoffId,
    sourceMode: session.draft.sourceMode,
    destinationMode: session.draft.destinationMode,
    objective: session.draft.objective,
    linkedProject: session.draft.linkedProject,
    returnPolicy: session.draft.returnPolicy,
    context: buildHandoffContextPreview(session.draft),
    issues,
    blocked: issues.some((issue) => issue.severity === "error"),
    confirmedAt: session.confirmation?.confirmedAt ?? null,
  };
}
