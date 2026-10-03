import { MultitaskInputSchema, type MultitaskInput } from "@zcode/contracts";
import {
  handoffObjectRefKey,
  validateHandoffPacketTransfer,
  type HandoffObjectRef,
  type HandoffPacket,
  type HandoffReturnPolicy,
  type HandoffValidationIssue,
} from "@zcode/shared/cross-mode";

// Cross-Mode 采纳层（Multitask 侧）：把冻结的 HandoffPacket 映射进 Multitask M1 提交面。
// 契约的唯一来源是 @zcode/shared/cross-mode（b5b4ca1 快照）：
// 本文件不重新定义任何契约类型、上限或校验规则，只做目标侧字段映射与准入前置检查。

export const MULTITASK_HANDOFF_ISSUE_CODES = [
  "multitask_handoff_wrong_flow",
  "multitask_handoff_not_transferable",
  "multitask_handoff_permission_denied",
  "multitask_handoff_plan_invalid",
] as const;
export type MultitaskHandoffIssueCode = (typeof MULTITASK_HANDOFF_ISSUE_CODES)[number];

export interface MultitaskHandoffIssue {
  readonly code: MultitaskHandoffIssueCode;
  readonly path: string;
  readonly message: string;
  /** not_transferable 时透传冻结契约的问题列表（便于调用方映射与展示）。 */
  readonly packetIssues?: readonly HandoffValidationIssue[];
}

export type MultitaskHandoffWorker = MultitaskInput["workers"][number];
export type MultitaskHandoffTask = MultitaskInput["tasks"][number];

/** destination 侧提交计划：worker/task 图由 Multitask 协调方提供（冻结契约不携带图结构）。 */
export interface MultitaskHandoffPlan {
  readonly name?: string;
  readonly workers: readonly MultitaskHandoffWorker[];
  readonly tasks: readonly MultitaskHandoffTask[];
}

/** 可直接送交 Multitask 工具准入的提交输入（script / max_concurrency 由既有准入生成）。 */
export interface MultitaskHandoffSubmission {
  readonly input: MultitaskInput;
  readonly handoffId: string;
  readonly linkedProject: HandoffObjectRef | null;
  readonly returnPolicy: HandoffReturnPolicy;
  readonly sourceRefs: readonly HandoffObjectRef[];
}

export type MultitaskHandoffBuildResult =
  | { ok: true; submission: MultitaskHandoffSubmission }
  | { ok: false; issues: MultitaskHandoffIssue[] };

/** 运行名：确定性派生自 objective（≤120 字符），可由计划显式覆盖。 */
export function deriveHandoffRunName(packet: HandoffPacket): string {
  const compact = packet.objective.replace(/\s+/g, " ").trim();
  const head = compact.length > 100 ? `${compact.slice(0, 99)}…` : compact;
  return `Handoff: ${head}`;
}

/**
 * worker 共享上下文（确定性渲染）：handoff 头 + 来源引用 + 关联项目 +
 * 仅 included 的上下文项 + 约束。被排除的项绝不进入运行上下文（least-context 边界）。
 */
export function renderHandoffSharedContext(packet: HandoffPacket): string {
  const lines: string[] = [
    `Cross-mode handoff ${packet.handoffId} (${packet.sourceMode} → ${packet.destinationMode})`,
    `Source refs: ${packet.sourceRefs.map(handoffObjectRefKey).join(", ")}`,
  ];
  if (packet.linkedProject) {
    lines.push(`Linked project: ${handoffObjectRefKey(packet.linkedProject)}`);
  }
  const included = packet.context.filter((item) => item.included);
  if (included.length > 0) {
    lines.push("Context to carry:");
    for (const item of included) {
      const marker = item.sensitivity === "standard" ? "" : ` (${item.sensitivity})`;
      lines.push(`- ${item.label}${marker}: ${item.content}`);
    }
  }
  if (packet.constraints.length > 0) {
    lines.push("Constraints:");
    for (const constraint of packet.constraints) {
      lines.push(`- ${constraint}`);
    }
  }
  return lines.join("\n");
}

/**
 * 把 Coding → Multitask 的 HandoffPacket 映射为 Multitask M1 提交：
 * - 复用冻结契约的 transfer 校验（项目关联、权限、预算、来源引用）；
 * - 权限按最小授予映射到 worker access：reader 需要 repo-read；writer 需要 repo-read + repo-write；
 * - 合成 completed 提交输入并通过 MultitaskInputSchema 结构校验。
 * 图语义（重复 ID、依赖、环路、未分配 worker）仍由既有准入（buildMultitaskScript）负责，本层不重复实现。
 */
export function buildMultitaskHandoffSubmission(
  packet: HandoffPacket,
  plan: MultitaskHandoffPlan,
): MultitaskHandoffBuildResult {
  if (packet.sourceMode !== "coding" || packet.destinationMode !== "multitask") {
    return {
      ok: false,
      issues: [
        {
          code: "multitask_handoff_wrong_flow",
          path: "destinationMode",
          message: `expected a coding → multitask handoff, got ${packet.sourceMode} → ${packet.destinationMode}`,
        },
      ],
    };
  }

  const packetErrors = validateHandoffPacketTransfer(packet).filter(
    (issue) => issue.severity === "error",
  );
  if (packetErrors.length > 0) {
    return {
      ok: false,
      issues: [
        {
          code: "multitask_handoff_not_transferable",
          path: "packet",
          message: "handoff packet does not pass cross-mode transfer admission",
          packetIssues: packetErrors,
        },
      ],
    };
  }

  const grants = new Set(packet.permissions);
  const permissionIssues = plan.workers.flatMap((worker, index): MultitaskHandoffIssue[] => {
    if (worker.access === "write") {
      if (!grants.has("repo-read") || !grants.has("repo-write")) {
        return [
          {
            code: "multitask_handoff_permission_denied",
            path: `workers[${index}].access`,
            message: `write worker "${worker.id}" requires both repo-read and repo-write permissions`,
          },
        ];
      }
      return [];
    }
    return grants.has("repo-read")
      ? []
      : [
          {
            code: "multitask_handoff_permission_denied",
            path: `workers[${index}].access`,
            message: `worker "${worker.id}" requires the repo-read permission`,
          },
        ];
  });
  if (permissionIssues.length > 0) {
    return { ok: false, issues: permissionIssues };
  }

  const candidate = {
    name: plan.name ?? deriveHandoffRunName(packet),
    objective: packet.objective,
    sharedContext: renderHandoffSharedContext(packet),
    workers: [...plan.workers],
    tasks: [...plan.tasks],
  };
  const parsed = MultitaskInputSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      issues: [
        {
          code: "multitask_handoff_plan_invalid",
          path: "",
          message: parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
            .join("; "),
        },
      ],
    };
  }

  return {
    ok: true,
    submission: {
      input: parsed.data,
      handoffId: packet.handoffId,
      linkedProject: packet.linkedProject,
      returnPolicy: packet.returnPolicy,
      sourceRefs: [...packet.sourceRefs],
    },
  };
}
