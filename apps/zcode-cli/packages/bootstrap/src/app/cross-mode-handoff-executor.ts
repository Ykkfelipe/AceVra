import type { ToolCall } from "@zcode/contracts";
import type {
  ExecuteToolsOptions,
  ExecuteToolsResult,
  ToolSchedule,
} from "@zcode/core";
import {
  buildMultitaskHandoffSubmission,
  type MultitaskHandoffPlan,
} from "@zcode/core";
import type { HandoffExecutionPort } from "@zcode/shared/cross-mode";

// Cross-Mode → Multitask 的生产执行方（HandoffExecutionPort）。
//
// 职责边界（与冻结契约、集成交接文档 docs/roadmap/cross-mode-multitask-integration-handoff.md 对齐）：
// - 本执行方只做一件事：把「已验证的冻结 packet + 一次提交绑定」经 Multitask 采纳适配器映射为
//   Multitask 提交，然后沿目标会话 runtime **既有的**工具执行路径提交
//   （runtime.scheduleTools / runtime.executeTools —— 与模型工具调用完全同一条运行确认、
//   run 生命周期、后台任务登记与完成通知路径）。
// - 它不写 handoff 记录（Cross-Mode 准入服务独占），不碰 run 生命周期（Workflow/Multitask 独占），
//   也不复制任何一侧的状态；失败只回可展示短原因，成功只回外部引用。
// - 返回形状与集成 harness 的参考形状一致：accepted(multitask-run) / rejected(<code>: <message>)。

/** 一次 handoff → 运行提交的绑定：计划（冻结 packet 不携带图结构）+ 该次初始化的 trace。 */
export interface MultitaskHandoffExecutionBinding {
  readonly plan: MultitaskHandoffPlan;
  readonly traceContext?: import("@zcode/contracts").TraceContext;
}

/**
 * 执行方需要的最小 runtime 面：提交一次工具调用所走的两步。AgentRuntime 的结构子集，
 * 生产传真实 runtime；测试传具备相同语义的宿主。
 */
export interface CrossModeHandoffSubmissionHost {
  scheduleTools(toolCalls: ToolCall[]): Promise<ToolSchedule>;
  executeTools(
    toolCalls: ToolCall[],
    schedule: ToolSchedule,
    options?: ExecuteToolsOptions,
  ): Promise<ExecuteToolsResult>;
}

/** 会话正忙（有活动 turn）时不得从宿主外提交——抛此错，执行方归一为 rejected 原因。 */
export class MultitaskHandoffSessionBusyError extends Error {
  constructor() {
    super("session_busy: an active turn is running; retry the handoff when the session is idle");
    this.name = "MultitaskHandoffSessionBusyError";
  }
}

export interface MultitaskHandoffExecutionDeps {
  readonly host: CrossModeHandoffSubmissionHost;
  /** 读取该 handoff 的提交绑定；缺席 = 未经 initiation 就执行，按 rejected 处理。 */
  readonly getBinding: (handoffId: string) => MultitaskHandoffExecutionBinding | undefined;
  /** 提交被接受后释放绑定（重试失败的提交仍可用同一绑定）。 */
  readonly releaseBinding: (handoffId: string) => void;
}

/** "Multitask did not start: <code>: <message>" —— 与集成 harness 相同的可展示短原因形状。 */
export function formatMultitaskStartFailure(
  error: { code?: string; message?: string } | undefined,
): string {
  return `Multitask did not start: ${error?.code ?? "error"}: ${error?.message ?? "unknown"}`.slice(
    0,
    200,
  );
}

function readBackgroundTaskId(output: unknown): string | undefined {
  if (typeof output !== "object" || output === null) {
    return undefined;
  }
  const id = (output as { backgroundTaskId?: unknown }).backgroundTaskId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * 生产 HandoffExecutionPort（Coding → Multitask）。
 *
 * 提交唯一路径：采纳适配器（权限闸门）→ 目标会话 runtime 工具执行器（运行确认、
 * run 登记）→ `{kind:"multitask-run", id: backgroundTaskId}`。
 */
export function createMultitaskHandoffExecutionPort(
  deps: MultitaskHandoffExecutionDeps,
): HandoffExecutionPort {
  return {
    async execute({ packet }) {
      const binding = deps.getBinding(packet.handoffId);
      if (!binding) {
        return { status: "rejected", reason: "multitask_handoff_binding_missing" };
      }

      const built = buildMultitaskHandoffSubmission(packet, binding.plan);
      if (!built.ok) {
        return {
          status: "rejected",
          reason: built.issues.map((issue) => issue.code).join(", "),
        };
      }

      const toolCall: ToolCall = {
        id: `handoff-${packet.handoffId}`,
        name: "Multitask",
        input: built.submission.input,
      };

      let result: ExecuteToolsResult["results"][number] | undefined;
      try {
        const schedule = await deps.host.scheduleTools([toolCall]);
        const execution = await deps.host.executeTools(
          [toolCall],
          schedule,
          binding.traceContext ? { traceContext: binding.traceContext } : {},
        );
        result = execution.results[0];
      } catch (error) {
        if (error instanceof MultitaskHandoffSessionBusyError) {
          return { status: "rejected", reason: error.message };
        }
        return {
          status: "rejected",
          reason: `Multitask did not start: submit_error: ${
            error instanceof Error ? error.message : String(error)
          }`.slice(0, 200),
        };
      }

      if (!result || !result.success) {
        return { status: "rejected", reason: formatMultitaskStartFailure(result?.error) };
      }

      const backgroundTaskId = readBackgroundTaskId(result.output);
      if (!backgroundTaskId) {
        return {
          status: "rejected",
          reason:
            "Multitask did not start: missing_background_task_id: tool reported success without a run id",
        };
      }

      deps.releaseBinding(packet.handoffId);
      return {
        status: "accepted",
        externalRef: { kind: "multitask-run", id: backgroundTaskId },
        displayName: built.submission.input.name,
      };
    },
  };
}
