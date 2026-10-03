import { z } from "zod";
import {
  formatHandoffIssuePath,
  HandoffContractError,
  handoffIssuesSorted,
  type HandoffValidationIssue,
} from "./errors.js";
import { handoffObjectRefSchema, type HandoffObjectRef } from "./modes.js";

/**
 * HandoffReturnSummary 契约（v1）：跨模式工作的「结果返回」信封。
 * 用于 "Multitask → Coding" 与 "Work → Bot" 两个 return 流：以项目级摘要 +
 * 结构化条目描述完成情况，而不是搬运整段 transcript。
 *
 * 与 HandoffPacket 一样：纯契约层，无 IO；解析失败一律用统一错误码表达。
 */

export const HANDOFF_RETURN_CONTRACT_VERSION = "handoff-return/v1" as const;

export const HANDOFF_RETURN_STATUSES = ["completed", "partial", "failed", "cancelled"] as const;
export type HandoffReturnStatus = (typeof HANDOFF_RETURN_STATUSES)[number];

export const HANDOFF_RETURN_VERIFICATION_OUTCOMES = ["passed", "failed", "not_run"] as const;
export type HandoffReturnVerificationOutcome =
  (typeof HANDOFF_RETURN_VERIFICATION_OUTCOMES)[number];

export const handoffReturnNoteSchema = z
  .object({
    text: z.string().min(1).max(500),
    refs: z.array(handoffObjectRefSchema).max(8),
  })
  .strict();
export type HandoffReturnNote = z.infer<typeof handoffReturnNoteSchema>;

export const handoffReturnVerificationSchema = z
  .object({
    text: z.string().min(1).max(300),
    outcome: z.enum(HANDOFF_RETURN_VERIFICATION_OUTCOMES),
  })
  .strict();
export type HandoffReturnVerification = z.infer<typeof handoffReturnVerificationSchema>;

export const handoffReturnSummarySchema = z
  .object({
    version: z.literal(HANDOFF_RETURN_CONTRACT_VERSION),
    handoffId: z.string().min(1).max(64),
    returnedAt: z.number().int().nonnegative(),
    status: z.enum(HANDOFF_RETURN_STATUSES),
    summary: z.string().min(1).max(1200),
    changes: z.array(handoffReturnNoteSchema).max(16),
    decisions: z.array(handoffReturnNoteSchema).max(12),
    verification: z.array(handoffReturnVerificationSchema).max(12),
    unresolved: z.array(handoffReturnNoteSchema).max(12),
    blockers: z.array(handoffReturnNoteSchema).max(8),
    artifacts: z.array(handoffObjectRefSchema).max(16),
  })
  .strict();
export type HandoffReturnSummary = z.infer<typeof handoffReturnSummarySchema>;

export interface HandoffReturnNoteInput {
  text: string;
  refs?: HandoffObjectRef[];
}

export interface HandoffReturnVerificationInput {
  text: string;
  outcome: HandoffReturnVerificationOutcome;
}

export interface CreateHandoffReturnSummaryInput {
  handoffId: string;
  status: HandoffReturnStatus;
  summary: string;
  changes?: HandoffReturnNoteInput[];
  decisions?: HandoffReturnNoteInput[];
  verification?: HandoffReturnVerificationInput[];
  unresolved?: HandoffReturnNoteInput[];
  blockers?: HandoffReturnNoteInput[];
  artifacts?: HandoffObjectRef[];
  returnedAt?: number;
}

function schemaIssuesFromZod(error: z.ZodError): HandoffValidationIssue[] {
  return error.issues.map((issue) => ({
    code: "handoff_schema_invalid" as const,
    path: formatHandoffIssuePath(issue.path),
    message: issue.message,
    severity: "error" as const,
  }));
}

function normalizeNotes(notes: HandoffReturnNoteInput[] | undefined): HandoffReturnNote[] {
  return (notes ?? []).map((note) => ({ text: note.text, refs: note.refs ?? [] }));
}

export function createHandoffReturnSummary(
  input: CreateHandoffReturnSummaryInput,
): HandoffReturnSummary {
  const candidate = {
    version: HANDOFF_RETURN_CONTRACT_VERSION,
    handoffId: input.handoffId,
    returnedAt: input.returnedAt ?? Date.now(),
    status: input.status,
    summary: input.summary,
    changes: normalizeNotes(input.changes),
    decisions: normalizeNotes(input.decisions),
    verification: input.verification ?? [],
    unresolved: normalizeNotes(input.unresolved),
    blockers: normalizeNotes(input.blockers),
    artifacts: input.artifacts ?? [],
  };
  return parseHandoffReturnSummary(candidate);
}

export function parseHandoffReturnSummary(value: unknown): HandoffReturnSummary {
  if (typeof value === "object" && value !== null && "version" in value) {
    const version = (value as { version: unknown }).version;
    if (version !== HANDOFF_RETURN_CONTRACT_VERSION) {
      throw new HandoffContractError(
        "handoff_version_unsupported",
        `unsupported handoff return version: ${String(version)}`,
      );
    }
  }
  const parsed = handoffReturnSummarySchema.safeParse(value);
  if (!parsed.success) {
    const issues = handoffIssuesSorted(schemaIssuesFromZod(parsed.error));
    throw new HandoffContractError(
      "handoff_schema_invalid",
      `invalid handoff return summary: ${issues.map((issue) => `${issue.path || "<root>"}: ${issue.message}`).join("; ")}`,
      issues,
    );
  }
  return parsed.data;
}

/** 规范序列化：固定键序 + 先校验再重建，保证同一 summary 永远得到相同字符串。 */
export function serializeHandoffReturnSummary(summary: HandoffReturnSummary): string {
  const validated = parseHandoffReturnSummary(summary);
  const canonical = {
    version: validated.version,
    handoffId: validated.handoffId,
    returnedAt: validated.returnedAt,
    status: validated.status,
    summary: validated.summary,
    changes: validated.changes.map((note) => ({
      text: note.text,
      refs: note.refs.map((ref) => ({ kind: ref.kind, id: ref.id })),
    })),
    decisions: validated.decisions.map((note) => ({
      text: note.text,
      refs: note.refs.map((ref) => ({ kind: ref.kind, id: ref.id })),
    })),
    verification: validated.verification.map((check) => ({
      text: check.text,
      outcome: check.outcome,
    })),
    unresolved: validated.unresolved.map((note) => ({
      text: note.text,
      refs: note.refs.map((ref) => ({ kind: ref.kind, id: ref.id })),
    })),
    blockers: validated.blockers.map((note) => ({
      text: note.text,
      refs: note.refs.map((ref) => ({ kind: ref.kind, id: ref.id })),
    })),
    artifacts: validated.artifacts.map((ref) => ({ kind: ref.kind, id: ref.id })),
  };
  return JSON.stringify(canonical);
}

export function deserializeHandoffReturnSummary(json: string): HandoffReturnSummary {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new HandoffContractError("handoff_json_invalid", "handoff return JSON is not parseable");
  }
  return parseHandoffReturnSummary(value);
}

/** 返回摘要必须指向它回应的那份 handoff packet（同一 handoffId）。 */
export function handoffReturnMatchesPacket(
  summary: HandoffReturnSummary,
  packet: { handoffId: string },
): boolean {
  return summary.handoffId === packet.handoffId;
}
