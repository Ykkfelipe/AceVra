import { z } from "zod";
import { createUuid } from "../uuid.js";
import {
  collectHandoffContextLimitViolations,
  HANDOFF_CONTEXT_LIMITS,
  handoffContextItemSchema,
  type HandoffContextItem,
} from "./context.js";
import {
  formatHandoffIssuePath,
  HandoffContractError,
  handoffIssuesSorted,
  type HandoffValidationIssue,
} from "./errors.js";
import {
  aceVraModeSchema,
  handoffDirection,
  handoffObjectRefSchema,
  type AceVraMode,
  type HandoffObjectRef,
} from "./modes.js";

/**
 * 跨模式 HandoffPacket 契约（v1）。
 *
 * 一次跨模式转移的完整、可检查描述：来源/目的模式、目标（objective）、
 * 被选中的最小上下文、来源引用（provenance）、约束、权限、关联项目与返回策略。
 *
 * 设计边界（roadmap「Privacy and context boundaries」）：
 * - context 只承载用户可见、逐项可勾选/编辑的最小上下文；本契约没有整段对话的字段，
 *   调用方不得把全量记忆或完整 transcript 塞进 objective/constraints 绕过该边界。
 * - 校验分两层：schema（结构）与 validateHandoffPacketTransfer（语义准入）。
 *   构造只是 draft；只有通过 transfer 校验的 packet 才允许真正发起转移。
 * - 本模块无 IO、无副作用，不执行模式切换或工作派发。
 */

export const HANDOFF_PACKET_CONTRACT_VERSION = "handoff-packet/v1" as const;

/** v1 权限白名单；repo-write 必须同时具备 repo-read（见 transfer 校验）。 */
export const HANDOFF_PERMISSIONS = ["repo-read", "repo-write"] as const;
export type HandoffPermission = (typeof HANDOFF_PERMISSIONS)[number];

/**
 * 返回策略：结果以摘要 / 摘要+制品的形式回到来源上下文；none 表示不期待自动回流。
 * v1 的返回目标固定为「该次 handoff 的来源上下文」；"Work → Bot" 本身是
 * coding→bot / multitask→bot 的独立 handoff，不在这里表达。
 */
export const HANDOFF_RETURN_POLICIES = ["summary", "summary-and-artifacts", "none"] as const;
export type HandoffReturnPolicy = (typeof HANDOFF_RETURN_POLICIES)[number];

export const handoffPacketSchema = z
  .object({
    version: z.literal(HANDOFF_PACKET_CONTRACT_VERSION),
    handoffId: z.string().min(1).max(64),
    createdAt: z.number().int().nonnegative(),
    sourceMode: aceVraModeSchema,
    destinationMode: aceVraModeSchema,
    objective: z.string().min(1).max(500),
    context: z.array(handoffContextItemSchema).max(HANDOFF_CONTEXT_LIMITS.maxItems),
    sourceRefs: z.array(handoffObjectRefSchema).max(16),
    constraints: z.array(z.string().min(1).max(300)).max(12),
    permissions: z.array(z.enum(HANDOFF_PERMISSIONS)).max(8),
    linkedProject: handoffObjectRefSchema.nullable(),
    returnPolicy: z.enum(HANDOFF_RETURN_POLICIES),
  })
  .strict();

export type HandoffPacket = z.infer<typeof handoffPacketSchema>;

export interface CreateHandoffPacketInput {
  sourceMode: AceVraMode;
  destinationMode: AceVraMode;
  objective: string;
  returnPolicy: HandoffReturnPolicy;
  context?: HandoffContextItem[];
  sourceRefs?: HandoffObjectRef[];
  constraints?: string[];
  permissions?: HandoffPermission[];
  linkedProject?: HandoffObjectRef | null;
  handoffId?: string;
  createdAt?: number;
}

function schemaIssuesFromZod(error: z.ZodError): HandoffValidationIssue[] {
  return error.issues.map((issue) => ({
    code: "handoff_schema_invalid" as const,
    path: formatHandoffIssuePath(issue.path),
    message: issue.message,
    severity: "error" as const,
  }));
}

export function createHandoffPacket(input: CreateHandoffPacketInput): HandoffPacket {
  const candidate = {
    version: HANDOFF_PACKET_CONTRACT_VERSION,
    handoffId: input.handoffId ?? createUuid(),
    createdAt: input.createdAt ?? Date.now(),
    sourceMode: input.sourceMode,
    destinationMode: input.destinationMode,
    objective: input.objective,
    context: input.context ?? [],
    sourceRefs: input.sourceRefs ?? [],
    constraints: input.constraints ?? [],
    permissions: input.permissions ?? [],
    linkedProject: input.linkedProject ?? null,
    returnPolicy: input.returnPolicy,
  };
  return parseHandoffPacket(candidate);
}

export function parseHandoffPacket(value: unknown): HandoffPacket {
  if (typeof value === "object" && value !== null && "version" in value) {
    const version = (value as { version: unknown }).version;
    if (version !== HANDOFF_PACKET_CONTRACT_VERSION) {
      throw new HandoffContractError(
        "handoff_version_unsupported",
        `unsupported handoff packet version: ${String(version)}`,
      );
    }
  }
  const parsed = handoffPacketSchema.safeParse(value);
  if (!parsed.success) {
    const issues = handoffIssuesSorted(schemaIssuesFromZod(parsed.error));
    throw new HandoffContractError(
      "handoff_schema_invalid",
      `invalid handoff packet: ${issues.map((issue) => `${issue.path || "<root>"}: ${issue.message}`).join("; ")}`,
      issues,
    );
  }
  return parsed.data;
}

export type HandoffSafeParseResult =
  | { ok: true; packet: HandoffPacket }
  | { ok: false; issues: HandoffValidationIssue[] };

export function safeParseHandoffPacket(value: unknown): HandoffSafeParseResult {
  try {
    return { ok: true, packet: parseHandoffPacket(value) };
  } catch (error) {
    if (error instanceof HandoffContractError) {
      const issues =
        error.issues.length > 0
          ? handoffIssuesSorted(error.issues)
          : handoffIssuesSorted([
              { code: error.code, path: "", message: error.message, severity: "error" },
            ]);
      return { ok: false, issues };
    }
    throw error;
  }
}

/**
 * 规范序列化：先校验再重建，键序固定，保证同一 packet 永远得到相同字符串。
 * 紧凑 JSON；UI 需要展示格式时自行 pretty-print。
 */
export function serializeHandoffPacket(packet: HandoffPacket): string {
  const validated = parseHandoffPacket(packet);
  const canonical = {
    version: validated.version,
    handoffId: validated.handoffId,
    createdAt: validated.createdAt,
    sourceMode: validated.sourceMode,
    destinationMode: validated.destinationMode,
    objective: validated.objective,
    context: validated.context.map((item) => ({
      id: item.id,
      label: item.label,
      content: item.content,
      sensitivity: item.sensitivity,
      included: item.included,
      inclusion: item.inclusion,
      provenance: item.provenance.map((ref) => ({ kind: ref.kind, id: ref.id })),
    })),
    sourceRefs: validated.sourceRefs.map((ref) => ({ kind: ref.kind, id: ref.id })),
    constraints: [...validated.constraints],
    permissions: [...validated.permissions],
    linkedProject: validated.linkedProject
      ? { kind: validated.linkedProject.kind, id: validated.linkedProject.id }
      : null,
    returnPolicy: validated.returnPolicy,
  };
  return JSON.stringify(canonical);
}

export function deserializeHandoffPacket(json: string): HandoffPacket {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new HandoffContractError("handoff_json_invalid", "handoff packet JSON is not parseable");
  }
  return parseHandoffPacket(value);
}

/**
 * 语义准入校验（资源与边界规则），返回确定性排序的问题列表，[] 表示干净。
 * 规则：
 * - 同模式 / 转移矩阵之外的 source→destination 拒绝；
 * - repo-write 必须附带 repo-read；
 * - included 的非 standard 上下文必须来自用户显式勾选（inclusion === "user"）；
 * - context id 不重复，context 限额（条数/字节）不超；
 * - sourceRefs 必须至少有一条（provenance 是硬要求）；
 * - linkedProject 必须是 project，且 coding→multitask 必须携带；
 * - 重复的 constraints 只提示（warning），不阻塞。
 */
export function validateHandoffPacketTransfer(packet: HandoffPacket): HandoffValidationIssue[] {
  const issues: HandoffValidationIssue[] = [];
  const { sourceMode, destinationMode } = packet;

  if (sourceMode === destinationMode) {
    issues.push({
      code: "handoff_same_mode",
      path: "destinationMode",
      message: `source and destination are both "${sourceMode}"`,
      severity: "error",
    });
  } else if (handoffDirection(sourceMode, destinationMode) === null) {
    issues.push({
      code: "handoff_transition_not_allowed",
      path: "destinationMode",
      message: `transition ${sourceMode} → ${destinationMode} is not allowed in v1`,
      severity: "error",
    });
  }

  if (packet.permissions.includes("repo-write") && !packet.permissions.includes("repo-read")) {
    issues.push({
      code: "handoff_repo_write_requires_read",
      path: "permissions",
      message: 'permission "repo-write" requires "repo-read"',
      severity: "error",
    });
  }

  packet.context.forEach((item, index) => {
    if (item.included && item.sensitivity !== "standard" && item.inclusion === "auto") {
      issues.push({
        code: "handoff_sensitive_auto_included",
        path: `context[${index}]`,
        message: `included ${item.sensitivity} context requires explicit user inclusion (inclusion must be "user")`,
        severity: "error",
      });
    }
  });

  const seenItemIds = new Map<string, number>();
  packet.context.forEach((item, index) => {
    const firstIndex = seenItemIds.get(item.id);
    if (firstIndex !== undefined) {
      issues.push({
        code: "handoff_context_item_ids_duplicated",
        path: `context[${index}].id`,
        message: `duplicate context item id "${item.id}" (first seen at context[${firstIndex}])`,
        severity: "error",
      });
      return;
    }
    seenItemIds.set(item.id, index);
  });

  issues.push(...collectHandoffContextLimitViolations(packet.context));

  if (packet.sourceRefs.length === 0) {
    issues.push({
      code: "handoff_source_refs_required",
      path: "sourceRefs",
      message: "handoff packets must carry at least one provenance source reference",
      severity: "error",
    });
  }

  if (packet.linkedProject !== null && packet.linkedProject.kind !== "project") {
    issues.push({
      code: "handoff_linked_project_kind_invalid",
      path: "linkedProject.kind",
      message: `linkedProject must reference a project (got "${packet.linkedProject.kind}")`,
      severity: "error",
    });
  }
  if (packet.linkedProject === null && sourceMode === "coding" && destinationMode === "multitask") {
    issues.push({
      code: "handoff_linked_project_required",
      path: "linkedProject",
      message: "coding→multitask handoffs must link the target project",
      severity: "error",
    });
  }

  const seenConstraints = new Set<string>();
  packet.constraints.forEach((constraint, index) => {
    if (seenConstraints.has(constraint)) {
      issues.push({
        code: "handoff_constraint_duplicated",
        path: `constraints[${index}]`,
        message: `duplicate constraint "${constraint}"`,
        severity: "warning",
      });
      return;
    }
    seenConstraints.add(constraint);
  });

  return handoffIssuesSorted(issues);
}

export function isHandoffPacketTransferable(packet: HandoffPacket): boolean {
  return validateHandoffPacketTransfer(packet).every((issue) => issue.severity !== "error");
}

/** 准入断言：存在 error 级问题时抛 HandoffContractError（携带全部问题）。 */
export function assertHandoffPacketTransferable(packet: HandoffPacket): void {
  const issues = validateHandoffPacketTransfer(packet);
  const errors = issues.filter((issue) => issue.severity === "error");
  const first = errors[0];
  if (!first) {
    return;
  }
  throw new HandoffContractError(
    first.code,
    `handoff packet is not transferable: ${errors.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    errors,
  );
}
