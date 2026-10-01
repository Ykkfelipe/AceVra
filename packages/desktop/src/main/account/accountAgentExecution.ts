import {
  executionTargetCapabilitySchema,
  zcodeExecutionTargetResultSchema,
  type AgentTaskStartedNotice,
  type ComputerSessionStartedNotice,
  type ExecutionTarget,
  type ExecutionTaskWire,
  type ExecutionTargetWire,
  type TaskView,
  type ZCodeExecutionTargetParams,
  type ZCodeExecutionTargetResult,
} from "@zcode/shared";
import type { AccountTasksApi } from "./accountTasks.js";
import { computerIdOf } from "../computers/computerJob.js";
import type { ComputersService } from "../computers/computersService.js";
import { LOCAL_TARGET_ID } from "./localProcessRunner.js";

const KNOWN_CAPABILITIES = new Set<string>(executionTargetCapabilitySchema.options);
const MAX_EVENTS = 500;

const toWireTarget = (target: ExecutionTarget): ExecutionTargetWire => ({
  id: target.id,
  type: target.type,
  displayName: target.displayName.slice(0, 200),
  online: target.online,
  // 控制面以后新增的能力不能让整个 list 校验失败；agent 只需要已知能力。
  capabilities: target.capabilities.filter((c) => KNOWN_CAPABILITIES.has(c)),
  isThisDevice: target.isThisDevice,
  available: target.available,
  ...(target.unavailableReason ? { unavailableReason: target.unavailableReason } : {}),
});

/** The agent sees the task it created; the command line is already known to it and never echoed. */
const toWireTask = (task: TaskView): ExecutionTaskWire => ({
  id: task.id,
  targetId: task.targetId,
  state: task.state,
  createdAt: String(task.createdAt),
  startedAt: task.startedAt === null ? null : String(task.startedAt),
  finishedAt: task.finishedAt === null ? null : String(task.finishedAt),
  result: task.result && typeof task.result === "object" ? task.result : null,
  lastSequence: task.lastSequence,
});

const isLocalTarget = (targetId: string) =>
  targetId === LOCAL_TARGET_ID || targetId.startsWith("local-");

/**
 * Main-side handler for the agent's `interaction/executionTarget` reverse request (M2F).
 * Pure forwarding over the existing account tasks API: Main keeps no task/session state. The only
 * side effect besides the API call is the one-shot attach notice for the conversation card.
 */
export function createAgentExecutionHandler(deps: {
  tasks: AccountTasksApi;
  computers?: Pick<ComputersService, "computerAction">;
}) {
  return async function handleAgentExecution(
    request: ZCodeExecutionTargetParams,
    notifyStarted: (notice: AgentTaskStartedNotice) => void,
    notifyComputerSession?: (notice: ComputerSessionStartedNotice) => void,
  ): Promise<ZCodeExecutionTargetResult> {
    const fail = (
      reason: Extract<ZCodeExecutionTargetResult, { ok: false }>["reason"],
      detail?: string,
    ): ZCodeExecutionTargetResult => ({
      op: request.op,
      ok: false,
      reason,
      ...(detail ? { detail } : {}),
    });
    let result: ZCodeExecutionTargetResult;
    try {
      switch (request.op) {
        case "list": {
          const targets = await deps.tasks.listTargets();
          result = { op: "list", ok: true, targets: targets.slice(0, 64).map(toWireTarget) };
          break;
        }
        case "start": {
          // 本机目标走 Bash 原路径；agent 路径绝不在这里起本地进程（避免两条本地执行写路径）。
          if (isLocalTarget(request.targetId)) return fail("target_is_local");
          const started = await deps.tasks.startRemoteProcess({
            targetId: request.targetId,
            process: request.process,
            ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
          });
          if (!started.ok) {
            return started.reason === "unavailable"
              ? fail("unavailable", "account_api_unreachable")
              : fail(started.reason, started.detail);
          }
          notifyStarted({
            sessionId: request.sessionId,
            taskId: started.taskId,
            targetId: started.targetId,
          });
          result = { op: "start", ok: true, taskId: started.taskId, targetId: started.targetId };
          break;
        }
        case "read": {
          const task = await deps.tasks.getTask(request.taskId);
          if (!task) return fail("task_not_found");
          const events = await deps.tasks.getTaskEvents(request.taskId, request.after);
          result = {
            op: "read",
            ok: true,
            task: toWireTask(task),
            events: events.slice(0, MAX_EVENTS).map((event) => ({
              sequence: event.sequence,
              type: event.type,
              ts: String(event.ts),
              payload: event.payload ?? {},
            })),
          };
          break;
        }
        case "cancel": {
          const task = await deps.tasks.cancelTask(request.taskId, request.force === true);
          if (!task) return fail("task_not_found");
          result = { op: "cancel", ok: true, task: toWireTask(task) };
          break;
        }
        case "computer": {
          // SSH 电脑的 GUI 动作；本机目标不走这里（本机 Computer Use 不变），离线如实失败不回落本机。
          if (isLocalTarget(request.targetId)) return fail("target_is_local");
          if (!deps.computers) return fail("unavailable");
          const outcome = await deps.computers.computerAction({
            sessionId: request.sessionId,
            targetId: request.targetId,
            action: request.action,
          });
          if (!outcome.ok) return fail(outcome.reason, outcome.detail);
          const computerId = computerIdOf(request.targetId);
          if (outcome.sessionStarted && computerId) {
            notifyComputerSession?.({ sessionId: request.sessionId, computerId });
          }
          result = {
            op: "computer",
            ok: true,
            screen: outcome.screen,
            ...(outcome.image ? { image: outcome.image } : {}),
          };
          break;
        }
      }
    } catch {
      return fail("internal");
    }
    // 出站同样严格校验：控制面返回异常形状时如实报 internal，不把坏数据交给 agent。
    return zcodeExecutionTargetResultSchema.safeParse(result).success
      ? result
      : fail("internal", "malformed_response");
  };
}
