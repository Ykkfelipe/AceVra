import type { NodeReplDisplayModel } from "@/lib/nodeReplToolDisplay.js";

/** Collapsed-row summary of a node_repl cell; every visible title is AceVra-owned. */
export function getNodeReplSummary(
  model: NodeReplDisplayModel,
  status: string,
  isRunning: boolean,
  formatMessage: (id: string) => string,
  computerActionLabel: string | undefined,
): { title: string; status?: string; detail?: string } {
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
  // 模型自写的 `input.title` 不是产品 chrome，任何状态下都不出现在行上（英文界面里它常是中文）：
  // 已知 Computer 操作用产品标签，其余 js cell 用通用产品标签；完整代码仍在展开详情里。
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
  };
}
