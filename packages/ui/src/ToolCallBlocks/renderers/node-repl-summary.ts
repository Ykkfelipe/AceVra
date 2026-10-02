import type { NodeReplDisplayModel } from "@/lib/nodeReplToolDisplay.js";

/** Collapsed-row summary of a node_repl cell; every visible title is AceVra-owned. */
export function getNodeReplSummary(
  model: NodeReplDisplayModel,
  status: string,
  isRunning: boolean,
  formatMessage: (id: string) => string,
  computerActionLabel: string | undefined,
): { title: string; status?: string; detail?: string; note?: string } {
  const isFailed = status === "failed";
  const isDenied = status === "denied";
  const isStopped = status === "stopped";

  if (isDenied || isStopped) {
    return {
      title: formatMessage(
        isDenied ? "chat.toolCall.nodeRepl.denied" : "chat.toolCall.nodeRepl.stopped",
      ),
    };
  }

  if (model.operation === "reset") {
    return {
      title: formatMessage(
        isFailed
          ? "chat.toolCall.nodeRepl.resetFailed"
          : isRunning
            ? "chat.toolCall.nodeRepl.resetting"
            : "chat.toolCall.nodeRepl.reset",
      ),
    };
  }

  if (model.operation === "add-module-dir") {
    return {
      title: formatMessage(
        isFailed
          ? "chat.toolCall.nodeRepl.configureFailed"
          : isRunning
            ? "chat.toolCall.nodeRepl.configuring"
            : "chat.toolCall.nodeRepl.configured",
      ),
      detail: model.moduleDirectory,
    };
  }

  const fallbackTitle = formatMessage(
    isFailed
      ? "chat.toolCall.nodeRepl.failed"
      : isRunning
        ? "chat.toolCall.nodeRepl.processing"
        : "chat.toolCall.nodeRepl.finished",
  );
  // 模型自写的 `input.title` 不是产品标题：已知 Computer 操作用产品标签；其余 js cell 用通用
  // 产品标签，模型标题只在完成后作为视觉上区分的弱化备注出现（运行中尚不知 operation，
  // 一律只显示「Working」，避免英文界面里先闪出中文模型标题）。
  const note = !computerActionLabel && !isRunning ? model.userTitle : undefined;
  return {
    title: computerActionLabel ?? fallbackTitle,
    status: computerActionLabel
      ? formatMessage(
          isFailed
            ? "chat.toolCall.nodeRepl.failed"
            : isRunning
              ? "chat.toolCall.nodeRepl.processing"
              : "chat.toolCall.nodeRepl.completed",
        )
      : undefined,
    ...(note ? { note } : {}),
  };
}
