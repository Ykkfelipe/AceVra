type ChatPlaceholderMessageKey =
  | "chat.placeholder.newTask"
  | "chat.placeholder.newTaskMobile"
  | "chat.placeholder.followUpAsk"
  | "chat.placeholder.followUpQueue"
  | "chat.placeholder.inputPaused";

export function resolveChatPlaceholderKey(options: {
  hasHistoryMessages: boolean;
  isTaskProcessing: boolean;
  compactNewTask?: boolean;
  /** snapshot.inputRouting.mode === "reject"：runtime 明确拒绝新输入，必须解释原因而不是静默锁死。 */
  inputRejected?: boolean;
}): ChatPlaceholderMessageKey {
  const { compactNewTask = false, hasHistoryMessages, inputRejected, isTaskProcessing } = options;

  // inputRouting.mode=reject 是 runtime 的显式拒绝（如 Codex turn 运行中），
  // 优先级最高：此时编辑器被禁用，占位符必须告诉用户为什么不能输入。
  if (inputRejected) {
    return "chat.placeholder.inputPaused";
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
