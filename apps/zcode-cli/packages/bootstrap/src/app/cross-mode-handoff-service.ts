import {
  beginHandoffPreview,
  confirmHandoffPreview,
  createHandoffAdmissionService,
  createHandoffContextItem,
  createHandoffPacket,
  deserializeHandoffPacket,
  HandoffFlowError,
  type HandoffAdmissionRecord,
  type HandoffAdmissionStore,
  type HandoffConfirmation,
  type HandoffContextSensitivity,
  type HandoffObjectRef,
  type HandoffPacket,
  type HandoffPermission,
  type HandoffReturnPolicy,
  type HandoffReturnStatus,
  type HandoffReturnSummary,
} from "@zcode/shared/cross-mode";
import { buildMultitaskHandoffReturn, type MultitaskHandoffPlan } from "@zcode/core";
import type { TraceContext } from "@zcode/contracts";
import {
  createMultitaskHandoffExecutionPort,
  type CrossModeHandoffSubmissionHost,
  type MultitaskHandoffExecutionBinding,
} from "./cross-mode-handoff-executor.js";

// Cross-Mode handoff 服务（生产，Coding → Multitask）：
// - 持有唯一的准入服务实例（handoff 记录的独占所有者：admission / retries / returns）；
// - 持有 initiation 事务的提交绑定（plan + trace；冻结 packet 不携带图结构）；
// - 拥有「Multitask run 终态 → 冻结返回状态」的规范映射（集成逻辑，不属于冻结契约）。
// 本文件不碰 run 生命周期、不创建会话/工作区、不复制任何一侧状态。

/** initiation 输入里的上下文条目草案（在服务内用冻结契约的 owner 归一/校验）。 */
export interface MultitaskHandoffContextItemDraft {
  readonly label: string;
  readonly content: string;
  readonly sensitivity?: HandoffContextSensitivity;
  readonly provenance?: readonly HandoffObjectRef[];
}

export interface MultitaskHandoffStartRequest {
  /** 发起会话（Coding session）；写入 sourceRefs。 */
  readonly sessionId: string;
  readonly objective: string;
  readonly context?: readonly MultitaskHandoffContextItemDraft[];
  readonly constraints?: readonly string[];
  readonly permissions?: readonly HandoffPermission[];
  /** 缺省 "summary-and-artifacts"。 */
  readonly returnPolicy?: HandoffReturnPolicy;
  /** coding → multitask 的冻结准入要求关联项目；缺失会被冻结校验拒绝。 */
  readonly linkedProject?: HandoffObjectRef | null;
  /** destination 协调方提供的 worker/task 图。 */
  readonly plan: MultitaskHandoffPlan;
  readonly traceContext?: TraceContext;
}

export type MultitaskHandoffStartOutcome =
  | {
      readonly ok: true;
      readonly confirmation: HandoffConfirmation;
      readonly record: HandoffAdmissionRecord;
    }
  | { readonly ok: false; readonly reason: "invalid_input"; readonly message: string };

/** Multitask run 的终态读面（Workflow run detail 的窄视图；只读，不复制）。 */
export interface MultitaskHandoffRunOutcomeSource {
  readonly runId: string;
  /** Workflow run 终态：completed / stopped / failed(errored) / ... */
  readonly runStatus: string;
  /** 逐任务报告条目：`{ [taskId]: { task, outcome } }`（M2 报告面的窄视图）。 */
  readonly tasks: Readonly<Record<string, { readonly task: string; readonly outcome: string }>>;
}

export interface CrossModeMultitaskHandoffServiceOptions {
  readonly host: CrossModeHandoffSubmissionHost;
  readonly store?: HandoffAdmissionStore;
  readonly now?: () => number;
}

export interface CrossModeMultitaskHandoffService {
  /** 发起一次 Coding → Multitask handoff：冻结快照 → 准入 → 执行（经运行确认闸门）。 */
  start(request: MultitaskHandoffStartRequest): Promise<MultitaskHandoffStartOutcome>;
  /** 重试一次被拒的 handoff（Cross-Mode 的 attempts 语义：目标恢复 / 用户重新确认后）。 */
  retry(handoffId: string): Promise<HandoffAdmissionRecord>;
  get(handoffId: string): Promise<HandoffAdmissionRecord | null>;
  list(): Promise<HandoffAdmissionRecord[]>;
  /** run → handoff 反查（结算自动回流用；只有 accepted 过的 run 在表中）。 */
  handoffForRun(runId: string): string | undefined;
  /** 只映射不落账：run 终态 → 冻结返回摘要（returnPolicy none ⇒ null）。 */
  returnFromRun(
    handoffId: string,
    run: MultitaskHandoffRunOutcomeSource,
  ): Promise<HandoffReturnSummary | null>;
  /** returnFromRun + recordReturn；no-return 策略时为 no-op（null，不落账）。 */
  completeFromRun(
    handoffId: string,
    run: MultitaskHandoffRunOutcomeSource,
  ): Promise<HandoffAdmissionRecord | null>;
}

/**
 * 「Multitask run 终态 → 冻结返回状态」的规范映射（canonical owner：本服务）。
 *
 * 规则（集成逻辑，不属于冻结契约；参考集成 harness 的 returnFromRun）：
 * - run completed 且全部任务 `done` → `completed`；
 * - run completed 但有未竟任务（blocked / skipped / unverified / failed / ...）→ `partial`，
 *   未竟项进 `unresolved` —— partial 绝不升级为 completed；
 * - run stopped → `cancelled`；run failed/errored → `failed`；其余终态按 `cancelled` 保守处理；
 * - `returnPolicy: none` → null（不产生自动回流）。
 */
export function buildMultitaskHandoffReturnFromRun(
  packet: HandoffPacket,
  run: MultitaskHandoffRunOutcomeSource,
): HandoffReturnSummary | null {
  const entries = Object.values(run.tasks);
  const unfinished = entries.filter((entry) => entry.outcome !== "done");
  const status: HandoffReturnStatus =
    run.runStatus === "completed"
      ? unfinished.length === 0
        ? "completed"
        : "partial"
      : run.runStatus === "failed" || run.runStatus === "errored"
        ? "failed"
        : "cancelled";
  return buildMultitaskHandoffReturn(packet, {
    status,
    summary: `${entries.length - unfinished.length}/${entries.length} tasks done`,
    unresolved: unfinished.map((entry) => ({ text: `${entry.task}: ${entry.outcome}` })),
    artifacts: [{ kind: "multitask-run", id: run.runId }],
  });
}

/** 从 Workflow run 顶层返回值（M2 降级脚本的报告产物）防御性提取 `{ [taskId]: {task, outcome} }`。 */
export function readMultitaskRunTasks(
  result: unknown,
): Record<string, { task: string; outcome: string }> {
  if (typeof result !== "object" || result === null) {
    return {};
  }
  const tasks: Record<string, { task: string; outcome: string }> = {};
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) {
      continue;
    }
    const task = (value as { task?: unknown }).task;
    const outcome = (value as { outcome?: unknown }).outcome;
    if (typeof task === "string" && typeof outcome === "string") {
      tasks[key] = { task, outcome };
    }
  }
  return tasks;
}

export function createCrossModeMultitaskHandoffService(
  options: CrossModeMultitaskHandoffServiceOptions,
): CrossModeMultitaskHandoffService {
  const now = options.now ?? (() => Date.now());
  const bindings = new Map<string, MultitaskHandoffExecutionBinding>();
  const confirmations = new Map<string, HandoffConfirmation>();
  const runsToHandoffs = new Map<string, string>();

  const execution = createMultitaskHandoffExecutionPort({
    host: options.host,
    getBinding: (handoffId) => bindings.get(handoffId),
    releaseBinding: (handoffId) => {
      bindings.delete(handoffId);
    },
  });
  const admission = createHandoffAdmissionService({
    execution,
    ...(options.store ? { store: options.store } : {}),
    now,
  });

  async function packetFromConfirmation(handoffId: string): Promise<HandoffPacket> {
    const confirmation = confirmations.get(handoffId);
    if (!confirmation) {
      throw new HandoffFlowError(
        "handoff_flow_unknown_handoff",
        `no handoff confirmation for ${handoffId}`,
      );
    }
    return deserializeHandoffPacket(confirmation.packetJson);
  }

  const returnFromRun = async (
    handoffId: string,
    run: MultitaskHandoffRunOutcomeSource,
  ): Promise<HandoffReturnSummary | null> => {
    const packet = await packetFromConfirmation(handoffId);
    return buildMultitaskHandoffReturnFromRun(packet, run);
  };

  const completeFromRun = async (
    handoffId: string,
    run: MultitaskHandoffRunOutcomeSource,
  ): Promise<HandoffAdmissionRecord | null> => {
    const summary = await returnFromRun(handoffId, run);
    if (!summary) {
      return null;
    }
    return admission.recordReturn(summary);
  };

  return {
    async start(request) {
      let packet: HandoffPacket;
      try {
        packet = createHandoffPacket({
          sourceMode: "coding",
          destinationMode: "multitask",
          objective: request.objective,
          returnPolicy: request.returnPolicy ?? "summary-and-artifacts",
          sourceRefs: [{ kind: "coding-session", id: request.sessionId }],
          linkedProject: request.linkedProject ?? null,
          permissions: [...(request.permissions ?? [])],
          constraints: [...(request.constraints ?? [])],
          context: (request.context ?? []).map((item) =>
            createHandoffContextItem({
              label: item.label,
              content: item.content,
              ...(item.sensitivity === undefined ? {} : { sensitivity: item.sensitivity }),
              ...(item.provenance === undefined ? {} : { provenance: [...item.provenance] }),
            }),
          ),
        });
      } catch (error) {
        return {
          ok: false,
          reason: "invalid_input",
          message: error instanceof Error ? error.message : String(error),
        };
      }

      const confirmed = confirmHandoffPreview(beginHandoffPreview(packet, now()), now());
      if (!confirmed.ok) {
        return {
          ok: false,
          reason: "invalid_input",
          message: confirmed.issues
            .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
            .join("; "),
        };
      }
      const confirmation = confirmed.session.confirmation;
      if (!confirmation) {
        return { ok: false, reason: "invalid_input", message: "confirmation snapshot missing" };
      }

      bindings.set(packet.handoffId, {
        plan: request.plan,
        ...(request.traceContext === undefined ? {} : { traceContext: request.traceContext }),
      });
      confirmations.set(packet.handoffId, confirmation);

      const record = await admission.admit(confirmation);
      if (record.status === "accepted" && record.externalRef) {
        runsToHandoffs.set(record.externalRef.id, record.handoffId);
      }
      return { ok: true, confirmation, record };
    },

    async retry(handoffId) {
      const confirmation = confirmations.get(handoffId);
      if (!confirmation) {
        throw new HandoffFlowError(
          "handoff_flow_unknown_handoff",
          `no handoff confirmation for ${handoffId}`,
        );
      }
      const record = await admission.admit(confirmation);
      if (record.status === "accepted" && record.externalRef) {
        runsToHandoffs.set(record.externalRef.id, record.handoffId);
      }
      return record;
    },

    get(handoffId) {
      return admission.get(handoffId);
    },

    list() {
      return admission.list();
    },

    handoffForRun(runId) {
      return runsToHandoffs.get(runId);
    },

    returnFromRun,

    completeFromRun,
  };
}
