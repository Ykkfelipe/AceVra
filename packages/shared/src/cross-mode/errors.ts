/**
 * Cross-Mode 契约的统一错误码、问题结构与错误类型。
 * 所有校验失败必须以这组封闭错误码表达，便于上游映射、UI 展示与测试断言。
 */

export const HANDOFF_ISSUE_CODES = [
  "handoff_schema_invalid",
  "handoff_json_invalid",
  "handoff_version_unsupported",
  "handoff_same_mode",
  "handoff_transition_not_allowed",
  "handoff_repo_write_requires_read",
  "handoff_sensitive_auto_included",
  "handoff_context_item_ids_duplicated",
  "handoff_context_items_limit",
  "handoff_context_included_limit",
  "handoff_context_item_too_large",
  "handoff_context_total_bytes_exceeded",
  "handoff_source_refs_required",
  "handoff_linked_project_kind_invalid",
  "handoff_linked_project_required",
  "handoff_constraint_duplicated",
  "handoff_context_item_not_found",
  "handoff_context_item_invalid",
] as const;

export type HandoffIssueCode = (typeof HANDOFF_ISSUE_CODES)[number];

export type HandoffIssueSeverity = "error" | "warning";

export interface HandoffValidationIssue {
  readonly code: HandoffIssueCode;
  readonly path: string;
  readonly message: string;
  readonly severity: HandoffIssueSeverity;
}

/** 契约层错误：schema/序列化失败、编辑原语误用与准入校验失败统一抛这个类型。 */
export class HandoffContractError extends Error {
  readonly code: HandoffIssueCode;
  readonly issues: readonly HandoffValidationIssue[];

  constructor(
    code: HandoffIssueCode,
    message: string,
    issues: readonly HandoffValidationIssue[] = [],
  ) {
    super(message);
    this.name = "HandoffContractError";
    this.code = code;
    this.issues = issues;
  }
}

/**
 * 确定性排序（先 code 升序，再 path 升序）。
 * 用 code unit 比较而不是 localeCompare：排序结果不依赖运行时 locale/ICU 版本，校验输出必须可复现。
 */
export function handoffIssuesSorted(
  issues: readonly HandoffValidationIssue[],
): HandoffValidationIssue[] {
  return [...issues].sort((a, b) => {
    if (a.code !== b.code) {
      return a.code < b.code ? -1 : 1;
    }
    if (a.path !== b.path) {
      return a.path < b.path ? -1 : 1;
    }
    return 0;
  });
}

/** zod issue 的 path 数组 → 稳定字符串（`context[0].content` 风格），全契约共用一种格式。 */
export function formatHandoffIssuePath(path: readonly PropertyKey[]): string {
  let formatted = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      formatted += `[${segment}]`;
      continue;
    }
    formatted += formatted === "" ? String(segment) : `.${String(segment)}`;
  }
  return formatted;
}
