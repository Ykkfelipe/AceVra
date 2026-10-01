import {
  RUN_ON_TARGET_TOOL_NAME,
  TARGET_TASK_TOOL_NAME,
  type SelectedExecutionTarget,
} from "@zcode/contracts";

const REQUEST_HEADER = "## My request for ZCode:";

/**
 * 会话绑定到另一台电脑（AceVra Node）时，在本轮用户输入前加一段 provider-only 的环境块，
 * 如实说明哪些工具在那台电脑上执行、哪些仍在本机。未绑定（automatic）时原样返回。
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
    '<execution-target-context source="conversation-computer">',
    "This block is automatically supplied by AceVra because this conversation is set to use another of the user's computers; it is not part of the user's request.",
    `- Computer: ${name}, an AceVra Node.`,
    `- Run shell/process commands for this conversation with ${RUN_ON_TARGET_TOOL_NAME} on that computer; Bash is disabled while this is set. Use ${TARGET_TASK_TOOL_NAME} to wait for or stop a task you started.`,
    "- cwd must be an absolute path on that node inside a root it allows; this Mac's workspace path does not exist there and files are not synced.",
    "- Read, Write, Edit, Grep, Glob, Computer, browser tools and subagents still act on this Mac.",
    "</execution-target-context>",
    "",
  ];
  const body = formatted === rawInput ? [REQUEST_HEADER, rawInput] : [formatted];
  return [...lines, ...body].join("\n");
}
