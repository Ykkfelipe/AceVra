import type { HandoffValidationIssue } from "./errors.js";

/**
 * Cross-Mode 流程层（M2）错误码：预览会话与准入流程的状态/调用方式错误。
 * 与 M1 的传输问题码（HANDOFF_ISSUE_CODES）分开：后者描述 packet 内容校验，
 * 前者描述流程状态（重复确认、重复准入、未知 handoff 等）。
 */
export const HANDOFF_FLOW_ERROR_CODES = [
  "handoff_flow_preview_confirmed",
  "handoff_flow_invalid_confirmation",
  "handoff_flow_already_admitted",
  "handoff_flow_unknown_handoff",
  "handoff_flow_already_returned",
] as const;

export type HandoffFlowErrorCode = (typeof HANDOFF_FLOW_ERROR_CODES)[number];

/** 流程层错误；invalid_confirmation 场景携带 M1 校验问题列表，便于调用方映射与展示。 */
export class HandoffFlowError extends Error {
  readonly code: HandoffFlowErrorCode;
  readonly issues: readonly HandoffValidationIssue[];

  constructor(
    code: HandoffFlowErrorCode,
    message: string,
    issues: readonly HandoffValidationIssue[] = [],
  ) {
    super(message);
    this.name = "HandoffFlowError";
    this.code = code;
    this.issues = issues;
  }
}
