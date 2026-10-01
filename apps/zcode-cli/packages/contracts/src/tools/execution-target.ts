// ============================================================
// Execution target tools - run processes on the user's other computers (M2F)
// ============================================================
// 只路由进程执行：文件/Computer/浏览器工具仍在本机。上限与 account-api processSpec 一致，
// 超限在 schema 层即拒绝。cwd 是节点上的绝对路径，绝不缺省为本机 workspace。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const EXECUTION_TARGETS_TOOL_NAME = "ExecutionTargets";
export const RUN_ON_TARGET_TOOL_NAME = "RunOnTarget";
export const TARGET_TASK_TOOL_NAME = "TargetTask";

export const RUN_ON_TARGET_DEFAULT_WAIT_SECONDS = 60;
export const RUN_ON_TARGET_MAX_WAIT_SECONDS = 300;

export const ExecutionTargetsInputSchema = z.object({}).strict();
export type ExecutionTargetsInput = z.infer<typeof ExecutionTargetsInputSchema>;
export const ExecutionTargetsInputJsonSchema = toToolJsonSchema(ExecutionTargetsInputSchema);

const waitSeconds = z
  .number()
  .int()
  .min(0)
  .max(RUN_ON_TARGET_MAX_WAIT_SECONDS)
  .optional()
  .describe(
    `How long to wait for the task to finish before returning (default ${RUN_ON_TARGET_DEFAULT_WAIT_SECONDS}, max ${RUN_ON_TARGET_MAX_WAIT_SECONDS}). If it is still running you get a taskId; the user sees live progress and a Stop button in the conversation.`,
  );

export const RunOnTargetInputSchema = z
  .object({
    targetId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .describe("Target id from ExecutionTargets (never a display name)."),
    executable: z
      .string()
      .min(1)
      .max(260)
      .describe(
        "Program to run on the target, e.g. 'pnpm', 'git', 'bash'. No shell is involved; use executable 'bash' with args ['-lc', '<script>'] when you need shell syntax.",
      ),
    args: z.array(z.string().max(2048)).max(64).optional().describe("Arguments, one per item."),
    cwd: z
      .string()
      .min(1)
      .max(512)
      .describe(
        "Absolute working directory ON THE TARGET, inside a root the target allows (acevra-node --allow-root). This Mac's workspace path does not exist there.",
      ),
    env: z
      .record(z.string().min(1).max(128), z.string().max(4096))
      .optional()
      .describe("Extra environment variables (no secrets)."),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(3600)
      .optional()
      .describe("Hard limit after which the target kills the process (default 600)."),
    waitSeconds,
  })
  .strict();
export type RunOnTargetInput = z.infer<typeof RunOnTargetInputSchema>;
export const RunOnTargetInputJsonSchema = toToolJsonSchema(RunOnTargetInputSchema);

export const TargetTaskInputSchema = z
  .object({
    taskId: z.string().trim().min(1).max(128).describe("taskId returned by RunOnTarget."),
    action: z
      .enum(["wait", "stop"])
      .describe("'wait' for more output/completion, 'stop' to cancel the task on the target."),
    waitSeconds,
  })
  .strict();
export type TargetTaskInput = z.infer<typeof TargetTaskInputSchema>;
export const TargetTaskInputJsonSchema = toToolJsonSchema(TargetTaskInputSchema);

export const TargetTaskResultSchema = z
  .object({
    taskId: z.string(),
    targetId: z.string(),
    targetName: z.string().optional(),
    state: z.string(),
    finished: z.boolean(),
    exitCode: z.number().optional(),
    reason: z.string().optional(),
    output: z.string(),
    outputTruncated: z.boolean(),
    message: z.string(),
  })
  .strict();
export type TargetTaskResult = z.infer<typeof TargetTaskResultSchema>;
export const TargetTaskResultJsonSchema = toToolJsonSchema(TargetTaskResultSchema);

export const ExecutionTargetsOutputSchema = z
  .object({
    selectedTargetId: z.string().nullable(),
    targets: z.array(
      z
        .object({
          id: z.string(),
          displayName: z.string(),
          kind: z.string(),
          online: z.boolean(),
          available: z.boolean(),
          unavailableReason: z.string().optional(),
          capabilities: z.array(z.string()),
          selected: z.boolean(),
        })
        .strict(),
    ),
    note: z.string(),
  })
  .strict();
export const ExecutionTargetsOutputJsonSchema = toToolJsonSchema(ExecutionTargetsOutputSchema);

export const REMOTE_COMPUTER_TOOL_NAME = "RemoteComputer";

export const RemoteComputerInputSchema = z
  .object({
    targetId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .describe("Id of an SSH computer from ExecutionTargets (kind 'ssh', capability computerUse)."),
    action: z
      .enum(["screenshot", "click", "double_click", "right_click", "move", "drag", "scroll", "type", "key"])
      .describe(
        "screenshot: see the screen (do this first and after actions). click/double_click/right_click/move need x,y. drag needs x,y (from) and toX,toY. scroll needs dy (positive = down) and optional x,y. type needs text. key needs keys, e.g. ['enter'] or ['ctrl','s'].",
      ),
    x: z.number().int().min(0).max(16_384).optional().describe("Screen x in the screenshot's pixels."),
    y: z.number().int().min(0).max(16_384).optional().describe("Screen y in the screenshot's pixels."),
    toX: z.number().int().min(0).max(16_384).optional(),
    toY: z.number().int().min(0).max(16_384).optional(),
    dy: z.number().int().min(-50).max(50).optional().describe("Wheel clicks; positive scrolls down."),
    text: z.string().min(1).max(2000).optional(),
    keys: z
      .array(z.string().min(1).max(24))
      .min(1)
      .max(4)
      .optional()
      .describe("Windows key names (pyautogui): enter, tab, esc, backspace, delete, up, down, left, right, home, end, pageup, pagedown, f1-f12, ctrl, alt, shift, win, or a single letter/digit."),
  })
  .strict();
export type RemoteComputerInput = z.infer<typeof RemoteComputerInputSchema>;
export const RemoteComputerInputJsonSchema = toToolJsonSchema(RemoteComputerInputSchema);

export const RemoteComputerOutputSchema = z
  .object({
    targetId: z.string(),
    action: z.string(),
    screen: z.object({ width: z.number(), height: z.number() }).strict(),
    message: z.string(),
    image: z
      .object({
        mimeType: z.string(),
        base64: z.string(),
        width: z.number(),
        height: z.number(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RemoteComputerOutput = z.infer<typeof RemoteComputerOutputSchema>;
export const RemoteComputerOutputJsonSchema = toToolJsonSchema(RemoteComputerOutputSchema);
