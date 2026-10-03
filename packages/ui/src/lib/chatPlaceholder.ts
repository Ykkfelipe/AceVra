type ChatPlaceholderMessageKey =
  | "chat.placeholder.newTask"
  | "chat.placeholder.newTaskMobile"
  | "chat.placeholder.followUpAsk"
  | "chat.placeholder.followUpQueue"
  | "chat.placeholder.inputPaused"
  | "chat.placeholder.assistant.new"
  | "chat.placeholder.assistant.followUp"
  | "chat.placeholder.assistant.queue";

/** default = Coding 文案；assistant = Personal Bot（Ace）个人助理文案（personal-bot spec §16.5）。 */
export type ChatPlaceholderVariant = "default" | "assistant";

export function resolveChatPlaceholderKey(options: {
  hasHistoryMessages: boolean;
  isTaskProcessing: boolean;
  compactNewTask?: boolean;
  /** snapshot.inputRouting.mode === "reject"：runtime 明确拒绝新输入，必须解释原因而不是静默锁死。 */
  inputRejected?: boolean;
  variant?: ChatPlaceholderVariant;
}): ChatPlaceholderMessageKey {
  const {
    compactNewTask = false,
    hasHistoryMessages,
    inputRejected,
    isTaskProcessing,
    variant = "default",
  } = options;

  // inputRouting.mode=reject 是 runtime 的显式拒绝（如 Codex turn 运行中），
  // 优先级最高：此时编辑器被禁用，占位符必须告诉用户为什么不能输入。
  if (inputRejected) {
    return "chat.placeholder.inputPaused";
  }

  // 个人助理不谈 task / follow-up changes：同样三态，换成对话语气。
  if (variant === "assistant") {
    if (!hasHistoryMessages) return "chat.placeholder.assistant.new";
    return isTaskProcessing
      ? "chat.placeholder.assistant.queue"
      : "chat.placeholder.assistant.followUp";
  }

  // 按语义分流：
  // 1) 无历史 -> newTask
  // 2) 有历史且空闲 -> followUpAsk
  // 3) 有历史且处理中 -> followUpQueue
  if (!hasHistoryMessages) {
    return compactNewTask ? "chat.placeholder.newTaskMobile" : "chat.placeholder.newTask";
  }

  return isTaskProcessing ? "chat.placeholder.followUpQueue" : "chat.placeholder.followUpAsk";
}
