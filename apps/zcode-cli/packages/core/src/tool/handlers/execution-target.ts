import {
  EXECUTION_TARGETS_TOOL_NAME,
  ExecutionTargetsInputJsonSchema,
  ExecutionTargetsInputSchema,
  ExecutionTargetsOutputJsonSchema,
  ExecutionTargetsOutputSchema,
  RUN_ON_TARGET_DEFAULT_WAIT_SECONDS,
  RUN_ON_TARGET_MAX_WAIT_SECONDS,
  RUN_ON_TARGET_TOOL_NAME,
  RunOnTargetInputJsonSchema,
  RunOnTargetInputSchema,
  TARGET_TASK_TOOL_NAME,
  TargetTaskInputJsonSchema,
  TargetTaskInputSchema,
  TargetTaskResultJsonSchema,
  TargetTaskResultSchema,
  type ExecutionTargetFailure,
  type ExecutionTargetPort,
  type RunOnTargetInput,
  type TargetTaskInput,
  type TargetTaskResult,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";
import { describeExecutionTargetFailure, TargetOutputTail } from "./execution-target-format.js";
import {
  MAX_MODEL_BYTES,
  callContext,
  failure,
  requirePort,
  shared,
} from "./execution-target-shared.js";
import { remoteComputerToolEntry } from "./remote-computer.js";

const POLL_INTERVAL_MS = 750;
const STOP_SETTLE_SECONDS = 10;
/** 控制面单页事件上限；满页说明还有积压，立即续读不等待。 */
const EVENTS_PAGE_LIMIT = 200;
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const RUN_TIMEOUT_MS = (RUN_ON_TARGET_MAX_WAIT_SECONDS + 30) * 1000;

const ROUTING_NOTE =
  "By default all work happens on this Mac (Bash, files, local computer use, browser). Use RunOnTarget (commands) and RemoteComputer (screen, mouse, keyboard; SSH computers only) only when the user asks you to work on one of their other computers by name (e.g. 'use my Dell'). Read/Write/Edit/Grep/Glob, local computer use, browser tools and subagents always act on this Mac.";

type TaskIds = { taskId: string; targetId: string; targetName?: string };

/**
 * 会话绑定到另一台电脑（record.executionTarget）时 Bash 必须拒绝，绝不静默在本机执行。
 * 绑定读自会话 record（实时）；桌面端每轮都声明 automatic，所以当前只有协议客户端会设置它。
 */
export function assertBashRunsOnThisMac(context: ToolExecutionContext): void {
  const selected = context.executionTargetPort?.selectedTarget();
  if (!selected) return;
  const name = selected.displayName ? `"${selected.displayName}"` : selected.targetId;
  throw failure(
    "Bash",
    `Bash is disabled in this conversation because it is set to use the computer ${name} (targetId "${selected.targetId}"), an AceVra Node. Nothing was run on this Mac. Run the command there with ${RUN_ON_TARGET_TOOL_NAME} (targetId "${selected.targetId}", cwd = an absolute path on that node). File tools still work on this Mac.`,
    context,
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * 有界等待：轮询任务直到终态或 waitSeconds 用尽；仍在运行则返回句柄（卡片继续实时显示）。
 * 每次从 sequence 0 读，输出尾部只保留最后一段，调用之间无需在 CLI 保存游标。
 * 等待期间 agent turn 被中止 → 取消节点任务（只发一次）后抛出中止原因。
 */
async function followTask(
  port: ExecutionTargetPort,
  ids: TaskIds,
  waitSeconds: number,
  toolName: string,
  context: ToolExecutionContext,
): Promise<TargetTaskResult> {
  const tail = new TargetOutputTail();
  const deadline = Date.now() + waitSeconds * 1000;
  let after = 0;
  for (;;) {
    if (context.abortSignal.aborted) {
      await port.cancelTask({ taskId: ids.taskId }, callContext(context)).catch(() => undefined);
      throw context.abortSignal.reason ?? new Error(`${toolName} was aborted`);
    }
    const read = await port.readTask({ taskId: ids.taskId, after }, callContext(context));
    if (!read.ok) throw failure(toolName, describeExecutionTargetFailure(read, ids), context);
    for (const event of read.events) {
      tail.add(event);
      after = Math.max(after, event.sequence);
    }
    const state = read.task.state;
    const backlog = read.events.length >= EVENTS_PAGE_LIMIT;
    if (!backlog && (TERMINAL_STATES.has(state) || Date.now() >= deadline)) {
      return tail.toResult(ids, read.task, TERMINAL_STATES.has(state));
    }
    if (!backlog) await sleep(POLL_INTERVAL_MS, context.abortSignal);
  }
}

const executionTargetsHandler: ToolHandler = async (input, context) => {
  ExecutionTargetsInputSchema.parse(input);
  const port = requirePort(context, EXECUTION_TARGETS_TOOL_NAME);
  const listed = await port.listTargets(callContext(context));
  if (!listed.ok) {
    throw failure(EXECUTION_TARGETS_TOOL_NAME, describeExecutionTargetFailure(listed), context);
  }
  const selected = port.selectedTarget();
  return {
    selectedTargetId: selected?.targetId ?? null,
    targets: listed.targets.map((target) => ({
      id: target.id,
      displayName: target.displayName,
      kind: target.isThisDevice ? "thisDevice" : target.type,
      online: target.online,
      available: target.available,
      ...(target.unavailableReason ? { unavailableReason: target.unavailableReason } : {}),
      capabilities: target.capabilities,
      selected: selected ? selected.targetId === target.id : target.isThisDevice,
    })),
    note: ROUTING_NOTE,
  };
};

const runOnTargetHandler: ToolHandler = async (input, context) => {
  const parsed = RunOnTargetInputSchema.parse(input) as RunOnTargetInput;
  const port = requirePort(context, RUN_ON_TARGET_TOOL_NAME);
  const started = await port.startProcess(
    {
      targetId: parsed.targetId,
      process: {
        executable: parsed.executable,
        ...(parsed.args ? { args: parsed.args } : {}),
        cwd: parsed.cwd,
        ...(parsed.env ? { env: parsed.env } : {}),
        ...(parsed.timeoutSeconds ? { timeoutMs: parsed.timeoutSeconds * 1000 } : {}),
      },
    },
    callContext(context),
  );
  const selected = port.selectedTarget();
  const targetName = selected?.targetId === parsed.targetId ? selected.displayName : undefined;
  if (!started.ok) {
    throw failure(
      RUN_ON_TARGET_TOOL_NAME,
      describeExecutionTargetFailure(started, { targetId: parsed.targetId, targetName }),
      context,
    );
  }
  return followTask(
    port,
    { taskId: started.taskId, targetId: started.targetId, ...(targetName ? { targetName } : {}) },
    parsed.waitSeconds ?? RUN_ON_TARGET_DEFAULT_WAIT_SECONDS,
    RUN_ON_TARGET_TOOL_NAME,
    context,
  );
};

const targetTaskHandler: ToolHandler = async (input, context) => {
  const parsed = TargetTaskInputSchema.parse(input) as TargetTaskInput;
  const port = requirePort(context, TARGET_TASK_TOOL_NAME);
  let targetId = "";
  if (parsed.action === "stop") {
    const cancelled = await port.cancelTask({ taskId: parsed.taskId }, callContext(context));
    if (!cancelled.ok) {
      throw failure(TARGET_TASK_TOOL_NAME, describeFailureFor(cancelled, parsed.taskId), context);
    }
    targetId = cancelled.task.targetId;
  }
  const waitSeconds =
    parsed.action === "stop"
      ? Math.min(parsed.waitSeconds ?? STOP_SETTLE_SECONDS, STOP_SETTLE_SECONDS * 3)
      : (parsed.waitSeconds ?? RUN_ON_TARGET_DEFAULT_WAIT_SECONDS);
  return followTask(
    port,
    { taskId: parsed.taskId, targetId },
    waitSeconds,
    TARGET_TASK_TOOL_NAME,
    context,
  );
};

/** Flat tool input → the wire action (strict per kind; missing fields are a model error, not a guess). */
function describeFailureFor(result: ExecutionTargetFailure, taskId: string): string {
  return describeExecutionTargetFailure(result, { taskId, targetId: "" });
}

export const executionTargetsToolEntry: ToolEntry = {
  ...shared,
  capability: "List the user's computers (this Mac and connected AceVra Nodes)",
  metadata: {
    name: EXECUTION_TARGETS_TOOL_NAME,
    description: [
      "Lists the user's computers: this Mac and their connected computers (AceVra Nodes) with id, user-given name, online/available and capabilities.",
      "Use it to resolve requests like 'use my Dell' or 'run this on <computer name>' to a targetId (match displayName; never guess ids or hardcode names).",
      ROUTING_NOTE,
    ].join("\n"),
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30_000,
    maxOutputBytes: MAX_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: executionTargetsHandler,
  inputSchema: ExecutionTargetsInputJsonSchema,
  outputSchema: ExecutionTargetsOutputJsonSchema,
  runtimeInputSchema: ExecutionTargetsInputSchema,
  runtimeOutputSchema: ExecutionTargetsOutputSchema,
  permission: {
    permission: "executionTarget.list",
    reason: "ExecutionTargets only reads the user's device list",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  timeout: { defaultMs: 30_000, maxMs: 30_000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ExecutionTargets was cancelled",
  },
};

export const runOnTargetToolEntry: ToolEntry = {
  ...shared,
  capability: "Run a process on one of the user's connected computers (AceVra Node)",
  metadata: {
    name: RUN_ON_TARGET_TOOL_NAME,
    description: [
      "Runs one process on another of the user's computers (an AceVra Node). The user sees it as a live card with a Stop button.",
      "- Use it only when the user asked you to work on that computer. targetId comes from ExecutionTargets. This Mac is not a valid target: use Bash for local commands.",
      "- No shell: give executable + args. For shell syntax use executable 'bash' with args ['-lc', '<script>'].",
      "- cwd is REQUIRED and must be an absolute path on the node inside a root the node allows (acevra-node --allow-root). Files are not synced from this Mac. If the node rejects the cwd ('rejected (policy)'), ask the user which directory to use.",
      "- SSH computers (kind 'ssh') are Windows machines reached over SSH: the process runs in PowerShell there; cwd is a Windows path such as 'C:\\Users\\<user>'; for shell syntax use executable 'powershell' with args ['-NoProfile', '-Command', '<script>'].",
      `- Waits up to waitSeconds (default ${RUN_ON_TARGET_DEFAULT_WAIT_SECONDS}s, max ${RUN_ON_TARGET_MAX_WAIT_SECONDS}s). Returns exit code and the output tail when finished; otherwise a taskId that keeps running — use ${TARGET_TASK_TOOL_NAME} to wait more or stop it.`,
      "- Offline, revoked or unknown targets fail; nothing is ever run on this Mac instead.",
    ].join("\n"),
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: RUN_TIMEOUT_MS,
    maxOutputBytes: MAX_MODEL_BYTES,
    sideEffectScope: "system",
    riskLevel: "high",
    needsApproval: true,
  },
  handler: runOnTargetHandler,
  inputSchema: RunOnTargetInputJsonSchema,
  outputSchema: TargetTaskResultJsonSchema,
  runtimeInputSchema: RunOnTargetInputSchema,
  runtimeOutputSchema: TargetTaskResultSchema,
  permission: {
    permission: "executionTarget.run",
    reason: "RunOnTarget runs a process on another device, which may change files or state there",
    riskLevel: "high",
    sideEffectScope: "system",
    needsApproval: true,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  timeout: { defaultMs: RUN_TIMEOUT_MS, maxMs: RUN_TIMEOUT_MS, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "RunOnTarget was cancelled and the task on the node was asked to stop",
  },
};

export const targetTaskToolEntry: ToolEntry = {
  ...shared,
  capability: "Wait for or stop a task this conversation started on an AceVra Node",
  metadata: {
    name: TARGET_TASK_TOOL_NAME,
    description: [
      `Waits for (action 'wait') or stops (action 'stop') a task that ${RUN_ON_TARGET_TOOL_NAME} started in this conversation, and returns its state, exit code and output tail.`,
      "- 'running_unknown' means the node lost its connection while running; the process may still be running and AceVra reconciles when it reconnects.",
      "- Only tasks started by this conversation are accepted.",
    ].join("\n"),
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: RUN_TIMEOUT_MS,
    maxOutputBytes: MAX_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: targetTaskHandler,
  inputSchema: TargetTaskInputJsonSchema,
  outputSchema: TargetTaskResultJsonSchema,
  runtimeInputSchema: TargetTaskInputSchema,
  runtimeOutputSchema: TargetTaskResultSchema,
  permission: {
    permission: "executionTarget.task",
    reason: "TargetTask reads or stops a task this conversation started",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  timeout: { defaultMs: RUN_TIMEOUT_MS, maxMs: RUN_TIMEOUT_MS, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "TargetTask was cancelled",
  },
};

export const executionTargetToolEntries: readonly ToolEntry[] = [
  executionTargetsToolEntry,
  runOnTargetToolEntry,
  targetTaskToolEntry,
  remoteComputerToolEntry,
];
