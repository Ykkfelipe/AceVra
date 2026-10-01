import {
  RUN_ON_TARGET_TOOL_NAME,
  TARGET_TASK_TOOL_NAME,
  type SelectedExecutionTarget,
} from "@zcode/contracts";

const REQUEST_HEADER = "## My request for ZCode:";

/**
 * M2F：会话 Run-on 选中远程节点时，在本轮用户输入前加一段 provider-only 的环境块，
 * 如实说明哪些工具在节点上执行、哪些仍在本机。未选中（Automatic/本机）时原样返回。
 * `formatted` 可能已带浏览器环境块（含请求标题），此时不重复标题。
 */
export function formatExecutionTargetUserInput(
  formatted: string,
  rawInput: string,
  target: SelectedExecutionTarget | undefined,
): string {
  if (!target) return formatted;
  const name = target.displayName
    ? `"${target.displayName}" (id ${target.targetId})`
    : target.targetId;
  const lines = [
    '<execution-target-context source="run-on-selection">',
    "This block is automatically supplied by AceVra from the user's Run on selection, not part of the user's request.",
    `- Run on: ${name}, an AceVra Node.`,
    `- Run shell/process commands for this conversation with ${RUN_ON_TARGET_TOOL_NAME} on that target; Bash is disabled while it is selected. Use ${TARGET_TASK_TOOL_NAME} to wait for or stop a task you started.`,
    "- cwd must be an absolute path on that node inside a root it allows; this Mac's workspace path does not exist there and files are not synced.",
    "- Read, Write, Edit, Grep, Glob, Computer, browser tools and subagents still act on this Mac.",
    "</execution-target-context>",
    "",
  ];
  const body = formatted === rawInput ? [REQUEST_HEADER, rawInput] : [formatted];
  return [...lines, ...body].join("\n");
}
