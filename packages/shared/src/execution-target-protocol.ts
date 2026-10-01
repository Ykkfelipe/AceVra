import { z } from "zod";

/**
 * M2F：agent 执行工具路由到 Run-on 目标的线协议（packages/desktop/specs/acevra-agent-execution-m2f.md）。
 * 复用 account.ts 的 ExecutionTarget / TaskView / TaskEvent 语义；这里只做严格的运行时校验。
 */

const idString = z.string().trim().min(1).max(128);
const shortText = z.string().max(200);

/** v4 sendText / createSession.firstInput 携带的 Run-on 选择；缺省 = 会话已有选择不变。 */
export const submissionExecutionTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("automatic") }).strict(),
  z
    .object({
      kind: z.literal("target"),
      targetId: idString,
      displayName: z.string().trim().min(1).max(120).optional(),
    })
    .strict(),
]);
export type SubmissionExecutionTarget = z.infer<typeof submissionExecutionTargetSchema>;

export const executionTaskStateSchema = z.enum([
  "queued",
  "dispatching",
  "running",
  "running_unknown",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
]);

export const executionTargetCapabilitySchema = z.enum([
  "computerUse",
  "shell",
  "files",
  "git",
  "longTasks",
  "minecraft",
]);

export const executionTargetWireSchema = z
  .object({
    id: idString,
    type: z.enum(["desktop", "node", "ssh"]),
    displayName: shortText,
    online: z.boolean(),
    capabilities: z.array(executionTargetCapabilitySchema).max(16),
    isThisDevice: z.boolean(),
    available: z.boolean(),
    unavailableReason: z
      .enum(["offline", "no_shell_service", "remote_desktop_unsupported"])
      .optional(),
  })
  .strict();

export const executionTaskWireSchema = z
  .object({
    id: idString,
    targetId: idString,
    state: executionTaskStateSchema,
    createdAt: shortText,
    startedAt: shortText.nullable(),
    finishedAt: shortText.nullable(),
    result: z.record(z.string(), z.unknown()).nullable(),
    lastSequence: z.number().int().nonnegative(),
  })
  .strict();

export const executionTaskEventWireSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    type: z.string().min(1).max(64),
    ts: shortText,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

/** 与 account-api processSpec 同一组上限；超限在 agent 侧即拒绝，不浪费一次往返。 */
export const executionProcessSpecSchema = z
  .object({
    executable: z.string().min(1).max(260),
    args: z.array(z.string().max(2048)).max(64).optional(),
    cwd: z.string().min(1).max(512),
    env: z.record(z.string().min(1).max(128), z.string().max(4096)).optional(),
    timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
  })
  .strict();

const coordinate = z.number().int().min(0).max(16_384);
const mouseButton = z.enum(["left", "right", "middle"]);

/**
 * SSH 电脑的 GUI 动作（acevra-agent-computer.md §5）。坐标是远端屏幕像素；Main 映射到 worker API。
 * 本机 Computer Use 不走这里（本机 SDK 不变）。
 */
export const computerActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("screenshot") }).strict(),
  z
    .object({
      kind: z.literal("click"),
      x: coordinate,
      y: coordinate,
      button: mouseButton.optional(),
      double: z.boolean().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("move"), x: coordinate, y: coordinate }).strict(),
  z
    .object({
      kind: z.literal("drag"),
      fromX: coordinate,
      fromY: coordinate,
      toX: coordinate,
      toY: coordinate,
    })
    .strict(),
  z
    .object({
      kind: z.literal("scroll"),
      x: coordinate.optional(),
      y: coordinate.optional(),
      dy: z.number().int().min(-50).max(50),
    })
    .strict(),
  z.object({ kind: z.literal("type"), text: z.string().min(1).max(2000) }).strict(),
  z
    .object({
      kind: z.literal("key"),
      keys: z
        .array(
          z
            .string()
            .min(1)
            .max(24)
            .regex(/^[a-z0-9]+$/),
        )
        .min(1)
        .max(4),
    })
    .strict(),
]);
export type ComputerAction = z.infer<typeof computerActionSchema>;

export const computerImageSchema = z
  .object({
    base64: z.string().min(1).max(8_000_000),
    mimeType: z.enum(["image/jpeg", "image/png"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
export type ComputerImage = z.infer<typeof computerImageSchema>;

const requestBase = {
  requestId: idString,
  sessionId: idString,
  turnId: idString.optional(),
  toolCallId: idString.optional(),
  workspacePath: z.string().min(1).max(4096),
  workspaceIdentity: z.string().min(1).max(4096).optional(),
};

export const zcodeExecutionTargetParamsSchema = z.discriminatedUnion("op", [
  z.object({ ...requestBase, op: z.literal("list") }).strict(),
  z
    .object({
      ...requestBase,
      op: z.literal("start"),
      targetId: idString,
      process: executionProcessSpecSchema,
      idempotencyKey: z
        .string()
        .regex(/^[A-Za-z0-9_.-]{1,64}$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      op: z.literal("read"),
      taskId: idString,
      after: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      op: z.literal("cancel"),
      taskId: idString,
      force: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      op: z.literal("computer"),
      targetId: idString,
      action: computerActionSchema,
    })
    .strict(),
]);
export type ZCodeExecutionTargetParams = z.infer<typeof zcodeExecutionTargetParamsSchema>;
export type ZCodeExecutionTargetOp = ZCodeExecutionTargetParams["op"];

export const executionTargetFailureReasonSchema = z.enum([
  /** host 没有 executor（Web/远程 workspace/旧 host）或账号模块未初始化。 */
  "unavailable",
  "not_signed_in",
  "invalid_request",
  "target_not_found",
  /** detail 携带控制面原因：target_offline / target_revoked / target_not_node / target_lacks_shell。 */
  "target_unavailable",
  "target_is_local",
  "task_not_found",
  "timeout",
  "internal",
  /** SSH 电脑：用户接管 / 用户在那台电脑上操作 / 已暂停；detail = worker 原因。 */
  "computer_paused",
  /** SSH 电脑正被另一个会话或面板占用。 */
  "computer_busy",
  /** 隧道或 worker 不可达；绝不改在本机执行。 */
  "computer_offline",
]);
export type ExecutionTargetFailureReason = z.infer<typeof executionTargetFailureReasonSchema>;

export const zcodeExecutionTargetResultSchema = z.union([
  z
    .object({
      op: z.enum(["list", "start", "read", "cancel", "computer"]),
      ok: z.literal(false),
      reason: executionTargetFailureReasonSchema,
      detail: shortText.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("list"),
      ok: z.literal(true),
      targets: z.array(executionTargetWireSchema).max(64),
    })
    .strict(),
  z
    .object({ op: z.literal("start"), ok: z.literal(true), taskId: idString, targetId: idString })
    .strict(),
  z
    .object({
      op: z.literal("read"),
      ok: z.literal(true),
      task: executionTaskWireSchema,
      events: z.array(executionTaskEventWireSchema).max(500),
    })
    .strict(),
  z
    .object({ op: z.literal("cancel"), ok: z.literal(true), task: executionTaskWireSchema })
    .strict(),
  z
    .object({
      op: z.literal("computer"),
      ok: z.literal(true),
      screen: z.object({ width: z.number().int(), height: z.number().int() }).strict(),
      image: computerImageSchema.optional(),
    })
    .strict(),
]);
export type ZCodeExecutionTargetResult = z.infer<typeof zcodeExecutionTargetResultSchema>;
export type ExecutionTargetWire = z.infer<typeof executionTargetWireSchema>;
export type ExecutionTaskWire = z.infer<typeof executionTaskWireSchema>;
export type ExecutionTaskEventWire = z.infer<typeof executionTaskEventWireSchema>;

/** Main → renderer：agent 启动的任务挂到其会话卡片（只是附着通知，不是任务事实）。 */
export const agentTaskStartedNoticeSchema = z
  .object({ sessionId: idString, taskId: idString, targetId: idString })
  .strict();
export type AgentTaskStartedNotice = z.infer<typeof agentTaskStartedNoticeSchema>;

/** Main → renderer：会话首次在 SSH 电脑上执行 Computer 动作（渲染端据此打开一次 Computer tab）。 */
export const computerSessionStartedNoticeSchema = z
  .object({ sessionId: idString, computerId: idString })
  .strict();
export type ComputerSessionStartedNotice = z.infer<typeof computerSessionStartedNoticeSchema>;

/** Host 注入给 services 的执行目标执行器（Desktop：经 parentPort 转 Main）。缺省 = 能力不存在。 */
export interface ExecutionTargetExecutor {
  execute(request: ZCodeExecutionTargetParams): Promise<ZCodeExecutionTargetResult>;
}
